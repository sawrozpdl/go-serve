package api

// Integration tests for the reporting invariant behind the "credit settlement is
// counted as new sales" bug report:
//
//	A serve put on credit is sales EXACTLY ONCE, on the day it closes. When the
//	guest later pays the balance down, that money must raise the account/drawer
//	balances and appear as "credit collected" — and must not touch sales on any
//	day, must not create an order, and must not create a payments row.
//
// The tests below pin every leg of that statement so a future change to the
// reporting SQL can't quietly reintroduce double counting.

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// creditSaleOn seeds a CLOSED order settled entirely to a house tab at a given
// instant — the "day 1" leg of the invariant. (htSeedCharge leaves the order
// open, which can't drive a sales assertion.)
func creditSaleOn(fx *fixture, tabID uuid.UUID, amountCents int64, closedAt time.Time) uuid.UUID {
	fx.t.Helper()
	orderID := rptSeedClosedOrder(fx, "CreditItem-"+uuid.NewString()[:4], 1, amountCents, closedAt)
	payID := fx.seedPayment(orderID, "house_tab", amountCents, nil)
	// seedPayment doesn't expose house_tab_id — stamp it directly.
	fx.adminExec(`UPDATE payments SET house_tab_id = $2 WHERE id = $1`, payID, tabID)
	return orderID
}

// localDay renders an instant as the tenant-local YYYY-MM-DD the handlers window
// on. The harness pins every fixture tenant to Asia/Kathmandu.
func localDay(t *testing.T, at time.Time) string {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatalf("load tenant tz: %v", err)
	}
	return at.In(loc).Format("2006-01-02")
}

