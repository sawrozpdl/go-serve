package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// /v1/reports/profitability?range=...&from=&to=
//
// Returns per menu_category: revenue, COGS (sum of expense_allocations),
// gross profit, margin %. Plus a totals row and an "unallocated" row that
// aggregates expense rows with no allocations (informational only — these
// don't reduce any category's gross profit).
// =========================================================================

type ProfitRow struct {
	MenuCategoryID    *uuid.UUID `json:"menu_category_id,omitempty"`
	Name              string     `json:"name"`
	RevenueCents      int64      `json:"revenue_cents"`
	// CogsCents is the total cost of goods sold for the row =
	// DirectCogsCents (per-item cost × qty captured at sale) +
	// AllocatedCogsCents (expense_allocations roll-up).
	CogsCents          int64    `json:"cogs_cents"`
	DirectCogsCents    int64    `json:"direct_cogs_cents"`
	AllocatedCogsCents int64    `json:"allocated_cogs_cents"`
	GrossProfitCents   int64    `json:"gross_profit_cents"`
	MarginPct          *float64 `json:"margin_pct,omitempty"`
}

type ProfitReport struct {
	Range      string      `json:"range"`
	From       time.Time   `json:"from"`
	To         time.Time   `json:"to"`
	Timezone   string      `json:"timezone"`
	Categories []ProfitRow `json:"categories"`
	Totals     ProfitRow   `json:"totals"`
	UnallocatedCogsCents int64 `json:"unallocated_cogs_cents"`
}

