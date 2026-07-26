package api

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Report-export completeness.
//
// The PDF export is only as honest as the endpoints behind it. Before this,
// ListExpenses was a hardcoded `LIMIT 200` with no offset — row 201 was
// unreachable, so a busy month exported a silent subset. These tests pin the
// three properties the report depends on:
//
//   1. a caller can page an endpoint to completion, with no gaps or duplicates;
//   2. `total` reports the full filtered count, so the document can state what
//      it is omitting when it prints a bounded subset;
//   3. the order log covers a whole span in one request.
// =========================================================================

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// expIDsFrom pulls the expense ids out of a ListExpenses response, in order.
func expIDsFrom(t *testing.T, r map[string]any) []string {
	t.Helper()
	raw, ok := r["expenses"].([]any)
	if !ok {
		t.Fatalf("response has no expenses array: %#v", r)
	}
	out := make([]string, 0, len(raw))
	for _, e := range raw {
		m, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("expense row is not an object: %#v", e)
		}
		id, _ := m["id"].(string)
		out = append(out, id)
	}
	return out
}

func totalFrom(t *testing.T, r map[string]any) int {
	t.Helper()
	v, ok := r["total"].(float64)
	if !ok {
		t.Fatalf("response has no numeric total: %#v", r["total"])
	}
	return int(v)
}

// ---------------------------------------------------------------------------
// ListExpenses paging
// ---------------------------------------------------------------------------

func TestListExpenses_ReportsTotalIndependentOfLimit(t *testing.T) {
	fx := newTenant(t)
	for i := range 5 {
		fx.expSeedExpense(fmt.Sprintf("Vendor %d", i), int64(1000+i), nil)
	}

	r := callHandler(t, fx, ListExpenses, "GET", "/?limit=2", nil).
		expectStatus(200).json()

	if got := len(expIDsFrom(t, r)); got != 2 {
		t.Fatalf("rows = %d, want 2 (the requested page size)", got)
	}
	// The whole point: the caller can tell there is more than it received.
	if got := totalFrom(t, r); got != 5 {
		t.Fatalf("total = %d, want 5 (the full filtered count)", got)
	}
}

func TestListExpenses_PagesToCompletionWithoutGapsOrDuplicates(t *testing.T) {
	fx := newTenant(t)
	const n = 7
	// Distinct paid_at values so the ORDER BY is deterministic and a dropped or
	// repeated row is unambiguous rather than a tie-break artifact.
	base := time.Now().Add(-24 * time.Hour)
	for i := range n {
		fx.expSeedExpensePaidAt(fmt.Sprintf("Vendor %d", i), int64(1000+i),
			base.Add(time.Duration(i)*time.Minute))
	}

	seen := []string{}
	for offset := 0; offset < n; offset += 3 {
		r := callHandler(t, fx, ListExpenses, "GET",
			fmt.Sprintf("/?limit=3&offset=%d", offset), nil).expectStatus(200).json()
		if got := totalFrom(t, r); got != n {
			t.Fatalf("total = %d at offset %d, want %d", got, offset, n)
		}
		seen = append(seen, expIDsFrom(t, r)...)
	}

	if len(seen) != n {
		t.Fatalf("paged %d rows, want %d", len(seen), n)
	}
	uniq := map[string]bool{}
	for _, id := range seen {
		if uniq[id] {
			t.Fatalf("row %s returned twice across pages", id)
		}
		uniq[id] = true
	}
}

func TestListExpenses_TotalRespectsFilters(t *testing.T) {
	fx := newTenant(t)
	catA := fx.expSeedCategory("A")
	catB := fx.expSeedCategory("B")
	fx.expSeedExpense("a1", 1000, &catA)
	fx.expSeedExpense("a2", 1000, &catA)
	fx.expSeedExpense("b1", 1000, &catB)

	r := callHandler(t, fx, ListExpenses, "GET",
		"/?expense_category_id="+catA.String(), nil).expectStatus(200).json()

	// A total that ignored the filter would make the report's "showing N of M"
	// line a lie in the other direction.
	if got := totalFrom(t, r); got != 2 {
		t.Fatalf("total = %d, want 2 (only category A)", got)
	}
}

