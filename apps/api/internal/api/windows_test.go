package api

// Window and population consistency. Every money figure answers a question of
// the form "how much, between when and when" — so the boundaries and the row
// population have to be the same wherever two figures are meant to reconcile.
// These tests pin the ones the audit found drifting.

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Shift summary: one population for every figure
// =========================================================================

// Sales came from orders windowed on closed_at while on-tab came from payments
// windowed on shift_id. A tab charge recorded in one shift for an order closed in
// the next therefore made one shift report MORE collected than it billed, and the
// other report a NEGATIVE amount collected.
func TestShiftSummary_ReceivedNeverExceedsSalesOrGoesNegative(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0") // this test is about windows, not tax
	shift1 := fx.seedOpenShift(1000)
	tabID := fx.seedHouseTab("CrossShift", true)

	// A tab charge recorded during shift 1, on an order that stays open.
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("CrossCat")
	item := fx.seedMenuItem(cat, "CrossItem", 5000)
	fx.seedOrderItem(order, item, 1, 5000)
	payID := fx.seedPayment(order, "house_tab", 5000, ptrUUID(shift1))
	fx.adminExec(`UPDATE payments SET house_tab_id = $2 WHERE id = $1`, payID, tabID)

	// Shift 1 closes before the order does.
	closed1 := time.Now().UTC()
	fx.adminExec(`UPDATE shifts SET closed_at = $2, closed_by_user_id = $3,
	              closing_count_cents = 1000, expected_cash_cents = 1000, variance_cents = 0
	              WHERE id = $1`, shift1, closed1, fx.User)

	// The order closes afterwards, inside shift 2.
	shift2 := fx.seedOpenShift(1000)
	fx.closeOrderWithTotals(order)

	s1, err := buildShiftSummaryFor(t, fx, shift1)
	if err != nil {
		t.Fatalf("shift 1 summary: %v", err)
	}
	if s1.ReceivedCents < 0 {
		t.Fatalf("shift 1 Received = %d — a shift can never collect a negative amount",
			s1.ReceivedCents)
	}
	if s1.OnTabCents > s1.SalesCents {
		t.Fatalf("shift 1 on-tab %d exceeds its billed sales %d — two populations again",
			s1.OnTabCents, s1.SalesCents)
	}

	fx.adminExec(`UPDATE shifts SET closed_at = now(), closed_by_user_id = $2,
	              closing_count_cents = 1000, expected_cash_cents = 1000, variance_cents = 0
	              WHERE id = $1`, shift2, fx.User)
	s2, err := buildShiftSummaryFor(t, fx, shift2)
	if err != nil {
		t.Fatalf("shift 2 summary: %v", err)
	}
	// Shift 2 billed the order and it was entirely on credit, so nothing was
	// collected — but the sales and on-tab figures must agree about it.
	if s2.SalesCents != 5000 {
		t.Fatalf("shift 2 sales = %d, want 5000 (the order closed in this shift)", s2.SalesCents)
	}
	if s2.OnTabCents != 5000 {
		t.Fatalf("shift 2 on-tab = %d, want 5000 — same population as sales", s2.OnTabCents)
	}
	if s2.ReceivedCents != 0 {
		t.Fatalf("shift 2 received = %d, want 0", s2.ReceivedCents)
	}
}

