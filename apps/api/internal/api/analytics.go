package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// /v1/reports/top-sellers?range=...
//
// Top + bottom sellers for the requested window, with prior-period delta so
// the FE can render up/down arrows. Prior window is the same length
// immediately preceding the requested window.
// =========================================================================

type TopSellerRow struct {
	MenuItemID   uuid.UUID `json:"menu_item_id"`
	Name         string    `json:"name"`
	Icon         string    `json:"icon"`
	CategoryName *string   `json:"category_name,omitempty"`
	Qty          int       `json:"qty"`
	RevenueCents int64     `json:"revenue_cents"`
	PrevQty      int       `json:"prev_qty"`
	PrevRevenue  int64     `json:"prev_revenue_cents"`
	// DeltaPct: percent change in revenue vs. prior window. NULL when prior
	// window had zero revenue (no meaningful comparison).
	DeltaPct *float64 `json:"delta_pct,omitempty"`
}

type TopSellersResp struct {
	Range    string         `json:"range"`
	From     time.Time      `json:"from"`
	To       time.Time      `json:"to"`
	PrevFrom time.Time      `json:"prev_from"`
	PrevTo   time.Time      `json:"prev_to"`
	Top      []TopSellerRow `json:"top"`
	Bottom   []TopSellerRow `json:"bottom"`
}

