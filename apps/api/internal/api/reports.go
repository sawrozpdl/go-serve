package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// Range parsing
//
// Supported ?range= values: today | yesterday | 7d | 30d | mtd | ytd
// All boundaries are computed in the tenant timezone, then converted to
// UTC for comparison against timestamptz columns.
// =========================================================================

type rangeWindow struct {
	From  time.Time
	To    time.Time
	Label string
	Days  int // number of day-buckets in the window (used for series)
	TZ    string
}

// resolveRangeFull parses a range with optional explicit from/to overrides
// (used when range=custom or callers want to constrain a preset further).
//
// Presets: today | yesterday | 7d | 30d | thisweek | lastweek | mtd |
//
//	lastmonth | ytd | all | custom
func resolveRangeFull(ctx context.Context, raw, fromStr, toStr string) (rangeWindow, error) {
	t, _ := appctx.TenantFromContext(ctx)
	tz := t.Timezone
	if tz == "" {
		tz = "Asia/Kathmandu"
	}

	tx := appctx.Tx(ctx)
	var nowLocal time.Time
	if err := tx.QueryRow(ctx, `SELECT (now() AT TIME ZONE $1)::timestamp`, tz).Scan(&nowLocal); err != nil {
		return rangeWindow{}, err
	}

	day := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, time.UTC)
	endOfDay := day.Add(24 * time.Hour)

	var from, to time.Time
	var days int
	label := strings.TrimSpace(strings.ToLower(raw))
	if label == "" {
		if fromStr != "" || toStr != "" {
			label = "custom"
		} else {
			label = "today"
		}
	}
	switch label {
	case "today":
		from, to, days = day, endOfDay, 1
	case "yesterday":
		from, to, days = day.AddDate(0, 0, -1), day, 1
	case "dby":
		// Day before yesterday — same shape as yesterday, just shifted one
		// more day back. Surfaces the most recent few service days as
		// quick-pick chips on the profitability page.
		from, to, days = day.AddDate(0, 0, -2), day.AddDate(0, 0, -1), 1
	case "7d":
		from, to, days = day.AddDate(0, 0, -6), endOfDay, 7
	case "30d":
		from, to, days = day.AddDate(0, 0, -29), endOfDay, 30
	case "thisweek":
		// Week starts Monday in Nepal calendar conventions; matches ISO.
		offset := int(day.Weekday()) - 1
		if offset < 0 {
			offset = 6 // Sunday → 6 days back
		}
		from = day.AddDate(0, 0, -offset)
		to, days = endOfDay, 7
	case "lastweek":
		offset := int(day.Weekday()) - 1
		if offset < 0 {
			offset = 6
		}
		startThisWeek := day.AddDate(0, 0, -offset)
		from = startThisWeek.AddDate(0, 0, -7)
		to, days = startThisWeek, 7
	case "mtd":
		from, to = time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC), endOfDay
		days = int(to.Sub(from).Hours() / 24)
	case "lastmonth":
		startThisMonth := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC)
		startLastMonth := startThisMonth.AddDate(0, -1, 0)
		from, to = startLastMonth, startThisMonth
		days = int(to.Sub(from).Hours() / 24)
	case "ytd":
		from, to = time.Date(day.Year(), 1, 1, 0, 0, 0, 0, time.UTC), endOfDay
		days = int(to.Sub(from).Hours() / 24)
	case "all":
		from = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
		to, days = endOfDay, int(to.Sub(from).Hours()/24)+1
	case "custom":
		if fromStr == "" || toStr == "" {
			return rangeWindow{}, errBadRange
		}
		fp, fDateOnly, e1 := parseDateOrTime(fromStr)
		tp, tDateOnly, e2 := parseDateOrTime(toStr)
		if e1 != nil || e2 != nil {
			return rangeWindow{}, errBadRange
		}
		// Date-only inputs (YYYY-MM-DD, the common case from the UI) name whole
		// tenant-local days. Anchor them at local midnight, and make the `to`
		// day inclusive by advancing to the start of the following day so the
		// `closed_at < to` comparison still captures the whole last day. This is
		// also what makes a single-day range (from === to) valid — it resolves
		// to [day 00:00, next-day 00:00) rather than a zero-width window.
		loc, err := time.LoadLocation(tz)
		if err != nil {
			loc = time.UTC
		}
		if fDateOnly {
			fp = time.Date(fp.Year(), fp.Month(), fp.Day(), 0, 0, 0, 0, loc).UTC()
		}
		if tDateOnly {
			tp = time.Date(tp.Year(), tp.Month(), tp.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1).UTC()
		}
		if !tp.After(fp) {
			return rangeWindow{}, errBadRange
		}
		from, to = fp, tp
		days = int(to.Sub(from).Hours()/24 + 0.5)
	default:
		from, to, days = day, endOfDay, 1
		label = "today"
	}

	// Convert local-day boundaries to absolute UTC for timestamptz comparison.
	if label != "custom" {
		loc, err := time.LoadLocation(tz)
		if err == nil {
			from = time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc).UTC()
			to = time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc).UTC()
		}
	}

	if days < 1 {
		days = 1
	}
	return rangeWindow{From: from, To: to, Label: label, Days: days, TZ: tz}, nil
}