func TestListExpenses_TotalExcludesSoftDeleted(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("live", 1000, nil)
	gone := fx.expSeedExpense("gone", 1000, nil)
	fx.adminExec(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, gone)

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).expectStatus(200).json()
	if got := totalFrom(t, r); got != 1 {
		t.Fatalf("total = %d, want 1", got)
	}
}

func TestListExpenses_TotalIsTenantScoped(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.expSeedExpense("fx1", 1000, nil)
	fx1.expSeedExpense("fx1-again", 1000, nil)

	r := callHandler(t, fx2, ListExpenses, "GET", "/", nil).expectStatus(200).json()
	// The count runs as its own query; if it escaped RLS it would leak the other
	// tenant's row volume even though the rows themselves stayed hidden.
	if got := totalFrom(t, r); got != 0 {
		t.Fatalf("total = %d, want 0 — count leaked across tenants", got)
	}
}

func TestListExpenses_ClampsAbsurdLimitInsteadOfFailing(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("only", 1000, nil)

	// Far above maxExpensePage. The request must succeed, clamped — a report
	// asking for "everything" should not 400.
	r := callHandler(t, fx, ListExpenses, "GET", "/?limit=999999", nil).
		expectStatus(200).json()
	if got := len(expIDsFrom(t, r)); got != 1 {
		t.Fatalf("rows = %d, want 1", got)
	}
}

func TestListExpenses_TreatsJunkPagingAsDefaults(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("only", 1000, nil)

	for _, qs := range []string{"/?limit=abc", "/?limit=0", "/?limit=-5", "/?offset=-1", "/?offset=xyz"} {
		r := callHandler(t, fx, ListExpenses, "GET", qs, nil).expectStatus(200).json()
		if got := totalFrom(t, r); got != 1 {
			t.Fatalf("%s: total = %d, want 1", qs, got)
		}
	}
}

// ---------------------------------------------------------------------------
// GetOrderHistory over a span
// ---------------------------------------------------------------------------

// histSeedClosedOrderOn closes an order stamped on a given tenant-local day.
func (fx *fixture) histSeedClosedOrderOn(menuItem uuid.UUID, day string, priceCents int64) uuid.UUID {
	fx.t.Helper()
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, menuItem, 1, priceCents)
	fx.closeOrderWithTotals(orderID)
	// Pin closed_at to local noon on `day` so it lands unambiguously inside that
	// tenant-local date whatever the server timezone is.
	fx.adminExec(`
		UPDATE orders
		SET closed_at = ($2::date + time '12:00')::timestamp
		              AT TIME ZONE (SELECT COALESCE(NULLIF(timezone,''),'Asia/Kathmandu')
		                            FROM tenants WHERE id = $3)
		WHERE id = $1`, orderID, day, fx.Tenant)
	return orderID
}

func historyOrderCount(t *testing.T, r map[string]any) int {
	t.Helper()
	raw, ok := r["orders"].([]any)
	if !ok {
		t.Fatalf("response has no orders array: %#v", r)
	}
	return len(raw)
}

func TestGetOrderHistory_SpanCoversEveryDayInclusive(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Americano", 20000)

	fx.histSeedClosedOrderOn(item, "2026-06-01", 20000)
	fx.histSeedClosedOrderOn(item, "2026-06-02", 20000)
	fx.histSeedClosedOrderOn(item, "2026-06-03", 20000)

	r := callHandler(t, fx, GetOrderHistory, "GET",
		"/?from=2026-06-01&to=2026-06-03", nil).expectStatus(200).json()

	// Both endpoints inclusive — an exclusive `to` would silently drop the last
	// day of every month-long export.
	if got := historyOrderCount(t, r); got != 3 {
		t.Fatalf("orders = %d, want 3 across the inclusive span", got)
	}
	if r["from"] != "2026-06-01" || r["to"] != "2026-06-03" {
		t.Fatalf("echoed window = %v..%v, want 2026-06-01..2026-06-03", r["from"], r["to"])
	}
}