func GetTopSellers(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	dur := rng.To.Sub(rng.From)
	prevFrom := rng.From.Add(-dur)
	prevTo := rng.From

	out := TopSellersResp{
		Range:    rng.Label,
		From:     rng.From,
		To:       rng.To,
		PrevFrom: prevFrom,
		PrevTo:   prevTo,
		Top:      []TopSellerRow{},
		Bottom:   []TopSellerRow{},
	}

	if out.Top, err = queryTopSellers(r, rng.From, rng.To, prevFrom, prevTo, "DESC", 8); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if out.Bottom, err = queryTopSellers(r, rng.From, rng.To, prevFrom, prevTo, "ASC", 5); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func queryTopSellers(r *http.Request, from, to, prevFrom, prevTo time.Time, order string, limit int) ([]TopSellerRow, error) {
	if order != "ASC" && order != "DESC" {
		order = "DESC"
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		WITH cur AS (
		  SELECT mi.id AS menu_item_id,
		         mi.name,
		         mi.icon,
		         mc.name AS category_name,
		         SUM(oi.qty)::int AS qty,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  LEFT JOIN menu_categories mc ON mc.id = mi.category_id
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $1 AND o.closed_at < $2
		    AND oi.voided_at IS NULL
		  GROUP BY mi.id, mi.name, mi.icon, mc.name
		  HAVING SUM(oi.qty) > 0
		),
		prev AS (
		  SELECT oi.menu_item_id,
		         SUM(oi.qty)::int AS qty,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $3 AND o.closed_at < $4
		    AND oi.voided_at IS NULL
		  GROUP BY oi.menu_item_id
		)
		SELECT cur.menu_item_id, cur.name, cur.icon, cur.category_name, cur.qty, cur.revenue,
		       COALESCE(prev.qty, 0), COALESCE(prev.revenue, 0)
		FROM cur
		LEFT JOIN prev ON prev.menu_item_id = cur.menu_item_id
		ORDER BY cur.revenue `+order+`
		LIMIT $5
	`, from, to, prevFrom, prevTo, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopSellerRow{}
	for rows.Next() {
		var t TopSellerRow
		if err := rows.Scan(&t.MenuItemID, &t.Name, &t.Icon, &t.CategoryName,
			&t.Qty, &t.RevenueCents, &t.PrevQty, &t.PrevRevenue); err != nil {
			return nil, err
		}
		if t.PrevRevenue > 0 {
			d := (float64(t.RevenueCents-t.PrevRevenue) / float64(t.PrevRevenue)) * 100
			d = roundTo(d, 1)
			t.DeltaPct = &d
		}
		out = append(out, t)
	}
	return out, nil
}

// =========================================================================
// /v1/reports/movers?range=&category_id=&sort=&order=&q=&limit=&offset=
//
// The comprehensive "top movers" report: every sold item in the window (not
// just the dashboard's top 8), with prior-period delta, filterable by category
// and name, sortable by revenue or qty, and paginated. `total` is the full
// filtered row count so the FE can page. Fractional (½-plate) quantities are
// preserved.
// =========================================================================

type MoverRow struct {
	MenuItemID   uuid.UUID `json:"menu_item_id"`
	Name         string    `json:"name"`
	Icon         string    `json:"icon"`
	CategoryName *string   `json:"category_name,omitempty"`
	Qty          float64   `json:"qty"`
	RevenueCents int64     `json:"revenue_cents"`
	PrevQty      float64   `json:"prev_qty"`
	PrevRevenue  int64     `json:"prev_revenue_cents"`
	DeltaPct     *float64  `json:"delta_pct,omitempty"`
}

type MoversResp struct {
	Range    string     `json:"range"`
	From     time.Time  `json:"from"`
	To       time.Time  `json:"to"`
	PrevFrom time.Time  `json:"prev_from"`
	PrevTo   time.Time  `json:"prev_to"`
	Total    int        `json:"total"`
	Rows     []MoverRow `json:"rows"`
}

func GetMovers(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	dur := rng.To.Sub(rng.From)
	prevFrom := rng.From.Add(-dur)
	prevTo := rng.From

	// Whitelist the sort column + direction — these are string-interpolated into
	// the query, so they must never come straight from the client.
	sortCol := "cur.revenue"
	if r.URL.Query().Get("sort") == "qty" {
		sortCol = "cur.qty"
	}
	order := "DESC"
	if strings.EqualFold(r.URL.Query().Get("order"), "asc") {
		order = "ASC"
	}

	// Optional filters — passed as typed NULLs so one query serves every combo.
	var categoryID *uuid.UUID
	if s := strings.TrimSpace(r.URL.Query().Get("category_id")); s != "" {
		if id, e := uuid.Parse(s); e == nil {
			categoryID = &id
		} else {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid category_id")
			return
		}
	}
	var q *string
	if s := strings.TrimSpace(r.URL.Query().Get("q")); s != "" {
		q = &s
	}

	limit := 100
	if n, e := strconv.Atoi(r.URL.Query().Get("limit")); e == nil && n > 0 && n <= 1000 {
		limit = n
	}
	offset := 0
	if n, e := strconv.Atoi(r.URL.Query().Get("offset")); e == nil && n > 0 {
		offset = n
	}

	out := MoversResp{
		Range: rng.Label, From: rng.From, To: rng.To,
		PrevFrom: prevFrom, PrevTo: prevTo, Rows: []MoverRow{},
	}

	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		WITH cur AS (
		  SELECT mi.id AS menu_item_id, mi.name, mi.icon, mc.name AS category_name,
		         SUM(oi.qty)::numeric AS qty,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  LEFT JOIN menu_categories mc ON mc.id = mi.category_id
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $1 AND o.closed_at < $2
		    AND oi.voided_at IS NULL
		    AND ($5::uuid IS NULL OR mi.category_id = $5)
		    AND ($6::text IS NULL OR mi.name ILIKE '%' || $6 || '%')
		  GROUP BY mi.id, mi.name, mi.icon, mc.name
		  HAVING SUM(oi.qty) > 0
		),
		prev AS (
		  SELECT oi.menu_item_id,
		         SUM(oi.qty)::numeric AS qty,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $3 AND o.closed_at < $4
		    AND oi.voided_at IS NULL
		  GROUP BY oi.menu_item_id
		)
		SELECT cur.menu_item_id, cur.name, cur.icon, cur.category_name, cur.qty, cur.revenue,
		       COALESCE(prev.qty, 0), COALESCE(prev.revenue, 0),
		       COUNT(*) OVER()::int AS total
		FROM cur
		LEFT JOIN prev ON prev.menu_item_id = cur.menu_item_id
		ORDER BY `+sortCol+` `+order+`, cur.name ASC
		LIMIT $7 OFFSET $8
	`, rng.From, rng.To, prevFrom, prevTo, categoryID, q, limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	for rows.Next() {
		var m MoverRow
		var total int
		if err := rows.Scan(&m.MenuItemID, &m.Name, &m.Icon, &m.CategoryName,
			&m.Qty, &m.RevenueCents, &m.PrevQty, &m.PrevRevenue, &total); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if m.PrevRevenue > 0 {
			d := roundTo((float64(m.RevenueCents-m.PrevRevenue)/float64(m.PrevRevenue))*100, 1)
			m.DeltaPct = &d
		}
		out.Total = total
		out.Rows = append(out.Rows, m)
	}
	writeJSON(w, http.StatusOK, out)
}

// =========================================================================
// /v1/reports/item/{menuItemId}?range=...
//
// Single-item drilldown for managerial comparison: window + prior-window
// totals (qty, revenue, cost, margin) plus a per-day trend series and a
// qty-by-hour distribution so an owner can see how one item is really doing.
// =========================================================================

type ItemDayPoint struct {
	Date         string  `json:"date"` // YYYY-MM-DD, tenant-local
	Qty          float64 `json:"qty"`
	RevenueCents int64   `json:"revenue_cents"`
}

type ItemAnalyticsResp struct {
	MenuItemID   uuid.UUID `json:"menu_item_id"`
	Name         string    `json:"name"`
	Icon         string    `json:"icon"`
	CategoryName *string   `json:"category_name,omitempty"`
	Range        string    `json:"range"`
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
	PrevFrom     time.Time `json:"prev_from"`
	PrevTo       time.Time `json:"prev_to"`
	Timezone     string    `json:"timezone"`

	Qty          float64  `json:"qty"`
	RevenueCents int64    `json:"revenue_cents"`
	CostCents    int64    `json:"cost_cents"`
	MarginPct    *float64 `json:"margin_pct,omitempty"`

	PrevQty     float64 `json:"prev_qty"`
	PrevRevenue int64   `json:"prev_revenue_cents"`

	Series []ItemDayPoint `json:"series"`
	ByHour [24]float64    `json:"by_hour"` // qty per tenant-local hour
}

func GetItemAnalytics(w http.ResponseWriter, r *http.Request) {
	itemID, err := uuid.Parse(chi.URLParam(r, "menuItemId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid item id")
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
	dur := rng.To.Sub(rng.From)
	prevFrom := rng.From.Add(-dur)
	prevTo := rng.From

	tx := appctx.Tx(r.Context())

	out := ItemAnalyticsResp{
		MenuItemID: itemID,
		Range:      rng.Label, From: rng.From, To: rng.To,
		PrevFrom: prevFrom, PrevTo: prevTo, Timezone: rng.TZ,
		Series: []ItemDayPoint{},
	}

	// Identity — 404 if the item was deleted / never existed for this tenant.
	if err := tx.QueryRow(r.Context(), `
		SELECT mi.name, mi.icon, mc.name
		FROM menu_items mi
		LEFT JOIN menu_categories mc ON mc.id = mi.category_id
		WHERE mi.id = $1
	`, itemID).Scan(&out.Name, &out.Icon, &out.CategoryName); err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "menu item not found")
		return
	}

	// Window totals (qty, revenue, cost).
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(oi.qty), 0)::numeric,
		       COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint,
		       COALESCE(SUM(oi.qty * oi.unit_cost_cents),  0)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.menu_item_id = $1 AND o.status = 'closed'
		  AND o.closed_at >= $2 AND o.closed_at < $3 AND oi.voided_at IS NULL
	`, itemID, rng.From, rng.To).Scan(&out.Qty, &out.RevenueCents, &out.CostCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out.MarginPct = marginPct(out.RevenueCents, out.RevenueCents-out.CostCents)

	// Prior-window totals for the delta.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(oi.qty), 0)::numeric,
		       COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.menu_item_id = $1 AND o.status = 'closed'
		  AND o.closed_at >= $2 AND o.closed_at < $3 AND oi.voided_at IS NULL
	`, itemID, prevFrom, prevTo).Scan(&out.PrevQty, &out.PrevRevenue); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Per-day trend (tenant-local dates).
	dayRows, err := tx.Query(r.Context(), `
		SELECT to_char((o.closed_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d,
		       SUM(oi.qty)::numeric,
		       SUM(oi.qty * oi.unit_price_cents)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.menu_item_id = $1 AND o.status = 'closed'
		  AND o.closed_at >= $2 AND o.closed_at < $3 AND oi.voided_at IS NULL
		GROUP BY 1 ORDER BY 1
	`, itemID, rng.From, rng.To, rng.TZ)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer dayRows.Close()
	for dayRows.Next() {
		var p ItemDayPoint
		if err := dayRows.Scan(&p.Date, &p.Qty, &p.RevenueCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out.Series = append(out.Series, p)
	}
	dayRows.Close()

	// Qty by tenant-local hour (0..23), zero-filled in Go.
	hrRows, err := tx.Query(r.Context(), `
		SELECT EXTRACT(HOUR FROM (o.closed_at AT TIME ZONE $4))::int AS hr,
		       SUM(oi.qty)::numeric
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.menu_item_id = $1 AND o.status = 'closed'
		  AND o.closed_at >= $2 AND o.closed_at < $3 AND oi.voided_at IS NULL
		GROUP BY 1
	`, itemID, rng.From, rng.To, rng.TZ)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer hrRows.Close()
	for hrRows.Next() {
		var hr int
		var qty float64
		if err := hrRows.Scan(&hr, &qty); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if hr >= 0 && hr < 24 {
			out.ByHour[hr] = qty
		}
	}

	writeJSON(w, http.StatusOK, out)
}