// The headline case: sell on credit a week ago, collect today. Sales must stay
// on the sale day and the collection must show up only as credit collected.
func TestCreditSettlement_NeverCountsAsSales(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Invariant", true)

	saleAt := pastUTC(24 * 7) // a week ago
	creditSaleOn(fx, tabID, 100000, saleAt)

	// Collect the full balance today, through the real handler so shift
	// stamping and the audit write run exactly as in production.
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 100000, "payment_method": "cash"},
		withParam("id", tabID.String())).
		expectStatus(http.StatusCreated)

	saleDay := localDay(t, saleAt)
	today := localDay(t, time.Now().UTC())

	// --- sale day: sales recognised, nothing collected ---
	m := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from="+saleDay+"&to="+saleDay)).
		expectStatus(http.StatusOK).json()
	kpis := m["kpis"].(map[string]any)
	if got := int64(kpis["sales_cents"].(float64)); got != 100000 {
		t.Fatalf("sale day sales_cents = %d, want 100000", got)
	}
	if got := int64(kpis["tab_cents"].(float64)); got != 100000 {
		t.Fatalf("sale day tab_cents = %d, want 100000 (it was charged to credit)", got)
	}
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 0 {
		t.Fatalf("sale day credit_collected_cents = %d, want 0 — nothing was paid that day", got)
	}

	// --- collection day: no sales, credit collected ---
	m = callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).
		expectStatus(http.StatusOK).json()
	kpis = m["kpis"].(map[string]any)
	if got := int64(kpis["sales_cents"].(float64)); got != 0 {
		t.Fatalf("collection day sales_cents = %d, want 0 — the settlement is NOT a sale", got)
	}
	if got := int(kpis["order_count"].(float64)); got != 0 {
		t.Fatalf("collection day order_count = %d, want 0", got)
	}
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 100000 {
		t.Fatalf("collection day credit_collected_cents = %d, want 100000", got)
	}
	if got := int64(kpis["net_cents"].(float64)); got != 0 {
		t.Fatalf("collection day net_cents = %d, want 0 — collections don't enter net", got)
	}

	// --- history: the collection day lists no serve but does report the money ---
	h := callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date="+today)).
		expectStatus(http.StatusOK).json()
	if orders, _ := h["orders"].([]any); len(orders) != 0 {
		t.Fatalf("history orders on collection day = %d, want 0", len(orders))
	}
	cols, _ := h["credit_collections"].([]any)
	if len(cols) != 1 {
		t.Fatalf("history credit_collections = %d, want 1", len(cols))
	}
	col := cols[0].(map[string]any)
	if got := int64(col["amount_cents"].(float64)); got != 100000 {
		t.Fatalf("collection amount = %d, want 100000", got)
	}
	if col["house_tab_name"] != "Invariant" {
		t.Fatalf("collection house_tab_name = %v, want Invariant", col["house_tab_name"])
	}

	// The sale day shows the serve and no collection.
	h = callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date="+saleDay)).
		expectStatus(http.StatusOK).json()
	if orders, _ := h["orders"].([]any); len(orders) != 1 {
		t.Fatalf("history orders on sale day = %d, want 1", len(orders))
	}
	if cols, _ := h["credit_collections"].([]any); len(cols) != 0 {
		t.Fatalf("history credit_collections on sale day = %d, want 0", len(cols))
	}

	// --- the money landed, split honestly ---
	b := callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json()
	cash := accountByMethod(b, "cash")
	if got := int64(cash["payments_cents"].(float64)); got != 0 {
		t.Fatalf("cash payments_cents = %d, want 0 (no cash sale happened)", got)
	}
	if got := int64(cash["credit_collected_cents"].(float64)); got != 100000 {
		t.Fatalf("cash credit_collected_cents = %d, want 100000", got)
	}
	if got := int64(cash["balance_cents"].(float64)); got != 100000 {
		t.Fatalf("cash balance_cents = %d, want 100000", got)
	}

	// --- the tab is square, and nothing synthetic was created ---
	d := callHandler(t, fx, GetHouseTab, http.MethodGet, "/", nil,
		withParam("id", tabID.String())).
		expectStatus(http.StatusOK).json()
	tab := d["house_tab"].(map[string]any)
	if got := int64(tab["balance_cents"].(float64)); got != 0 {
		t.Fatalf("tab balance_cents = %d, want 0", got)
	}
	if got := int64(tab["charged_cents"].(float64)); got != 100000 {
		t.Fatalf("tab charged_cents = %d, want 100000", got)
	}
	if got := int64(tab["settled_cents"].(float64)); got != 100000 {
		t.Fatalf("tab settled_cents = %d, want 100000", got)
	}
	if n := fx.countRows("orders"); n != 1 {
		t.Fatalf("orders = %d, want 1 — the settlement must not create an order", n)
	}
	if n := fx.countRows("payments"); n != 1 {
		t.Fatalf("payments = %d, want 1 — the settlement must not create a payment", n)
	}
}

// Collections are windowed on recorded_at, so a settlement recorded yesterday
// must not show up in today's figure (and vice versa).
func TestCreditCollected_WindowedOnRecordedAt(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Windowed", true)
	creditSaleOn(fx, tabID, 8000, pastUTC(24*10))

	yesterday := pastUTC(30) // > 24h ago, so a different tenant-local day
	htSeedSettlement(fx, tabID, "cash", 3000, nil)
	fx.adminExec(`UPDATE house_tab_settlements SET recorded_at = $2 WHERE house_tab_id = $1`,
		tabID, yesterday)
	htSeedSettlement(fx, tabID, "other", 2000, nil) // today

	m := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).
		expectStatus(http.StatusOK).json()
	kpis := m["kpis"].(map[string]any)
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 2000 {
		t.Fatalf("today credit_collected_cents = %d, want 2000 (yesterday's 3000 excluded)", got)
	}

	yDay := localDay(t, yesterday)
	m = callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from="+yDay+"&to="+yDay)).
		expectStatus(http.StatusOK).json()
	kpis = m["kpis"].(map[string]any)
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 3000 {
		t.Fatalf("yesterday credit_collected_cents = %d, want 3000", got)
	}
}