var errBadRange = errBadRangeT{}

type errBadRangeT struct{}

func (errBadRangeT) Error() string { return "invalid range/from/to" }

// parseDateOrTime parses an RFC3339 timestamp or a bare YYYY-MM-DD date. The
// bool return reports whether the input was date-only, so callers can decide to
// expand it into a full tenant-local day window.
func parseDateOrTime(s string) (time.Time, bool, error) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, false, nil
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, true, nil
	}
	return time.Time{}, false, errBadRange
}

// =========================================================================
// /v1/reports/dashboard
// =========================================================================

type DashboardKPIs struct {
	SalesCents int64 `json:"sales_cents"`
	// TabCents is the slice of SalesCents settled to house tabs — money that
	// is owed, not collected. Surfaced so "Sales" isn't mistaken for cash in
	// hand. Always <= SalesCents.
	TabCents       int64 `json:"tab_cents"`
	TaxCents       int64 `json:"tax_cents"`
	ServiceCents   int64 `json:"service_cents"`
	OrderCount     int   `json:"order_count"`
	AvgTicketCents int64 `json:"avg_ticket_cents"`
	ExpensesCents  int64 `json:"expenses_cents"`
	NetCents       int64 `json:"net_cents"`
	VoidCount      int   `json:"void_count"`
	DiscountCents  int64 `json:"discount_cents"`
}

type DailyPoint struct {
	Day        string `json:"day"`
	SalesCents int64  `json:"sales_cents"`
}

type TopItem struct {
	MenuItemID   uuid.UUID `json:"menu_item_id"`
	Name         string    `json:"name"`
	CategoryName *string   `json:"category_name,omitempty"`
	Qty          int       `json:"qty"`
	RevenueCents int64     `json:"revenue_cents"`
}

type ReportsDashboard struct {
	Range      string        `json:"range"`
	From       time.Time     `json:"from"`
	To         time.Time     `json:"to"`
	Timezone   string        `json:"timezone"`
	KPIs       DashboardKPIs `json:"kpis"`
	Daily      []DailyPoint  `json:"daily"`
	TopSellers []TopItem     `json:"top_sellers"`
	SlowMovers []TopItem     `json:"slow_movers"`
}