// Every shift figure is windowed [opened, closed), so an order closed after the
// shift ends belongs to the next one — never to both.
func TestShiftSummary_HalfOpenWindow(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	shift := fx.seedOpenShift(1000)
	var openedAt time.Time
	fx.adminScan([]any{&openedAt}, `SELECT opened_at FROM shifts WHERE id = $1`, shift)

	cat := fx.seedCategory("BoundaryCat")
	// Inside: exactly at opened_at (the window includes its lower bound).
	inside := fx.seedOpenOrder(nil)
	fx.seedOrderItem(inside, fx.seedMenuItem(cat, "AtOpen", 1000), 1, 1000)
	fx.closeOrderWithTotals(inside)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, inside, openedAt)

	closedAt := openedAt.Add(2 * time.Hour)
	// On the upper bound: excluded, because [opened, closed) is half-open.
	onBound := fx.seedOpenOrder(nil)
	fx.seedOrderItem(onBound, fx.seedMenuItem(cat, "AtClose", 7000), 1, 7000)
	fx.closeOrderWithTotals(onBound)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, onBound, closedAt)

	fx.adminExec(`UPDATE shifts SET closed_at = $2, closed_by_user_id = $3,
	              closing_count_cents = 1000, expected_cash_cents = 1000, variance_cents = 0
	              WHERE id = $1`, shift, closedAt, fx.User)

	s, err := buildShiftSummaryFor(t, fx, shift)
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if s.SalesCents != 1000 {
		t.Fatalf("sales = %d, want 1000 — the order ON the closing instant belongs to "+
			"the next window, not this one", s.SalesCents)
	}
	if s.OrderCount != 1 {
		t.Fatalf("order_count = %d, want 1", s.OrderCount)
	}
}

// Voids on a cancelled order used to inflate the shift's void count: cancelling
// already retires the whole order, so counting its lines reports one event twice.
func TestShiftSummary_VoidCountExcludesCancelledOrders(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(1000)
	cat := fx.seedCategory("VoidShiftCat")

	// A real void on a live order.
	live := fx.seedOpenOrder(nil)
	lineA := fx.seedOrderItem(live, fx.seedMenuItem(cat, "Kept", 1000), 1, 1000)
	ordVoidItem(fx, lineA)

	// A void on an order that was then cancelled.
	dead := fx.seedOpenOrder(nil)
	lineB := fx.seedOrderItem(dead, fx.seedMenuItem(cat, "Dropped", 1000), 1, 1000)
	ordVoidItem(fx, lineB)
	fx.setOrderStatus(dead, "cancelled")

	fx.adminExec(`UPDATE shifts SET closed_at = now() + interval '1 minute',
	              closed_by_user_id = $2, closing_count_cents = 1000,
	              expected_cash_cents = 1000, variance_cents = 0 WHERE id = $1`, shift, fx.User)

	s, err := buildShiftSummaryFor(t, fx, shift)
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if s.VoidCount != 1 {
		t.Fatalf("void_count = %d, want 1 (the cancelled order's line must not count)",
			s.VoidCount)
	}
}

// buildShiftSummaryFor runs the real summary builder for a closed shift, inside
// the same RLS-scoped transaction shape CloseShift uses.
func buildShiftSummaryFor(t *testing.T, fx *fixture, shiftID uuid.UUID) (summaryResult, error) {
	t.Helper()
	var openedAt, closedAt time.Time
	fx.adminScan([]any{&openedAt, &closedAt},
		`SELECT opened_at, closed_at FROM shifts WHERE id = $1`, shiftID)

	var out summaryResult
	r := callHandler(t, fx, func(w http.ResponseWriter, req *http.Request) {
		s, err := buildShiftSummary(req.Context(), shiftID, fx.Tenant,
			fx.Name, fx.Slug, "Asia/Kathmandu", openedAt, closedAt, "",
			1000, 1000, 1000, 0, shiftCashFlow{})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, summaryResult{
			SalesCents:    s.SalesCents,
			OnTabCents:    s.OnTabCents,
			ReceivedCents: s.ReceivedCents,
			OrderCount:    s.OrderCount,
			VoidCount:     s.VoidCount,
			DiscountCents: s.DiscountCents,
			Recipients:    s.Recipients,
		})
	}, http.MethodGet, "/", nil)
	if r.Code != http.StatusOK {
		return out, fmt.Errorf("status %d: %s", r.Code, string(r.Body))
	}
	r.decode(&out)
	return out, nil
}