// Every settlement channel counts toward the figure, including the legacy enum
// values that predate the online consolidation.
func TestCreditCollected_CountsEveryChannel(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Channels", true)
	creditSaleOn(fx, tabID, 50000, pastUTC(24*3))

	for _, method := range []string{"cash", "bank", "other", "esewa", "khalti", "card"} {
		htSeedSettlement(fx, tabID, method, 1000, nil)
	}

	m := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).
		expectStatus(http.StatusOK).json()
	kpis := m["kpis"].(map[string]any)
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 6000 {
		t.Fatalf("credit_collected_cents = %d, want 6000 (all six channels)", got)
	}
	if got := int64(kpis["sales_cents"].(float64)); got != 0 {
		t.Fatalf("sales_cents = %d, want 0 — no serve closed today", got)
	}
}

// =========================================================================
// credit_collected_breakdown — who paid
// =========================================================================

// creditRowsByName indexes the dashboard's credit_collected_breakdown by tab
// name so assertions read as "what did Ramesh pay" rather than by array index
// (the array is ordered by amount, which shifts as fixtures change).
func creditRowsByName(t *testing.T, dash map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	rows, ok := dash["credit_collected_breakdown"].([]any)
	if !ok {
		t.Fatalf("credit_collected_breakdown missing or not an array: %#v", dash["credit_collected_breakdown"])
	}
	for _, r := range rows {
		row := r.(map[string]any)
		out[row["name"].(string)] = row
	}
	return out
}

// The headline: the breakdown names each payer, and the rows sum EXACTLY to the
// KPI scalar. The two are computed by separate queries, so a divergence here is
// the drill-down lying about a number shown right above it.
func TestCreditCollectedBreakdown_NamesPayersAndSumsToKPI(t *testing.T) {
	fx := newTenant(t)
	ramesh := fx.seedHouseTab("Ramesh", true)
	sita := fx.seedHouseTab("Sita", true)
	creditSaleOn(fx, ramesh, 80000, pastUTC(24*5))
	creditSaleOn(fx, sita, 40000, pastUTC(24*5))

	// Ramesh pays in two instalments today; Sita in one.
	htSeedSettlement(fx, ramesh, "cash", 30000, nil)
	htSeedSettlement(fx, ramesh, "bank", 20000, nil)
	htSeedSettlement(fx, sita, "cash", 15000, nil)

	dash := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).json()

	kpis := dash["kpis"].(map[string]any)
	total := int64(kpis["credit_collected_cents"].(float64))
	if total != 65000 {
		t.Fatalf("credit_collected_cents = %d, want 65000", total)
	}

	rows := creditRowsByName(t, dash)
	if len(rows) != 2 {
		t.Fatalf("breakdown rows = %d, want 2 (Ramesh, Sita): %#v", len(rows), rows)
	}

	r, ok := rows["Ramesh"]
	if !ok {
		t.Fatal("Ramesh missing from the breakdown")
	}
	if got := int64(r["amount_cents"].(float64)); got != 50000 {
		t.Errorf("Ramesh amount_cents = %d, want 50000 (30000 + 20000 across channels)", got)
	}
	// Two instalments must report as two, or "collected 50000" reads as one
	// payment and the owner can't reconcile against the drawer.
	if got := int(r["count"].(float64)); got != 2 {
		t.Errorf("Ramesh count = %d, want 2", got)
	}

	s, ok := rows["Sita"]
	if !ok {
		t.Fatal("Sita missing from the breakdown")
	}
	if got := int64(s["amount_cents"].(float64)); got != 15000 {
		t.Errorf("Sita amount_cents = %d, want 15000", got)
	}
	if got := int(s["count"].(float64)); got != 1 {
		t.Errorf("Sita count = %d, want 1", got)
	}

	// The invariant that matters: rows must account for the whole KPI.
	var sum int64
	for _, row := range rows {
		sum += int64(row["amount_cents"].(float64))
	}
	if sum != total {
		t.Fatalf("breakdown rows sum to %d but the KPI says %d — the drill-down contradicts the headline", sum, total)
	}
}

