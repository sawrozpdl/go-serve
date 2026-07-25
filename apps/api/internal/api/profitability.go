package api

import (
	"math"
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
	MenuCategoryID *uuid.UUID `json:"menu_category_id,omitempty"`
	Name           string     `json:"name"`
	// NetRevenueCents is this category's share of NET REVENUE (billed sales minus
	// VAT, net of discounts, service charge included) — see money.go. Each
	// order's discount / service charge / VAT is allocated across its lines in
	// proportion to line value, with largest-remainder rounding, so the category
	// rows sum EXACTLY to the period's net revenue. This is the basis for profit.
	NetRevenueCents int64 `json:"net_revenue_cents"`
	// ItemSalesCents is menu price × quantity for this category, before discounts
	// and (in inclusive-VAT mode) with VAT still inside. Useful for "what sells";
	// NOT a revenue figure, and never used for profit. Always label it as menu
	// item sales in the UI, never as sales or revenue.
	ItemSalesCents int64 `json:"item_sales_cents"`
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
	Range                string      `json:"range"`
	From                 time.Time   `json:"from"`
	To                   time.Time   `json:"to"`
	Timezone             string      `json:"timezone"`
	Categories           []ProfitRow `json:"categories"`
	Totals               ProfitRow   `json:"totals"`
	UnallocatedCogsCents int64       `json:"unallocated_cogs_cents"`
	// TotalExpensesCents is every non-deleted expense paid in the period (incl.
	// salary, rent, and unallocated overhead). It deliberately does NOT subtract
	// the per-unit direct COGS (that figure powers the category gross-margin
	// view); inventory purchases are already counted once here as expenses, so
	// adding direct COGS too would double-count them.
	TotalExpensesCents int64 `json:"total_expenses_cents"`
	// TransferFeesCents is bank/wallet charges paid on account transfers in the
	// period. Real money the cafe lost, and it correctly reduces the account
	// balances — but it lives in account_transfers, not expenses, so it used to
	// be invisible to profit. Counted on the cost side here.
	TransferFeesCents int64 `json:"transfer_fees_cents"`
	// NetProfitCents is the cash-basis bottom line:
	//   net revenue − all expenses − transfer fees.
	// Net revenue (not billed sales) because VAT is a liability the cafe collects
	// on the government's behalf and discounts are money never earned.
	NetProfitCents int64 `json:"net_profit_cents"`
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
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "profitability.get",
		"range", rng.Label, "from", rng.From, "to", rng.To)
	tx := appctx.Tx(r.Context())

	// Net revenue is an ORDER-level figure (total − VAT, discounts already
	// deducted), so attributing it to categories means allocating each order's
	// discount / service charge / VAT across the categories its lines belong to.
	// We do that in proportion to line value, then hand the leftover paisa to the
	// largest remainders — so the category rows sum to the period's net revenue
	// EXACTLY, even with half portions (qty is numeric) and odd VAT rates.
	//
	// Doing it in SQL keeps this one round trip regardless of order volume.
	rows, err := tx.Query(r.Context(), `
		WITH lines AS (
		  -- One row per (order, category): the category's slice of that order.
		  SELECT oi.order_id, mi.category_id AS cat_id,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS line_cents,
		         SUM(oi.qty * oi.unit_cost_cents)::bigint  AS direct_cogs
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
		    AND oi.voided_at IS NULL
		  GROUP BY oi.order_id, mi.category_id
		),
		weighted AS (
		  SELECT l.*,
		         -- ::bigint is load-bearing: SUM(bigint) returns NUMERIC in
		         -- Postgres, and a numeric denominator turns the integer division
		         -- below into fractional division — every share then rounds up on
		         -- the way out and the category rows over-sum the order total.
		         SUM(l.line_cents) OVER (PARTITION BY l.order_id)::bigint AS order_lines,
		         (o.total_cents - o.tax_cents)                    AS order_net
		  FROM lines l
		  JOIN orders o ON o.id = l.order_id
		),
		shares AS (
		  SELECT w.*,
		         CASE WHEN w.order_lines > 0
		              THEN div(w.line_cents * w.order_net, w.order_lines)::bigint
		              ELSE 0::bigint END AS base_share,
		         CASE WHEN w.order_lines > 0
		              THEN mod(w.line_cents * w.order_net, w.order_lines)::bigint
		              ELSE 0::bigint END AS remainder
		  FROM weighted w
		),
		allocated AS (
		  SELECT s.*,
		         (s.order_net - SUM(s.base_share) OVER (PARTITION BY s.order_id))::bigint AS leftover,
		         ROW_NUMBER() OVER (PARTITION BY s.order_id
		                            ORDER BY s.remainder DESC, s.cat_id) AS rn
		  FROM shares s
		),
		sales AS (
		  SELECT cat_id,
		         SUM(base_share + CASE WHEN rn <= leftover THEN 1 ELSE 0 END)::bigint AS net_rev,
		         SUM(line_cents)::bigint  AS item_sales,
		         SUM(direct_cogs)::bigint AS direct_cogs
		  FROM allocated
		  GROUP BY cat_id
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
		       COALESCE(s.net_rev, 0)::bigint,
		       COALESCE(s.item_sales, 0)::bigint,
		       COALESCE(s.direct_cogs, 0)::bigint,
		       COALESCE(a.allocated, 0)::bigint
		FROM menu_categories mc
		LEFT JOIN sales s ON s.cat_id = mc.id
		LEFT JOIN alloc a ON a.cat_id = mc.id
		-- Live categories always show (even at zero, so their allocated costs are
		-- visible). A soft-deleted category still shows when it carries history in
		-- this period — dropping it would quietly remove real revenue from the
		-- totals and from net profit.
		WHERE mc.deleted_at IS NULL
		   OR s.cat_id IS NOT NULL
		   OR a.cat_id IS NOT NULL
		ORDER BY COALESCE(s.net_rev, 0) DESC, lower(mc.name)
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
		if err := rows.Scan(&id, &row.Name, &row.NetRevenueCents, &row.ItemSalesCents,
			&row.DirectCogsCents, &row.AllocatedCogsCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		row.MenuCategoryID = &id
		row.CogsCents = row.DirectCogsCents + row.AllocatedCogsCents
		row.GrossProfitCents = row.NetRevenueCents - row.CogsCents
		row.MarginPct = marginPct(row.NetRevenueCents, row.GrossProfitCents)
		report.Categories = append(report.Categories, row)
		report.Totals.NetRevenueCents += row.NetRevenueCents
		report.Totals.ItemSalesCents += row.ItemSalesCents
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

	// Total expenses for the period — every non-deleted expense, allocated or
	// not (salary, rent, supplies…). Drives the cash-basis Net Profit line.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(e.amount_cents), 0)::bigint
		FROM expenses e
		WHERE e.deleted_at IS NULL
		  AND e.paid_at >= $1 AND e.paid_at < $2
	`, rng.From, rng.To).Scan(&report.TotalExpensesCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Transfer fees are money the cafe paid to move its own money (bank/wallet
	// charges). They reduce the account balances correctly but live in
	// account_transfers, not expenses — so without this term net profit
	// overstated by every fee ever paid while the balance sheet did not.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(fee_cents), 0)::bigint
		FROM account_transfers
		WHERE transferred_at >= $1 AND transferred_at < $2
	`, rng.From, rng.To).Scan(&report.TransferFeesCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	report.Totals.Name = "All categories"
	report.Totals.GrossProfitCents = report.Totals.NetRevenueCents - report.Totals.CogsCents
	report.Totals.MarginPct = marginPct(report.Totals.NetRevenueCents, report.Totals.GrossProfitCents)
	report.NetProfitCents = report.Totals.NetRevenueCents -
		report.TotalExpensesCents - report.TransferFeesCents

	writeJSON(w, http.StatusOK, report)
}

// =========================================================================
// /v1/reports/profitability/{categoryId}?range=...&from=&to=
// Drill-down: contributing expenses + contributing items for the period.
// =========================================================================

type DrilldownExpense struct {
	ExpenseID          uuid.UUID `json:"expense_id"`
	PaidAt             time.Time `json:"paid_at"`
	Vendor             string    `json:"vendor"`
	ExpenseAmountCents int64     `json:"expense_amount_cents"`
	SharePct           string    `json:"share_pct"`
	AllocatedCents     int64     `json:"allocated_cents"`
	Notes              string    `json:"notes"`
}

type DrilldownItem struct {
	MenuItemID   uuid.UUID `json:"menu_item_id"`
	Name         string    `json:"name"`
	Qty          int       `json:"qty"`
	RevenueCents int64     `json:"revenue_cents"`
	CostCents    int64     `json:"cost_cents"`
}

type ProfitDrilldown struct {
	Range    string             `json:"range"`
	From     time.Time          `json:"from"`
	To       time.Time          `json:"to"`
	Category ProfitRow          `json:"category"`
	Expenses []DrilldownExpense `json:"expenses"`
	Items    []DrilldownItem    `json:"items"`
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
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "profitability.drilldown",
		"category_id", id, "range", rng.Label, "from", rng.From, "to", rng.To)
	tx := appctx.Tx(r.Context())

	out := ProfitDrilldown{
		Range:    rng.Label,
		From:     rng.From,
		To:       rng.To,
		Expenses: []DrilldownExpense{},
		Items:    []DrilldownItem{},
	}
	out.Category.MenuCategoryID = &id

	// Category name + net revenue + menu item sales + (direct + allocated) cogs.
	// The net-revenue allocation repeats the parent report's arithmetic exactly —
	// same shares, same largest-remainder tie-break — so the drill-down row equals
	// the row the user clicked. Filtering to one category AFTER allocating is what
	// makes that true: the shares depend on the whole order.
	if err := tx.QueryRow(r.Context(), `
		WITH lines AS (
		  SELECT oi.order_id, mi.category_id AS cat_id,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS line_cents,
		         SUM(oi.qty * oi.unit_cost_cents)::bigint  AS direct_cogs
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $2 AND o.closed_at < $3
		    AND oi.voided_at IS NULL
		  GROUP BY oi.order_id, mi.category_id
		),
		weighted AS (
		  SELECT l.*,
		         -- ::bigint is load-bearing: SUM(bigint) returns NUMERIC in
		         -- Postgres, and a numeric denominator turns the integer division
		         -- below into fractional division — every share then rounds up on
		         -- the way out and the category rows over-sum the order total.
		         SUM(l.line_cents) OVER (PARTITION BY l.order_id)::bigint AS order_lines,
		         (o.total_cents - o.tax_cents)                    AS order_net
		  FROM lines l JOIN orders o ON o.id = l.order_id
		),
		shares AS (
		  SELECT w.*,
		         CASE WHEN w.order_lines > 0
		              THEN div(w.line_cents * w.order_net, w.order_lines)::bigint
		              ELSE 0::bigint END AS base_share,
		         CASE WHEN w.order_lines > 0
		              THEN mod(w.line_cents * w.order_net, w.order_lines)::bigint
		              ELSE 0::bigint END AS remainder
		  FROM weighted w
		),
		allocated AS (
		  SELECT s.*,
		         (s.order_net - SUM(s.base_share) OVER (PARTITION BY s.order_id))::bigint AS leftover,
		         ROW_NUMBER() OVER (PARTITION BY s.order_id
		                            ORDER BY s.remainder DESC, s.cat_id) AS rn
		  FROM shares s
		),
		s AS (
		  SELECT COALESCE(SUM(base_share + CASE WHEN rn <= leftover THEN 1 ELSE 0 END), 0)::bigint AS net_rev,
		         COALESCE(SUM(line_cents), 0)::bigint  AS item_sales,
		         COALESCE(SUM(direct_cogs), 0)::bigint AS direct
		  FROM allocated WHERE cat_id = $1
		),
		a AS (
		  SELECT COALESCE(SUM(al.amount_cents), 0)::bigint AS allocated
		  FROM expense_allocations al
		  JOIN expenses e ON e.id = al.expense_id
		  WHERE al.menu_category_id = $1
		    AND e.deleted_at IS NULL
		    AND e.paid_at >= $2 AND e.paid_at < $3
		)
		SELECT mc.name, s.net_rev, s.item_sales, s.direct, a.allocated
		FROM menu_categories mc, s, a
		WHERE mc.id = $1
	`, id, rng.From, rng.To).Scan(&out.Category.Name, &out.Category.NetRevenueCents,
		&out.Category.ItemSalesCents,
		&out.Category.DirectCogsCents, &out.Category.AllocatedCogsCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out.Category.CogsCents = out.Category.DirectCogsCents + out.Category.AllocatedCogsCents
	out.Category.GrossProfitCents = out.Category.NetRevenueCents - out.Category.CogsCents
	out.Category.MarginPct = marginPct(out.Category.NetRevenueCents, out.Category.GrossProfitCents)

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
	// Round half away from zero to 2dp. The old `int64(pct*100+0.5)` truncated
	// toward zero, so a negative margin was biased upward (−12.345 read as
	// −12.34, i.e. better than reality) — exactly the wrong direction for a
	// figure someone acts on.
	pct = math.Round(pct*100) / 100
	return &pct
}
