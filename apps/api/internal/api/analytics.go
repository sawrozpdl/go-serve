package api

import (
	"net/http"
	"time"

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
	rng, err := resolveRange(r.Context(), r.URL.Query().Get("range"))
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
	rng, err := resolveRange(r.Context(), r.URL.Query().Get("range"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT
		  EXTRACT(DOW  FROM (closed_at AT TIME ZONE $3))::int AS dow,
		  EXTRACT(HOUR FROM (closed_at AT TIME ZONE $3))::int AS hr,
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
	rng, err := resolveRange(r.Context(), r.URL.Query().Get("range"))
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
	rng, err := resolveRange(r.Context(), r.URL.Query().Get("range"))
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
	rng, err := resolveRange(r.Context(), r.URL.Query().Get("range"))
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
