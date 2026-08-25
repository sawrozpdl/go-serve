package api

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/insight"
)

// insight.Gather is the one file in that package that touches SQL, and every
// query in it relies on RLS rather than a tenant_id predicate — there is not a
// single `tenant_id = $n` in the whole file. That design is only safe if it is
// proven against the real runtime role, so these tests seed through the
// superuser pool and READ through the app pool, the same two-pool split
// test/tenant_isolation_test.go uses.
//
// It lives in this package rather than internal/insight because all the café
// seeding machinery (newTenant, seedOrderItem, closeOrderWithTotals) is here.

// gatherAsApp runs insight.Gather as app_user with the fixture's tenant context.
func gatherAsApp(t *testing.T, fx *fixture, now time.Time) insight.Inputs {
	t.Helper()
	var in insight.Inputs
	err := fx.appTx(func(tx pgx.Tx) error {
		var err error
		in, err = insight.Gather(context.Background(), tx, now, "Asia/Kathmandu")
		return err
	})
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	return in
}

// A café with nothing in it must gather cleanly and produce no findings. This is
// the property that keeps a brand-new café from being emailed a list of things
// it has failed to do, and it also proves every GRANT the package needs is in
// place — a missing one fails here and nowhere else.
func TestInsightGather_EmptyTenantIsSilent(t *testing.T) {
	fx := newTenant(t)
	now := time.Now()

	in := gatherAsApp(t, fx, now)

	if in.Window.RevenueCents != 0 || in.Window.OrderCount != 0 {
		t.Errorf("empty café reported revenue %d over %d orders",
			in.Window.RevenueCents, in.Window.OrderCount)
	}
	if _, ok := in.CostCoverage.Ratio(); ok {
		t.Error("no sales must mean no cost-coverage ratio, not a zero one")
	}
	if _, ok := in.BooksConfidence(); ok {
		t.Error("a café with nothing recorded has no confidence figure")
	}
	if got := insight.RunAll(now, in); len(got) != 0 {
		for _, f := range got {
			t.Logf("unexpected: [%s] %s — %s", f.Severity, f.DetectorKey, f.Detail)
		}
		t.Fatalf("empty café produced %d findings, want 0", len(got))
	}
}

// Revenue must be NET REVENUE on closed orders — the same basis money.go defines
// and the dashboard shows. If this drifts, findings start quoting numbers the
// screen they link to contradicts.
func TestInsightGather_RevenueUsesNetRevenueBasis(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("GatherCat")
	item := fx.seedMenuItem(cat, "GatherItem", 10_000)

	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 10_000)
	fx.seedPayment(order, "cash", 20_000, nil)
	fx.closeOrderWithTotals(order)

	var total, tax int64
	fx.adminScan([]any{&total, &tax},
		`SELECT total_cents, tax_cents FROM orders WHERE id = $1`, order)

	in := gatherAsApp(t, fx, time.Now().Add(24*time.Hour)) // tomorrow, so today's order is a complete day

	if want := total - tax; in.Window.RevenueCents != want {
		t.Errorf("revenue = %d, want total(%d) - tax(%d) = %d",
			in.Window.RevenueCents, total, tax, want)
	}
	if in.Window.OrderCount != 1 {
		t.Errorf("order count = %d, want 1", in.Window.OrderCount)
	}
	if in.Window.LineCount != 1 {
		t.Errorf("line count = %d, want 1", in.Window.LineCount)
	}
}

// An item with no cost recorded reports as pure profit, so coverage is what
// decides whether any margin figure can be believed at all.
func TestInsightGather_CostCoverageSeesMissingCosts(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("CoverCat")
	withCost := fx.seedMenuItem(cat, "HasCost", 10_000)
	noCost := fx.seedMenuItem(cat, "NoCost", 10_000)
	fx.adminExec(`UPDATE menu_items SET cost_cents = 4000 WHERE id = $1`, withCost)

	order := fx.seedOpenOrder(nil)
	// seedOrderItem does not copy cost, so set the line's snapshot directly —
	// that snapshot is what every report reads.
	l1 := fx.seedOrderItem(order, withCost, 1, 10_000)
	fx.seedOrderItem(order, noCost, 1, 10_000)
	fx.adminExec(`UPDATE order_items SET unit_cost_cents = 4000 WHERE id = $1`, l1)
	fx.seedPayment(order, "cash", 20_000, nil)
	fx.closeOrderWithTotals(order)

	in := gatherAsApp(t, fx, time.Now().Add(24*time.Hour))

	ratio, ok := in.CostCoverage.Ratio()
	if !ok {
		t.Fatal("expected a coverage ratio")
	}
	if ratio != 0.5 {
		t.Errorf("coverage = %v, want 0.5 (one of two equally priced lines has a cost)", ratio)
	}
}

// Voided lines must not count as revenue, but must be visible as voids. Getting
// this backwards would either inflate sales or hide the leakage signal.
func TestInsightGather_VoidsAreExcludedFromSalesAndCountedAsVoids(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("VoidCat")
	item := fx.seedMenuItem(cat, "VoidItem", 5_000)

	order := fx.seedOpenOrder(nil)
	kept := fx.seedOrderItem(order, item, 1, 5_000)
	voided := fx.seedOrderItem(order, item, 1, 5_000)
	fx.adminExec(`UPDATE order_items SET voided_at = now(), voided_by_user_id = $2 WHERE id = $1`,
		voided, fx.User)
	_ = kept
	fx.seedPayment(order, "cash", 5_000, nil)
	fx.closeOrderWithTotals(order)

	in := gatherAsApp(t, fx, time.Now().Add(24*time.Hour))

	if in.Window.LineCount != 1 {
		t.Errorf("line count = %d, want 1 — the voided line must not be counted as sold", in.Window.LineCount)
	}
	if in.Voids.Count != 1 {
		t.Errorf("voids = %d, want 1", in.Voids.Count)
	}
	if in.Voids.ValueCents != 5_000 {
		t.Errorf("void value = %d, want 5000", in.Voids.ValueCents)
	}
	if len(in.Voids.Actors) != 1 || in.Voids.Actors[0].UserID != fx.User {
		t.Errorf("void must be attributed to the acting user, got %+v", in.Voids.Actors)
	}
}