// A reversed collection must vanish from the breakdown, not just from the
// scalar. Both filter reversed_at, and this pins that they stay in step.
func TestCreditCollectedBreakdown_ExcludesReversed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Refunded", true)
	creditSaleOn(fx, tabID, 20000, pastUTC(24*3))
	htSeedSettlement(fx, tabID, "cash", 5000, nil) // survives
	drop := htSeedSettlement(fx, tabID, "cash", 7000, nil)

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "posted to the wrong tab"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": drop.String()})).
		expectStatus(http.StatusOK)

	dash := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).json()
	kpis := dash["kpis"].(map[string]any)
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 5000 {
		t.Fatalf("credit_collected_cents = %d, want 5000 (7000 was reversed)", got)
	}
	rows := creditRowsByName(t, dash)
	row, ok := rows["Refunded"]
	if !ok {
		t.Fatal("Refunded missing from the breakdown — the surviving 5000 collection should still be listed")
	}
	if got := int64(row["amount_cents"].(float64)); got != 5000 {
		t.Errorf("breakdown amount_cents = %d, want 5000 — the reversed settlement is still counted", got)
	}
	if got := int(row["count"].(float64)); got != 1 {
		t.Errorf("breakdown count = %d, want 1 — the reversed settlement is still counted", got)
	}
}

// A tab whose ONLY collection was reversed drops out entirely rather than
// lingering as a zero row.
func TestCreditCollectedBreakdown_FullyReversedTabDisappears(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("AllReversed", true)
	creditSaleOn(fx, tabID, 20000, pastUTC(24*3))
	setID := htSeedSettlement(fx, tabID, "cash", 9000, nil)

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "duplicate entry"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": setID.String()})).
		expectStatus(http.StatusOK)

	dash := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).json()
	if rows := creditRowsByName(t, dash); len(rows) != 0 {
		t.Fatalf("breakdown rows = %d, want 0 — a fully reversed tab must not appear: %#v", len(rows), rows)
	}
}

// The breakdown is always an array, never JSON null, so clients can map over it
// without a guard.
func TestCreditCollectedBreakdown_EmptyIsArrayNotNull(t *testing.T) {
	fx := newTenant(t)
	dash := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).json()
	rows, ok := dash["credit_collected_breakdown"].([]any)
	if !ok {
		t.Fatalf("credit_collected_breakdown = %#v, want [] for a tenant with no collections", dash["credit_collected_breakdown"])
	}
	if len(rows) != 0 {
		t.Fatalf("credit_collected_breakdown = %#v, want empty", rows)
	}
}

// History's credit_collections list must exclude reversed collections the same
// way every other settlement query does. It didn't: the day list kept showing a
// reversed collection and its day total diverged from the dashboard KPI.
func TestHistoryCreditCollections_ExcludeReversed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("HistReverse", true)
	creditSaleOn(fx, tabID, 20000, pastUTC(24*3))
	setID := htSeedSettlement(fx, tabID, "cash", 6000, nil)
	today := localDay(t, time.Now().UTC())

	h := callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date="+today)).expectStatus(http.StatusOK).json()
	if cols, _ := h["credit_collections"].([]any); len(cols) != 1 {
		t.Fatalf("credit_collections before reversing = %d, want 1", len(cols))
	}

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "keyed twice"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": setID.String()})).
		expectStatus(http.StatusOK)

	h = callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date="+today)).expectStatus(http.StatusOK).json()
	cols, _ := h["credit_collections"].([]any)
	if len(cols) != 0 {
		t.Fatalf("credit_collections after reversing = %d, want 0 — History still lists a reversed collection, so its day total out-sums the dashboard", len(cols))
	}
}