type summaryResult struct {
	Recipients    []string `json:"recipients"`
	SalesCents    int64    `json:"sales_cents"`
	OnTabCents    int64    `json:"on_tab_cents"`
	ReceivedCents int64    `json:"received_cents"`
	OrderCount    int      `json:"order_count"`
	VoidCount     int      `json:"void_count"`
	DiscountCents int64    `json:"discount_cents"`
}

// The shift-close email had NO recipients in production: this query still read
// tm.role, which migration 0019 removed when roles moved to
// tenant_member_roles -> roles. CloseShift builds the summary inside a savepoint
// and only logs a warning when it fails, so the mail just stopped arriving —
// and buildShiftSummary had no tests at all.
func TestShiftSummary_ResolvesOwnerManagerRecipients(t *testing.T) {
	fx := newTenant(t)
	fx.grantRole(fx.User, "owner") // roles live in the DB, not just the request ctx
	manager := fx.addUser("Manager")
	fx.grantRole(manager, "manager")
	shift := fx.seedOpenShift(1000)
	fx.adminExec(`UPDATE shifts SET closed_at = now() + interval '1 minute',
	              closed_by_user_id = $2, closing_count_cents = 1000,
	              expected_cash_cents = 1000, variance_cents = 0 WHERE id = $1`, shift, fx.User)

	s, err := buildShiftSummaryFor(t, fx, shift)
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	// newTenant creates an owner; the owner must be on the mail.
	if len(s.Recipients) == 0 {
		t.Fatal("no recipients — owners and managers must receive the shift summary")
	}
	found := false
	for _, e := range s.Recipients {
		if e == fx.Email {
			found = true
		}
	}
	if !found {
		t.Fatalf("recipients %v do not include the tenant owner %s", s.Recipients, fx.Email)
	}
	if len(s.Recipients) != 2 {
		t.Fatalf("recipients = %v, want the owner and the manager", s.Recipients)
	}
}

// =========================================================================
// Heatmap buckets on the column it filters on
// =========================================================================

// A tab opened 23:40 and closed 00:20 used to land in the PREVIOUS day's 23:00
// cell while its money sat in the next day's total — and GetHourly, right beside
// it on the same screen, bucketed the same order differently.
func TestHeatmap_BucketsOnCloseTimeLikeHourly(t *testing.T) {
	fx := newTenant(t)
	// Opened 23:40 local, closed 00:20 local the next day.
	// Kathmandu is UTC+5:45: 00:20 local = 18:35 UTC the previous day.
	closedUTC := time.Date(2026, 4, 10, 18, 35, 0, 0, time.UTC) // 00:20 local Apr 11
	openedUTC := closedUTC.Add(-40 * time.Minute)               // 23:40 local Apr 10

	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("LateCat")
	fx.seedOrderItem(order, fx.seedMenuItem(cat, "NightPlate", 3000), 1, 3000)
	fx.closeOrderWithTotals(order)
	fx.adminExec(`UPDATE orders SET opened_at = $2, closed_at = $3 WHERE id = $1`,
		order, openedUTC, closedUTC)

	m := callHandler(t, fx, GetHeatmap, http.MethodGet, "/reports/heatmap", nil,
		withQuery("range=custom&from=2026-04-11&to=2026-04-11")).
		expectStatus(http.StatusOK).json()
	cells, _ := m["cells"].([]any)
	if len(cells) != 1 {
		t.Fatalf("cells = %d, want 1", len(cells))
	}
	c := cells[0].(map[string]any)
	if hour := int(c["hour"].(float64)); hour != 0 {
		t.Fatalf("hour = %d, want 0 — the serve CLOSED at 00:20 local", hour)
	}
	// Saturday Apr 11 2026 → dow 6.
	if dow := int(c["dow"].(float64)); dow != 6 {
		t.Fatalf("dow = %d, want 6 (Saturday, the local close day)", dow)
	}

	// GetHourly, which already bucketed on closed_at, must agree.
	h := callHandler(t, fx, GetHourly, http.MethodGet, "/reports/hourly", nil,
		withQuery("date=2026-04-11")).expectStatus(http.StatusOK).json()
	hours, _ := h["hours"].([]any)
	got := int64(hours[0].(map[string]any)["revenue_cents"].(float64))
	if got != int64(c["revenue_cents"].(float64)) {
		t.Fatalf("hourly hour-0 revenue %d != heatmap cell revenue %v — the two panels "+
			"must bucket the same order the same way", got, c["revenue_cents"])
	}
}