// =========================================================================
// /v1/reports/heatmap?range=...
//
// Order volume by hour-of-day × day-of-week. 7 rows × 24 cols, zeros for
// empty cells. FE renders a heatmap so staffing can match the actual
// service curve.
// =========================================================================

type HeatmapCell struct {
	Hour         int   `json:"hour"` // 0..23
	Dow          int   `json:"dow"`  // 0=Sun..6=Sat (postgres convention)
	OrderCount   int   `json:"order_count"`
	RevenueCents int64 `json:"revenue_cents"`
}

type HeatmapResp struct {
	Range    string        `json:"range"`
	From     time.Time     `json:"from"`
	To       time.Time     `json:"to"`
	Timezone string        `json:"timezone"`
	Cells    []HeatmapCell `json:"cells"`
}

func GetHeatmap(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT
		  EXTRACT(DOW  FROM (opened_at AT TIME ZONE $3))::int AS dow,
		  EXTRACT(HOUR FROM (opened_at AT TIME ZONE $3))::int AS hr,
		  COUNT(*)::int,
		  COALESCE(SUM(total_cents), 0)::bigint
		FROM orders
		WHERE status = 'closed' AND closed_at >= $1 AND closed_at < $2
		GROUP BY 1, 2
		ORDER BY 1, 2
	`, rng.From, rng.To, rng.TZ)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	resp := HeatmapResp{
		Range:    rng.Label,
		From:     rng.From,
		To:       rng.To,
		Timezone: rng.TZ,
		Cells:    []HeatmapCell{},
	}
	for rows.Next() {
		var c HeatmapCell
		if err := rows.Scan(&c.Dow, &c.Hour, &c.OrderCount, &c.RevenueCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		resp.Cells = append(resp.Cells, c)
	}
	writeJSON(w, http.StatusOK, resp)
}

// =========================================================================
// /v1/reports/hourly?date=YYYY-MM-DD
//
// Orders + revenue bucketed by hour-of-day for a single tenant-local day
// (defaults to today). 24 rows, zeros for empty hours. Powers the dashboard
// "Hourly" tab: a per-hour bar chart plus a "last completed hour" summary the
// FE derives client-side. Buckets on closed_at so revenue matches the Sales
// KPI and the daily chart.
// =========================================================================

type HourlyBucket struct {
	Hour         int   `json:"hour"` // 0..23 (tenant-local)
	OrderCount   int   `json:"order_count"`
	RevenueCents int64 `json:"revenue_cents"`
}

type HourlyResp struct {
	Date     string         `json:"date"` // YYYY-MM-DD, tenant-local
	Timezone string         `json:"timezone"`
	Hours    []HourlyBucket `json:"hours"`
}

func GetHourly(w http.ResponseWriter, r *http.Request) {
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	// A single day is just a custom range whose from == to; resolveRangeFull
	// expands a date-only "to" to the start of the next day, so we get a clean
	// [local-midnight, next-local-midnight) window with all the tz handling.
	var rng rangeWindow
	var err error
	if date == "" {
		rng, err = resolveRangeFull(r.Context(), "today", "", "")
	} else {
		rng, err = resolveRangeFull(r.Context(), "custom", date, date)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}

	// Echo the resolved local date so the FE day-navigator stays in sync even
	// when no explicit date was passed (defaults to today).
	localDate := date
	if localDate == "" {
		if loc, e := time.LoadLocation(rng.TZ); e == nil {
			localDate = rng.From.In(loc).Format("2006-01-02")
		}
	}

	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		WITH hrs AS (SELECT generate_series(0, 23) AS hr)
		SELECT hrs.hr,
		       COALESCE(COUNT(o.id), 0)::int,
		       COALESCE(SUM(o.total_cents), 0)::bigint
		FROM hrs
		LEFT JOIN orders o
		  ON o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
		 AND EXTRACT(HOUR FROM (o.closed_at AT TIME ZONE $3))::int = hrs.hr
		GROUP BY hrs.hr
		ORDER BY hrs.hr
	`, rng.From, rng.To, rng.TZ)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	resp := HourlyResp{
		Date:     localDate,
		Timezone: rng.TZ,
		Hours:    []HourlyBucket{},
	}
	for rows.Next() {
		var b HourlyBucket
		if err := rows.Scan(&b.Hour, &b.OrderCount, &b.RevenueCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		resp.Hours = append(resp.Hours, b)
	}
	writeJSON(w, http.StatusOK, resp)
}