func GetDashboard(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "reports.dashboard",
		"range", rng.Label, "from", rng.From, "to", rng.To)
	tx := appctx.Tx(r.Context())
	resp := ReportsDashboard{
		Range:      rng.Label,
		From:       rng.From,
		To:         rng.To,
		Timezone:   rng.TZ,
		Daily:      []DailyPoint{},
		TopSellers: []TopItem{},
		SlowMovers: []TopItem{},
	}

	// KPIs (closed orders only).
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE(SUM(total_cents), 0)::bigint,
		  COALESCE(SUM(tax_cents), 0)::bigint,
		  COALESCE(SUM(service_charge_cents), 0)::bigint,
		  COUNT(*)::int
		FROM orders
		WHERE status = 'closed' AND closed_at >= $1 AND closed_at < $2
	`, rng.From, rng.To).Scan(&resp.KPIs.SalesCents, &resp.KPIs.TaxCents,
		&resp.KPIs.ServiceCents, &resp.KPIs.OrderCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if resp.KPIs.OrderCount > 0 {
		resp.KPIs.AvgTicketCents = resp.KPIs.SalesCents / int64(resp.KPIs.OrderCount)
	}

	// How much of the sales above was settled to a house tab (owed, not in
	// hand). Scoped to the same closed-order window so it's always a subset.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(p.amount_cents), 0)::bigint
		FROM payments p
		JOIN orders o ON o.id = p.order_id
		WHERE p.method = 'house_tab'
		  AND o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
	`, rng.From, rng.To).Scan(&resp.KPIs.TabCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM expenses
		WHERE deleted_at IS NULL AND paid_at >= $1 AND paid_at < $2
	`, rng.From, rng.To).Scan(&resp.KPIs.ExpensesCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	resp.KPIs.NetCents = resp.KPIs.SalesCents - resp.KPIs.ExpensesCents

	// Void + discount counters (operational hygiene metric).
	if err := tx.QueryRow(r.Context(), `
		SELECT COUNT(*)::int
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.voided_at IS NOT NULL
		  AND oi.voided_at >= $1 AND oi.voided_at < $2
	`, rng.From, rng.To).Scan(&resp.KPIs.VoidCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM order_adjustments oa
		JOIN orders o ON o.id = oa.order_id
		WHERE oa.type = 'discount'
		  AND o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
	`, rng.From, rng.To).Scan(&resp.KPIs.DiscountCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Daily series. For short rolling presets ("today"/"yesterday"/"7d") we pad
	// to a 14-day trailing window so the chart still has bars to show. A custom
	// range (month jumper / explicit from–to) is shown exactly as picked, so the
	// chart matches the selected period instead of spilling outside it.
	chartFrom := rng.From
	chartTo := rng.To
	if rng.Days < 14 && rng.Label != "custom" {
		// trail back from the range's end boundary
		chartFrom = rng.To.AddDate(0, 0, -14)
	}
	rows, err := tx.Query(r.Context(), `
		WITH series AS (
		  SELECT generate_series(
		    date_trunc('day', $1::timestamptz AT TIME ZONE $3),
		    date_trunc('day', ($2::timestamptz - INTERVAL '1 second') AT TIME ZONE $3),
		    INTERVAL '1 day'
		  ) AS local_day
		)
		SELECT
		  to_char(local_day, 'YYYY-MM-DD') AS day,
		  COALESCE(SUM(o.total_cents), 0)::bigint
		FROM series
		LEFT JOIN orders o
		  ON o.status = 'closed'
		 AND date_trunc('day', o.closed_at AT TIME ZONE $3) = local_day
		GROUP BY local_day
		ORDER BY local_day
	`, chartFrom, chartTo, rng.TZ)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for rows.Next() {
		var p DailyPoint
		if err := rows.Scan(&p.Day, &p.SalesCents); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		resp.Daily = append(resp.Daily, p)
	}
	rows.Close()

	// Top sellers (revenue desc) within the requested range.
	resp.TopSellers, err = topItems(r.Context(), rng.From, rng.To, "DESC", 5)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	// Slow movers (revenue asc, but require qty>0 so completely-unsold items
	// don't dominate). Same window.
	resp.SlowMovers, err = topItems(r.Context(), rng.From, rng.To, "ASC", 5)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func topItems(ctx context.Context, from, to time.Time, order string, limit int) ([]TopItem, error) {
	if order != "ASC" && order != "DESC" {
		order = "DESC"
	}
	tx := appctx.Tx(ctx)
	rows, err := tx.Query(ctx, `
		SELECT mi.id, mi.name, mc.name,
		       SUM(oi.qty)::int,
		       SUM(oi.qty * oi.unit_price_cents)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		LEFT JOIN menu_categories mc ON mc.id = mi.category_id
		WHERE o.status = 'closed'
		  AND o.closed_at >= $1 AND o.closed_at < $2
		  AND oi.voided_at IS NULL
		GROUP BY mi.id, mi.name, mc.name
		HAVING SUM(oi.qty) > 0
		ORDER BY SUM(oi.qty * oi.unit_price_cents) `+order+`
		LIMIT $3
	`, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopItem{}
	for rows.Next() {
		var t TopItem
		if err := rows.Scan(&t.MenuItemID, &t.Name, &t.CategoryName, &t.Qty, &t.RevenueCents); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// =========================================================================
// /v1/reports/sales?from=&to=&group_by=item|category|day
// =========================================================================

type SalesByDay struct {
	Day          string `json:"day"`
	OrderCount   int    `json:"order_count"`
	RevenueCents int64  `json:"revenue_cents"`
}

type SalesByItem struct {
	MenuItemID   uuid.UUID  `json:"menu_item_id"`
	Name         string     `json:"name"`
	CategoryID   *uuid.UUID `json:"category_id,omitempty"`
	CategoryName *string    `json:"category_name,omitempty"`
	Qty          int        `json:"qty"`
	RevenueCents int64      `json:"revenue_cents"`
}

type SalesByCategory struct {
	MenuCategoryID uuid.UUID `json:"menu_category_id"`
	Name           string    `json:"name"`
	Qty            int       `json:"qty"`
	RevenueCents   int64     `json:"revenue_cents"`
}

func GetSales(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	tz := t.Timezone
	if tz == "" {
		tz = "Asia/Kathmandu"
	}

	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "from + to required (RFC3339)")
		return
	}
	groupBy := r.URL.Query().Get("group_by")
	if groupBy == "" {
		groupBy = "day"
	}
	limit := parseInt(r.URL.Query().Get("limit"), 100)

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "reports.sales",
		"from", from, "to", to, "group_by", groupBy, "limit", limit)

	tx := appctx.Tx(r.Context())

	switch groupBy {
	case "day":
		rows, err := tx.Query(r.Context(), `
			SELECT to_char(date_trunc('day', closed_at AT TIME ZONE $3), 'YYYY-MM-DD'),
			       COUNT(*)::int,
			       COALESCE(SUM(total_cents), 0)::bigint
			FROM orders
			WHERE status = 'closed' AND closed_at >= $1 AND closed_at < $2
			GROUP BY 1
			ORDER BY 1
		`, from, to, tz)
		runListResp[SalesByDay](w, rows, err, "rows", func(s *SalesByDay, r pgx.Row) error {
			return r.Scan(&s.Day, &s.OrderCount, &s.RevenueCents)
		})
	case "item":
		rows, err := tx.Query(r.Context(), `
			SELECT mi.id, mi.name, mc.id, mc.name,
			       SUM(oi.qty)::int,
			       SUM(oi.qty * oi.unit_price_cents)::bigint
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			JOIN menu_items mi ON mi.id = oi.menu_item_id
			LEFT JOIN menu_categories mc ON mc.id = mi.category_id
			WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
			  AND oi.voided_at IS NULL
			GROUP BY mi.id, mi.name, mc.id, mc.name
			ORDER BY SUM(oi.qty * oi.unit_price_cents) DESC
			LIMIT $3
		`, from, to, limit)
		runListResp[SalesByItem](w, rows, err, "rows", func(s *SalesByItem, r pgx.Row) error {
			return r.Scan(&s.MenuItemID, &s.Name, &s.CategoryID, &s.CategoryName, &s.Qty, &s.RevenueCents)
		})
	case "category":
		rows, err := tx.Query(r.Context(), `
			SELECT mc.id, mc.name,
			       SUM(oi.qty)::int,
			       SUM(oi.qty * oi.unit_price_cents)::bigint
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			JOIN menu_items mi ON mi.id = oi.menu_item_id
			JOIN menu_categories mc ON mc.id = mi.category_id
			WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
			  AND oi.voided_at IS NULL
			GROUP BY mc.id, mc.name
			ORDER BY SUM(oi.qty * oi.unit_price_cents) DESC
		`, from, to)
		runListResp[SalesByCategory](w, rows, err, "rows", func(s *SalesByCategory, r pgx.Row) error {
			return r.Scan(&s.MenuCategoryID, &s.Name, &s.Qty, &s.RevenueCents)
		})
	default:
		writeErr(w, http.StatusBadRequest, "bad_request", "group_by must be day|item|category")
	}
}

// =========================================================================
// helpers
// =========================================================================

func parseInt(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// runListResp consumes a query result, scans each row through `scan`, and
// writes the aggregated JSON. Generic over the row type so each report can
// declare its own shape without boilerplate.
func runListResp[T any](w http.ResponseWriter, rows pgx.Rows, qerr error, key string, scan func(*T, pgx.Row) error) {
	if qerr != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", qerr.Error())
		return
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var t T
		if err := scan(&t, rows); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{key: out})
}