// The payoff from migration 0067: a payment entered and removed before the bill
// closed used to leave no trace anywhere. Now it is a detectable act.
func TestInsightGather_SeesRetractedPayments(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	pay := fx.seedPayment(order, "cash", 7_500, nil)

	// Through the real handler, so the trigger fires exactly as it does in prod.
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": pay.String()})).
		expectStatus(204)

	in := gatherAsApp(t, fx, time.Now().Add(24*time.Hour))

	if in.Retractions.Count != 1 {
		t.Fatalf("retractions = %d, want 1", in.Retractions.Count)
	}
	if in.Retractions.ValueCents != 7_500 {
		t.Errorf("retracted value = %d, want 7500", in.Retractions.ValueCents)
	}
	if len(in.Retractions.Actors) != 1 || in.Retractions.Actors[0].UserID != fx.User {
		t.Errorf("retraction must name who did it, got %+v", in.Retractions.Actors)
	}
}

// tenant_integrity_check() is deliberately NOT security-definer, so it must
// return this café's rows and nothing else purely by RLS.
func TestInsightGather_IntegrityCheckIsTenantScoped(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("IntegCat")
	item := fx.seedMenuItem(cat, "IntegItem", 10_000)
	fx.seedOrderItem(order, item, 1, 10_000)
	pay := fx.seedPayment(order, "cash", 10_000, nil)
	fx.closeOrderWithTotals(order)

	// closeOrderWithTotals applies the tenant's service charge and VAT, so the
	// frozen total is not the line subtotal. Settle the payment against the real
	// total first, and assert the invariant is CLEAN — otherwise the tamper below
	// would be measured against an already-broken baseline and the delta would be
	// whatever the tax happened to be.
	var total int64
	fx.adminScan([]any{&total}, `SELECT total_cents FROM orders WHERE id = $1`, order)
	fx.adminExec(`UPDATE payments SET amount_cents = $2 WHERE id = $1`, pay, total)

	clean := gatherAsApp(t, fx, time.Now().Add(24*time.Hour))
	for _, v := range clean.Integrity {
		if v.CheckKey == "payments_vs_total" && v.EntityID == order {
			t.Fatalf("a correctly settled order must not violate payments_vs_total (delta %d)", v.DeltaCents)
		}
	}

	// Now break it, by exactly a known amount.
	fx.adminExec(`UPDATE orders SET total_cents = total_cents + 500 WHERE id = $1`, order)

	in := gatherAsApp(t, fx, time.Now().Add(24*time.Hour))

	found := false
	for _, v := range in.Integrity {
		if v.CheckKey == "payments_vs_total" && v.EntityID == order {
			found = true
			if v.DeltaCents != -500 {
				t.Errorf("delta = %d, want -500 (paid 500 less than the total)", v.DeltaCents)
			}
		}
	}
	if !found {
		t.Fatalf("payments_vs_total not reported; got %+v", in.Integrity)
	}

	// And a second café must not see it.
	other := newTenant(t)
	otherIn := gatherAsApp(t, other, time.Now().Add(24*time.Hour))
	for _, v := range otherIn.Integrity {
		if v.EntityID == order {
			t.Fatal("another café's integrity violation leaked across the RLS boundary")
		}
	}
}

// Drawer discipline is what the shift_discipline detector grades, and it is
// counted in the café's OWN timezone — a UTC count would attribute a late-night
// close to the wrong day.
func TestInsightGather_CountsTradingAndCloseDays(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(1_000)
	cat := fx.seedCategory("ShiftCat")
	item := fx.seedMenuItem(cat, "ShiftItem", 10_000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10_000)
	fx.seedPayment(order, "cash", 10_000, ptrUUID(shift))
	fx.closeOrderWithTotals(order)

	// Before closing the shift: one trading day, no close, and a session open.
	in := gatherAsApp(t, fx, time.Now().Add(24*time.Hour))
	if in.Close.TradingDays != 1 {
		t.Errorf("trading days = %d, want 1", in.Close.TradingDays)
	}
	if in.Close.ShiftCloseDays != 0 {
		t.Errorf("close days = %d, want 0", in.Close.ShiftCloseDays)
	}
	if in.Close.OpenShiftSince == nil {
		t.Error("an open shift must be reported so a hanging session can be flagged")
	}
	if in.Close.Misses() != 1 {
		t.Errorf("misses = %d, want 1", in.Close.Misses())
	}

	fx.closeShift(shift)
	in = gatherAsApp(t, fx, time.Now().Add(24*time.Hour))
	if in.Close.ShiftCloseDays != 1 || in.Close.Misses() != 0 {
		t.Errorf("after closing: closeDays=%d misses=%d, want 1 and 0",
			in.Close.ShiftCloseDays, in.Close.Misses())
	}
	if in.Close.OpenShiftSince != nil {
		t.Error("no session should be reported open after the close")
	}
}