// =========================================================================
// Table mix has to be able to sum to sales
// =========================================================================

// Take-away orders have no table, and retired tables still earned what they
// earned. Both used to vanish, so the column silently undercut the Dashboard's
// Sales on the same screen.
func TestTableMix_IncludesTakeawayAndRetiredTables(t *testing.T) {
	fx := newTenant(t)
	at := pastUTC(2)

	// On a live table.
	live := fx.seedTable("T1")
	rptSeedClosedOrderOnTable(fx, live, "OnTable", 1, 1000, at)
	// On a table that gets retired afterwards.
	gone := fx.seedTable("T2")
	rptSeedClosedOrderOnTable(fx, gone, "OnRetired", 1, 2000, at)
	fx.adminExec(`UPDATE service_tables SET deleted_at = now() WHERE id = $1`, gone)
	// Take-away: no table at all.
	rptSeedClosedOrder(fx, "TakeAway", 1, 4000, at)

	day := localDay(t, at)
	q := "range=custom&from=" + day + "&to=" + day

	m := callHandler(t, fx, GetTableMix, http.MethodGet, "/reports/table-mix", nil,
		withQuery(q)).expectStatus(http.StatusOK).json()
	rows, _ := m["rows"].([]any)

	var summed int64
	names := map[string]int64{}
	for _, raw := range rows {
		row := raw.(map[string]any)
		rev := int64(row["revenue_cents"].(float64))
		summed += rev
		names[row["name"].(string)] = rev
	}

	var dash ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&dash)

	if summed != dash.KPIs.SalesCents {
		t.Fatalf("table mix sums to %d but the Dashboard says %d sales for the same "+
			"window — rows: %v", summed, dash.KPIs.SalesCents, names)
	}
	if names["Take-away / walk-in"] != 4000 {
		t.Fatalf("take-away row = %d, want 4000", names["Take-away / walk-in"])
	}
	if names["Retired tables"] != 2000 {
		t.Fatalf("retired-tables row = %d, want 2000", names["Retired tables"])
	}
}

// =========================================================================
// Popular items: a 30-day figure that is actually 30 days
// =========================================================================

// The predicates lived in a LEFT JOIN, so they constrained nothing: qty_30d was
// all-time and counted open and cancelled orders.
func TestPopularItems_Qty30dRespectsWindowAndStatus(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("PopCat")
	item := fx.seedMenuItem(cat, "PopItem", 1000)

	// Recent closed sale: counts.
	recent := fx.seedOpenOrder(nil)
	fx.seedOrderItem(recent, item, 2, 1000)
	fx.closeOrderWithTotals(recent)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, recent, pastUTC(24))

	// Closed 90 days ago: outside the window.
	old := fx.seedOpenOrder(nil)
	fx.seedOrderItem(old, item, 50, 1000)
	fx.closeOrderWithTotals(old)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, old, pastUTC(24*90))

	// Still open, and cancelled: neither is a sale.
	stillOpen := fx.seedOpenOrder(nil)
	fx.seedOrderItem(stillOpen, item, 7, 1000)
	cancelled := fx.seedOpenOrder(nil)
	fx.seedOrderItem(cancelled, item, 9, 1000)
	fx.setOrderStatus(cancelled, "cancelled")

	m := callHandler(t, fx, ListPopularMenuItems, http.MethodGet, "/menu/popular", nil).
		expectStatus(http.StatusOK).json()
	items, _ := m["items"].([]any)
	found := false
	for _, raw := range items {
		row := raw.(map[string]any)
		if row["name"] != "PopItem" {
			continue
		}
		found = true
		if got := int(row["qty_30d"].(float64)); got != 2 {
			t.Fatalf("qty_30d = %d, want 2 — only the recent CLOSED sale counts", got)
		}
	}
	if !found {
		t.Fatal("PopItem missing from the popular list")
	}
}