func TestGetOrderHistory_SpanExcludesDaysOutsideIt(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Americano", 20000)

	fx.histSeedClosedOrderOn(item, "2026-06-01", 20000)
	fx.histSeedClosedOrderOn(item, "2026-06-05", 20000)

	r := callHandler(t, fx, GetOrderHistory, "GET",
		"/?from=2026-06-02&to=2026-06-04", nil).expectStatus(200).json()
	if got := historyOrderCount(t, r); got != 0 {
		t.Fatalf("orders = %d, want 0 — span leaked neighbouring days", got)
	}
}

func TestGetOrderHistory_SpanEqualsSumOfItsDays(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Americano", 20000)

	days := []string{"2026-06-10", "2026-06-11", "2026-06-12"}
	fx.histSeedClosedOrderOn(item, days[0], 20000)
	fx.histSeedClosedOrderOn(item, days[1], 20000)
	fx.histSeedClosedOrderOn(item, days[1], 30000)
	fx.histSeedClosedOrderOn(item, days[2], 20000)

	perDay := 0
	for _, d := range days {
		r := callHandler(t, fx, GetOrderHistory, "GET", "/?date="+d, nil).
			expectStatus(200).json()
		perDay += historyOrderCount(t, r)
	}

	span := callHandler(t, fx, GetOrderHistory, "GET",
		fmt.Sprintf("/?from=%s&to=%s", days[0], days[2]), nil).expectStatus(200).json()

	// The span is the report path, the per-day call is the History screen's. If
	// they disagree, the PDF and the screen disagree.
	if got := historyOrderCount(t, span); got != perDay {
		t.Fatalf("span returned %d orders, per-day calls summed to %d", got, perDay)
	}
}

func TestGetOrderHistory_SingleDayStillWorks(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Americano", 20000)
	fx.histSeedClosedOrderOn(item, "2026-06-01", 20000)

	r := callHandler(t, fx, GetOrderHistory, "GET", "/?date=2026-06-01", nil).
		expectStatus(200).json()
	if got := historyOrderCount(t, r); got != 1 {
		t.Fatalf("orders = %d, want 1", got)
	}
	// The single-day form collapses to a span of one, and says so.
	if r["from"] != "2026-06-01" || r["to"] != "2026-06-01" {
		t.Fatalf("echoed window = %v..%v, want both 2026-06-01", r["from"], r["to"])
	}
}

func TestGetOrderHistory_RejectsHalfOpenAndReversedSpans(t *testing.T) {
	fx := newTenant(t)
	cases := map[string]string{
		"from without to": "/?from=2026-06-01",
		"to without from": "/?to=2026-06-01",
		"reversed span":   "/?from=2026-06-05&to=2026-06-01",
		"malformed from":  "/?from=06-2026&to=2026-06-01",
		"malformed to":    "/?from=2026-06-01&to=next-tuesday",
	}
	for name, qs := range cases {
		t.Run(name, func(t *testing.T) {
			callHandler(t, fx, GetOrderHistory, "GET", qs, nil).expectStatus(400)
		})
	}
}

// ---------------------------------------------------------------------------
// GetShiftSummary
// ---------------------------------------------------------------------------

func TestGetShiftSummary_OpenShiftReportsLiveExpectedCash(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Americano", 20000)
	shift := fx.seedOpenShift(500_00)

	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, item, 1, 20000)
	fx.closeOrderWithTotals(orderID)
	fx.seedPayment(orderID, "cash", 200_00, &shift)

	r := callHandler(t, fx, GetShiftSummary, "GET", "/", nil,
		withParam("id", shift.String())).expectStatus(200).json()

	if open, _ := r["is_open"].(bool); !open {
		t.Fatalf("is_open = false, want true for a running shift")
	}
	// Live expected = opening float + cash in. Nothing counted yet, so variance
	// must stay 0 rather than reading as a 500-rupee overage.
	if got := r["expected_cash_cents"].(float64); got != 700_00 {
		t.Fatalf("expected_cash_cents = %v, want 70000", got)
	}
	if got := r["closing_count_cents"].(float64); got != 0 {
		t.Fatalf("closing_count_cents = %v, want 0 while open", got)
	}
	if got := r["variance_cents"].(float64); got != 0 {
		t.Fatalf("variance_cents = %v, want 0 while open", got)
	}
}