// =========================================================================
// /v1/reports/category-mix?range=...
//
// Revenue share per category (for the donut/share chart) — includes icon
// + color so the FE doesn't need a second round-trip.
// =========================================================================

type CategoryMixRow struct {
	CategoryID   uuid.UUID `json:"category_id"`
	Name         string    `json:"name"`
	Color        *string   `json:"color,omitempty"`
	Icon         string    `json:"icon"`
	Qty          int       `json:"qty"`
	RevenueCents int64     `json:"revenue_cents"`
	SharePct     float64   `json:"share_pct"`
}

func GetCategoryMix(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		WITH per_cat AS (
		  SELECT mc.id, mc.name, mc.color, mc.icon,
		         SUM(oi.qty)::int AS qty,
		         SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  JOIN menu_items mi ON mi.id = oi.menu_item_id
		  JOIN menu_categories mc ON mc.id = mi.category_id
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $1 AND o.closed_at < $2
		    AND oi.voided_at IS NULL
		  GROUP BY mc.id, mc.name, mc.color, mc.icon
		)
		SELECT id, name, color, icon, qty, revenue,
		       CASE WHEN (SELECT SUM(revenue) FROM per_cat) > 0
		            THEN ROUND( (revenue::numeric / (SELECT SUM(revenue) FROM per_cat)) * 100, 2)
		            ELSE 0
		       END AS share_pct
		FROM per_cat
		ORDER BY revenue DESC
	`, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []CategoryMixRow{}
	for rows.Next() {
		var c CategoryMixRow
		if err := rows.Scan(&c.CategoryID, &c.Name, &c.Color, &c.Icon, &c.Qty, &c.RevenueCents, &c.SharePct); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"range": rng.Label,
		"from":  rng.From,
		"to":    rng.To,
		"rows":  out,
	})
}

// =========================================================================
// /v1/reports/table-mix?range=...
//
// Per-table utilization. Counts CLOSED orders + revenue + avg ticket for the
// window. Tables that didn't turn at all are still returned (with zeros) so
// the FE can flag dead tables.
// =========================================================================

type TableMixRow struct {
	TableID        uuid.UUID `json:"table_id"`
	Name           string    `json:"name"`
	Icon           string    `json:"icon"`
	Capacity       int       `json:"capacity"`
	OrderCount     int       `json:"order_count"`
	RevenueCents   int64     `json:"revenue_cents"`
	AvgTicketCents int64     `json:"avg_ticket_cents"`
}

func GetTableMix(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT st.id, st.name, st.icon, st.capacity,
		       COALESCE(stats.order_count, 0)::int,
		       COALESCE(stats.revenue, 0)::bigint,
		       -- SUM(bigint) is numeric in Postgres, so the average must be
		       -- cast back to bigint before it can scan into int64. NULLIF
		       -- guards the zero-order divide (→ NULL → COALESCE 0).
		       COALESCE((stats.revenue / NULLIF(stats.order_count, 0))::bigint, 0)
		FROM service_tables st
		LEFT JOIN (
		  SELECT o.service_table_id, COUNT(*) AS order_count, SUM(o.total_cents) AS revenue
		  FROM orders o
		  WHERE o.status = 'closed'
		    AND o.closed_at >= $1 AND o.closed_at < $2
		  GROUP BY o.service_table_id
		) stats ON stats.service_table_id = st.id
		WHERE st.deleted_at IS NULL
		ORDER BY COALESCE(stats.revenue, 0) DESC, st.sort, lower(st.name)
	`, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []TableMixRow{}
	for rows.Next() {
		var t TableMixRow
		if err := rows.Scan(&t.TableID, &t.Name, &t.Icon, &t.Capacity, &t.OrderCount, &t.RevenueCents, &t.AvgTicketCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, t)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"range": rng.Label,
		"from":  rng.From,
		"to":    rng.To,
		"rows":  out,
	})
}