// =========================================================================
// Discounts can't exceed the bill
// =========================================================================

// buildQuote clamps the taxable base at zero, so an oversized discount made the
// stored columns stop reconciling: subtotal − discount + service + tax no longer
// equalled total, and the History receipt's own rows didn't add up.
func TestApplyDiscount_CannotExceedTheBill(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("DiscCat")
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, fx.seedMenuItem(cat, "Plate", 1000), 1, 1000)

	callHandler(t, fx, ApplyOrderAdjustment(testHub()), http.MethodPost, "/",
		map[string]any{"type": "discount", "amount_cents": 1500, "reason": "too much"},
		withParam("id", order.String())).
		expectErr(http.StatusConflict, "discount_too_large")

	// Exactly the bill is allowed (a full comp).
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), http.MethodPost, "/",
		map[string]any{"type": "discount", "amount_cents": 1000, "reason": "comp"},
		withParam("id", order.String())).
		expectStatus(http.StatusCreated)

	// And a second discount on top is refused, because nothing is left.
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), http.MethodPost, "/",
		map[string]any{"type": "discount", "amount_cents": 1, "reason": "extra"},
		withParam("id", order.String())).
		expectErr(http.StatusConflict, "discount_too_large")

	// The stored columns reconcile: subtotal − discount + service (+tax) == total.
	fx.closeOrderWithTotals(order)
	var subtotal, discount, service, tax, total int64
	fx.adminScan([]any{&subtotal, &discount, &service, &tax, &total},
		`SELECT subtotal_cents, discount_cents, service_charge_cents, tax_cents, total_cents
		 FROM orders WHERE id = $1`, order)
	if base := subtotal - discount + service; total != base+0*tax && total != base {
		t.Fatalf("stored columns don't reconcile: %d − %d + %d != %d",
			subtotal, discount, service, total)
	}
}

// =========================================================================
// The daily series declares its own window
// =========================================================================

// Short presets pad the chart back ~14 days so it has bars. The FE then derived
// an "avg/day" from the padded array and showed it beside a KPI covering one day,
// with the bars visibly out-summing the Sales figure. The response now says what
// the series covers.
func TestDashboard_DailySeriesReportsItsWindow(t *testing.T) {
	fx := newTenant(t)
	var dash ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).decode(&dash)

	if !dash.DailyPadded {
		t.Fatal("range=today pads the chart to 14 days, so daily_padded must be true")
	}
	if !dash.DailyFrom.Before(dash.From) {
		t.Fatalf("daily_from %v should precede the KPI window start %v",
			dash.DailyFrom, dash.From)
	}

	// A custom range is charted exactly as picked, so it is not padded.
	day := localDay(t, time.Now().UTC())
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from="+day+"&to="+day)).
		expectStatus(http.StatusOK).decode(&dash)
	if dash.DailyPadded {
		t.Fatal("a custom range must be charted exactly as picked")
	}
	if !dash.DailyFrom.Equal(dash.From) {
		t.Fatalf("daily_from %v != window start %v for a custom range",
			dash.DailyFrom, dash.From)
	}
}

// range=all computed its day count from a zero-value `to` (read before it was
// assigned), so an all-time series was silently clamped to a 14-bar chart.
func TestResolveRange_AllSpansItsWholeHistory(t *testing.T) {
	fx := newTenant(t)
	var dash ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=all")).expectStatus(http.StatusOK).decode(&dash)

	if len(dash.Daily) < 100 {
		t.Fatalf("range=all produced %d daily points — an all-time series should span "+
			"years, not a padded fortnight", len(dash.Daily))
	}
}