func GetProfitability(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), `
		WITH sales AS (
		  SELECT mi.category_id AS cat_id,
		         COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint AS rev,
		         COALESCE(SUM(oi.qty * oi.unit_cost_cents),  0)::bigint AS direct_cogs
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
		    AND oi.voided_at IS NULL
		  GROUP BY mi.category_id
		),
		alloc AS (
		  SELECT a.menu_category_id AS cat_id,
		         COALESCE(SUM(a.amount_cents), 0)::bigint AS allocated
		  FROM expense_allocations a
		  JOIN expenses e ON e.id = a.expense_id
		  WHERE e.deleted_at IS NULL AND e.paid_at >= $1 AND e.paid_at < $2
		  GROUP BY a.menu_category_id
		)
		SELECT mc.id, mc.name,
		       COALESCE(s.rev, 0)::bigint,
		       COALESCE(s.direct_cogs, 0)::bigint,
		       COALESCE(a.allocated, 0)::bigint
		FROM menu_categories mc
		LEFT JOIN sales s ON s.cat_id = mc.id
		LEFT JOIN alloc a ON a.cat_id = mc.id
		WHERE mc.deleted_at IS NULL
		ORDER BY COALESCE(s.rev, 0) DESC, lower(mc.name)
	`, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	report := ProfitReport{
		Range:      rng.Label,
		From:       rng.From,
		To:         rng.To,
		Timezone:   rng.TZ,
		Categories: []ProfitRow{},
	}
	for rows.Next() {
		var row ProfitRow
		var id uuid.UUID
		if err := rows.Scan(&id, &row.Name, &row.RevenueCents, &row.DirectCogsCents, &row.AllocatedCogsCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		row.MenuCategoryID = &id
		row.CogsCents = row.DirectCogsCents + row.AllocatedCogsCents
		row.GrossProfitCents = row.RevenueCents - row.CogsCents
		row.MarginPct = marginPct(row.RevenueCents, row.GrossProfitCents)
		report.Categories = append(report.Categories, row)
		report.Totals.RevenueCents += row.RevenueCents
		report.Totals.DirectCogsCents += row.DirectCogsCents
		report.Totals.AllocatedCogsCents += row.AllocatedCogsCents
		report.Totals.CogsCents += row.CogsCents
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Compute unallocated COGS: expenses with no expense_allocations rows.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(e.amount_cents), 0)::bigint
		FROM expenses e
		WHERE e.deleted_at IS NULL
		  AND e.paid_at >= $1 AND e.paid_at < $2
		  AND NOT EXISTS (SELECT 1 FROM expense_allocations a WHERE a.expense_id = e.id)
	`, rng.From, rng.To).Scan(&report.UnallocatedCogsCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	report.Totals.Name = "All categories"
	report.Totals.GrossProfitCents = report.Totals.RevenueCents - report.Totals.CogsCents
	report.Totals.MarginPct = marginPct(report.Totals.RevenueCents, report.Totals.GrossProfitCents)

	writeJSON(w, http.StatusOK, report)
}

// =========================================================================
// /v1/reports/profitability/{categoryId}?range=...&from=&to=
// Drill-down: contributing expenses + contributing items for the period.
// =========================================================================

type DrilldownExpense struct {
	ExpenseID         uuid.UUID `json:"expense_id"`
	PaidAt            time.Time `json:"paid_at"`
	Vendor            string    `json:"vendor"`
	ExpenseAmountCents int64    `json:"expense_amount_cents"`
	SharePct          string    `json:"share_pct"`
	AllocatedCents    int64     `json:"allocated_cents"`
	Notes             string    `json:"notes"`
}

type DrilldownItem struct {
	MenuItemID   uuid.UUID `json:"menu_item_id"`
	Name         string    `json:"name"`
	Qty          int       `json:"qty"`
	RevenueCents int64     `json:"revenue_cents"`
	CostCents    int64     `json:"cost_cents"`
}

type ProfitDrilldown struct {
	Range        string             `json:"range"`
	From         time.Time          `json:"from"`
	To           time.Time          `json:"to"`
	Category     ProfitRow          `json:"category"`
	Expenses     []DrilldownExpense `json:"expenses"`
	Items        []DrilldownItem    `json:"items"`
}

func GetProfitabilityDrilldown(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "categoryId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid category id")
		return
	}
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())

	out := ProfitDrilldown{
		Range:    rng.Label,
		From:     rng.From,
		To:       rng.To,
		Expenses: []DrilldownExpense{},
		Items:    []DrilldownItem{},
	}
	out.Category.MenuCategoryID = &id

	// Category name + revenue + (direct + allocated) cogs.
	if err := tx.QueryRow(r.Context(), `
		WITH s AS (
		  SELECT COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint AS rev,
		         COALESCE(SUM(oi.qty * oi.unit_cost_cents),  0)::bigint AS direct
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  WHERE mi.category_id = $1
		    AND o.status = 'closed'
		    AND o.closed_at >= $2 AND o.closed_at < $3
		    AND oi.voided_at IS NULL
		),
		a AS (
		  SELECT COALESCE(SUM(al.amount_cents), 0)::bigint AS allocated
		  FROM expense_allocations al
		  JOIN expenses e ON e.id = al.expense_id
		  WHERE al.menu_category_id = $1
		    AND e.deleted_at IS NULL
		    AND e.paid_at >= $2 AND e.paid_at < $3
		)
		SELECT mc.name, s.rev, s.direct, a.allocated
		FROM menu_categories mc, s, a
		WHERE mc.id = $1
	`, id, rng.From, rng.To).Scan(&out.Category.Name, &out.Category.RevenueCents,
		&out.Category.DirectCogsCents, &out.Category.AllocatedCogsCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out.Category.CogsCents = out.Category.DirectCogsCents + out.Category.AllocatedCogsCents
	out.Category.GrossProfitCents = out.Category.RevenueCents - out.Category.CogsCents
	out.Category.MarginPct = marginPct(out.Category.RevenueCents, out.Category.GrossProfitCents)

	// Contributing expenses.
	rows, err := tx.Query(r.Context(), `
		SELECT e.id, e.paid_at, e.vendor, e.amount_cents, a.share_pct::text, a.amount_cents, e.notes
		FROM expense_allocations a
		JOIN expenses e ON e.id = a.expense_id
		WHERE a.menu_category_id = $1
		  AND e.deleted_at IS NULL
		  AND e.paid_at >= $2 AND e.paid_at < $3
		ORDER BY e.paid_at DESC
	`, id, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for rows.Next() {
		var e DrilldownExpense
		if err := rows.Scan(&e.ExpenseID, &e.PaidAt, &e.Vendor, &e.ExpenseAmountCents,
			&e.SharePct, &e.AllocatedCents, &e.Notes); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out.Expenses = append(out.Expenses, e)
	}
	rows.Close()

	// Contributing items.
	rows, err = tx.Query(r.Context(), `
		SELECT mi.id, mi.name,
		       SUM(oi.qty)::int,
		       SUM(oi.qty * oi.unit_price_cents)::bigint,
		       SUM(oi.qty * oi.unit_cost_cents)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE mi.category_id = $1
		  AND o.status = 'closed'
		  AND o.closed_at >= $2 AND o.closed_at < $3
		  AND oi.voided_at IS NULL
		GROUP BY mi.id, mi.name
		ORDER BY SUM(oi.qty * oi.unit_price_cents) DESC
	`, id, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	for rows.Next() {
		var it DrilldownItem
		if err := rows.Scan(&it.MenuItemID, &it.Name, &it.Qty, &it.RevenueCents, &it.CostCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out.Items = append(out.Items, it)
	}

	writeJSON(w, http.StatusOK, out)
}

// marginPct returns gross_profit/revenue as a percentage, rounded to 2dp.
// Returns nil when revenue is 0 (margin undefined).
func marginPct(revenue, gross int64) *float64 {
	if revenue <= 0 {
		return nil
	}
	pct := float64(gross) * 100.0 / float64(revenue)
	pct = float64(int64(pct*100+0.5)) / 100
	return &pct
}