// =========================================================================
// /v1/reports/velocity?range=...
//
// Daily series of order count, revenue, avg ticket, items per order. Used by
// the dashboard to show throughput trends alongside the existing daily-sales
// bar chart.
// =========================================================================

type VelocityPoint struct {
	Day              string `json:"day"`
	OrderCount       int    `json:"order_count"`
	RevenueCents     int64  `json:"revenue_cents"`
	AvgTicketCents   int64  `json:"avg_ticket_cents"`
	ItemsTotal       int    `json:"items_total"`
	ItemsPerOrderX10 int    `json:"items_per_order_x10"` // *10 for one-decimal display without floats
}

type VelocityResp struct {
	Range    string          `json:"range"`
	From     time.Time       `json:"from"`
	To       time.Time       `json:"to"`
	Timezone string          `json:"timezone"`
	Series   []VelocityPoint `json:"series"`
	// Totals across the entire window — handy for header KPIs.
	TotalOrders         int   `json:"total_orders"`
	TotalRevenueCents   int64 `json:"total_revenue_cents"`
	AvgTicketCents      int64 `json:"avg_ticket_cents"`
	AvgItemsPerOrderX10 int   `json:"avg_items_per_order_x10"`
}

func GetVelocity(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())

	// One row per local-day in the window; outer left-join from a
	// generate_series so empty days still appear as zeros.
	rows, err := tx.Query(r.Context(), `
		WITH days AS (
		  SELECT generate_series(
		    date_trunc('day', $1::timestamptz AT TIME ZONE $3),
		    date_trunc('day', ($2::timestamptz - INTERVAL '1 second') AT TIME ZONE $3),
		    INTERVAL '1 day'
		  ) AS local_day
		),
		ords AS (
		  SELECT date_trunc('day', o.closed_at AT TIME ZONE $3) AS local_day,
		         COUNT(*)::int AS order_count,
		         COALESCE(SUM(o.total_cents),0)::bigint AS revenue,
		         o.id AS order_id
		  FROM orders o
		  WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
		  GROUP BY 1, o.id
		),
		ord_summary AS (
		  SELECT local_day, COUNT(DISTINCT order_id)::int AS order_count,
		         SUM(revenue)::bigint AS revenue
		  FROM ords GROUP BY local_day
		),
		items AS (
		  SELECT date_trunc('day', o.closed_at AT TIME ZONE $3) AS local_day,
		         SUM(oi.qty)::int AS items_total
		  FROM order_items oi
		  JOIN orders o ON o.id = oi.order_id
		  WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
		    AND oi.voided_at IS NULL
		  GROUP BY 1
		)
		SELECT to_char(d.local_day, 'YYYY-MM-DD'),
		       COALESCE(os.order_count, 0),
		       COALESCE(os.revenue, 0),
		       COALESCE(it.items_total, 0)
		FROM days d
		LEFT JOIN ord_summary os ON os.local_day = d.local_day
		LEFT JOIN items it ON it.local_day = d.local_day
		ORDER BY d.local_day
	`, rng.From, rng.To, rng.TZ)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	resp := VelocityResp{
		Range:    rng.Label,
		From:     rng.From,
		To:       rng.To,
		Timezone: rng.TZ,
		Series:   []VelocityPoint{},
	}
	var totalItems int
	for rows.Next() {
		var p VelocityPoint
		if err := rows.Scan(&p.Day, &p.OrderCount, &p.RevenueCents, &p.ItemsTotal); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if p.OrderCount > 0 {
			p.AvgTicketCents = p.RevenueCents / int64(p.OrderCount)
			p.ItemsPerOrderX10 = (p.ItemsTotal * 10) / p.OrderCount
		}
		resp.Series = append(resp.Series, p)
		resp.TotalOrders += p.OrderCount
		resp.TotalRevenueCents += p.RevenueCents
		totalItems += p.ItemsTotal
	}
	if resp.TotalOrders > 0 {
		resp.AvgTicketCents = resp.TotalRevenueCents / int64(resp.TotalOrders)
		resp.AvgItemsPerOrderX10 = (totalItems * 10) / resp.TotalOrders
	}
	writeJSON(w, http.StatusOK, resp)
}

func roundTo(x float64, places int) float64 {
	mult := 1.0
	for i := 0; i < places; i++ {
		mult *= 10
	}
	if x >= 0 {
		return float64(int64(x*mult+0.5)) / mult
	}
	return float64(int64(x*mult-0.5)) / mult
}