func TestGetShiftSummary_ClosedShiftReportsTheCountedFigures(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(500_00)
	// A close that was counted 50 short of expectation.
	fx.adminExec(`
		UPDATE shifts
		SET closed_at = now(), closed_by_user_id = $2,
		    closing_count_cents = $3, expected_cash_cents = $4, variance_cents = $5
		WHERE id = $1`, shift, fx.User, 650_00, 700_00, -50_00)

	r := callHandler(t, fx, GetShiftSummary, "GET", "/", nil,
		withParam("id", shift.String())).expectStatus(200).json()

	if open, _ := r["is_open"].(bool); open {
		t.Fatalf("is_open = true, want false for a closed shift")
	}
	// These must come back as recorded at close. Recomputing them would let a
	// late-recorded payment rewrite the variance the closer signed off on.
	if got := r["closing_count_cents"].(float64); got != 650_00 {
		t.Fatalf("closing_count_cents = %v, want 65000", got)
	}
	if got := r["expected_cash_cents"].(float64); got != 700_00 {
		t.Fatalf("expected_cash_cents = %v, want 70000 (persisted)", got)
	}
	if got := r["variance_cents"].(float64); got != -50_00 {
		t.Fatalf("variance_cents = %v, want -5000", got)
	}
}

func TestGetShiftSummary_SeparatesCreditCollectedFromSales(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Americano", 20000)
	shift := fx.seedOpenShift(0)
	tab := fx.seedHouseTab("Regulars", true)

	// A cash sale this shift...
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, item, 1, 20000)
	fx.closeOrderWithTotals(orderID)
	fx.seedPayment(orderID, "cash", 200_00, &shift)

	// ...plus a customer clearing an EARLIER credit balance in cash.
	fx.adminExec(`
		INSERT INTO house_tab_settlements
		  (tenant_id, house_tab_id, shift_id, payment_method, amount_cents, recorded_by_user_id)
		VALUES ($1, $2, $3, 'cash'::payment_method, $4, $5)`,
		fx.Tenant, tab, shift, 300_00, fx.User)

	r := callHandler(t, fx, GetShiftSummary, "GET", "/", nil,
		withParam("id", shift.String())).expectStatus(200).json()

	// Billed sales is Σ total_cents, which always contains VAT (money.go), so
	// read it off the order rather than hardcoding the fixture's VAT rate.
	var orderTotal int64
	fx.adminScan([]any{&orderTotal},
		`SELECT total_cents FROM orders WHERE id = $1`, orderID)

	// Credit collected pays down a sale recognised earlier. It belongs in the
	// drawer but must never inflate the shift's sales — that mislabelling was a
	// real reported bug (see money.go's vocabulary).
	if got := r["credit_settled_cash_cents"].(float64); got != 300_00 {
		t.Fatalf("credit_settled_cash_cents = %v, want 30000", got)
	}
	if got := int64(r["billed_sales_cents"].(float64)); got != orderTotal {
		t.Fatalf("billed_sales_cents = %d, want %d (the order total) — "+
			"credit collected leaked into sales", got, orderTotal)
	}
	// Both still have to reach the drawer.
	if got := r["expected_cash_cents"].(float64); got != 500_00 {
		t.Fatalf("expected_cash_cents = %v, want 50000 (sale + credit collected)", got)
	}
}

func TestGetShiftSummary_UnknownShiftIs404(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetShiftSummary, "GET", "/", nil,
		withParam("id", uuid.NewString())).expectStatus(404)
}

func TestGetShiftSummary_RejectsMalformedID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetShiftSummary, "GET", "/", nil,
		withParam("id", "not-a-uuid")).expectStatus(400)
}

func TestGetShiftSummary_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	shift := fx1.seedOpenShift(100_00)

	// RLS scopes the lookup, so another tenant's shift is simply absent — not
	// readable, and not distinguishable from a nonexistent id.
	callHandler(t, fx2, GetShiftSummary, "GET", "/", nil,
		withParam("id", shift.String())).expectStatus(404)
}
