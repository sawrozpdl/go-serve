package api

// settlement_edge_test.go — weird-but-feasible production scenarios on the peak
// service path: settle-quote math under odd rate/discount combos, payment
// boundaries down to the paisa, and order-close edge states. These exercise the
// branches that only bite during a busy real service (comps, voids mid-pay,
// split tenders, auto-served resell goods), not the happy path.

import (
	"testing"

	"github.com/google/uuid"
)

func (fx *fixture) quote(t *testing.T, orderID uuid.UUID) CloseQuote {
	t.Helper()
	var q CloseQuote
	callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", orderID.String())).
		expectStatus(200).decode(&q)
	return q
}

// Voiding every line leaves an order with items on file but a zero live
// subtotal. Close must refuse with empty_order rather than closing a Rs 0 sale.
func TestCloseOrder_AllItemsVoided_EmptyOrder(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Tea", 500)
	order := fx.seedOpenOrder(nil)
	i1 := fx.seedOrderItem(order, item, 1, 500)
	i2 := fx.seedOrderItem(order, item, 1, 500)
	ordVoidItem(fx, i1)
	ordVoidItem(fx, i2)

	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectErr(409, "empty_order")
	if got := fx.orderStatus(order); got != "open" {
		t.Fatalf("order status = %q, want still open after refused close", got)
	}
}

// A comp/discount larger than the bill drives the taxable base negative. The
// quote must clamp the base to zero — never a negative total or negative tax.
func TestSettleQuote_DiscountExceedsSubtotal_ClampsBaseToZero(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("0", "13") // service 0, VAT 13% (default mode = exclusive)
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Tea", 500)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 500)
	adjSeedAdjustment(fx, order, "discount", 1000, "full comp")

	q := fx.quote(t, order)
	if q.SubtotalCents != 500 || q.DiscountCents != 1000 {
		t.Fatalf("subtotal=%d discount=%d, want 500/1000", q.SubtotalCents, q.DiscountCents)
	}
	if q.TaxCents != 0 || q.TotalCents != 0 || q.BalanceCents != 0 {
		t.Fatalf("tax=%d total=%d balance=%d, want all 0 (base clamped)",
			q.TaxCents, q.TotalCents, q.BalanceCents)
	}
}

// Two separate discount rows + a service charge + exclusive VAT must all compose
// in the right order: service on raw subtotal, discounts subtracted, VAT on the
// resulting base (rounded half-up).
func TestSettleQuote_StackedDiscountsServiceAndVat(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("10", "13") // service 10%, VAT 13% exclusive
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Plate", 1000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 1000)
	adjSeedAdjustment(fx, order, "discount", 50, "loyalty")
	adjSeedAdjustment(fx, order, "discount", 30, "manager")

	q := fx.quote(t, order)
	// service = 10% of 1000 = 100; base = 1000 - 80 + 100 = 1020
	// tax = round(1020 * 13%) = 133; total = 1153
	if q.ServiceChargeCents != 100 {
		t.Fatalf("service=%d, want 100", q.ServiceChargeCents)
	}
	if q.DiscountCents != 80 {
		t.Fatalf("discount=%d, want 80 (stacked)", q.DiscountCents)
	}
	if q.TaxCents != 133 {
		t.Fatalf("tax=%d, want 133", q.TaxCents)
	}
	if q.TotalCents != 1153 {
		t.Fatalf("total=%d, want 1153", q.TotalCents)
	}
}

// Inclusive VAT with a service charge: the service is added to the gross subtotal
// and VAT is extracted from the inclusive total (never added on top).
func TestSettleQuote_InclusiveVatWithService(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("inclusive", "13")
	fx.setTenantRates("10", "13")
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Combo", 11300)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 11300)

	q := fx.quote(t, order)
	// service = 10% of 11300 = 1130; base = 12430; inclusive total = 12430
	// tax extracted = round(12430 * 13 / 113) = 1430
	if q.VatMode != "inclusive" {
		t.Fatalf("vat_mode=%q, want inclusive", q.VatMode)
	}
	if q.ServiceChargeCents != 1130 {
		t.Fatalf("service=%d, want 1130", q.ServiceChargeCents)
	}
	if q.TotalCents != 12430 {
		t.Fatalf("total=%d, want 12430 (inclusive: total == base)", q.TotalCents)
	}
	if q.TaxCents != 1430 {
		t.Fatalf("tax=%d, want 1430 (extracted)", q.TaxCents)
	}
}

// VAT 'none' mode still applies service charge and discounts, just never adds tax.
func TestSettleQuote_NoneVatWithServiceAndDiscount(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "13")
	fx.setTenantRates("10", "13")
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Plate", 1000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 1000)
	adjSeedAdjustment(fx, order, "discount", 200, "comp")

	q := fx.quote(t, order)
	// service 100; base = 1000 - 200 + 100 = 900; none → tax 0, total 900
	if q.VatMode != "none" {
		t.Fatalf("vat_mode=%q, want none", q.VatMode)
	}
	if q.TaxCents != 0 {
		t.Fatalf("tax=%d, want 0 in none mode", q.TaxCents)
	}
	if q.ServiceChargeCents != 100 || q.TotalCents != 900 {
		t.Fatalf("service=%d total=%d, want 100/900", q.ServiceChargeCents, q.TotalCents)
	}
}

// Split tender to the exact paisa: pay all-but-one, an over-by-2 attempt must be
// rejected against the 1-paisa balance, then the exact 1 closes it cleanly.
func TestRecordPayment_ExactSplitAndOnePaisaOverpayment(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	fx.seedOpenShift(0)
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Odd", 11134)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 11134)

	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 11133}, withParam("id", order.String())).
		expectStatus(201)
	// Balance is now exactly 1 paisa; an over-by-2 must be refused.
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 2}, withParam("id", order.String())).
		expectErr(409, "overpayment")
	// The exact remaining paisa is accepted.
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 1}, withParam("id", order.String())).
		expectStatus(201)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200)
	if got := fx.orderStatus(order); got != "closed" {
		t.Fatalf("order status = %q, want closed", got)
	}
}

// Voiding a line after a partial payment must re-shrink the bill so the existing
// payment now fully settles it — a real "customer changed their mind" flow.
func TestVoidItemAfterPartialPayment_RebalancesQuote(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	fx.seedOpenShift(0)
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Tea", 500)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 500)
	i2 := fx.seedOrderItem(order, item, 1, 500)

	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 500}, withParam("id", order.String())).
		expectStatus(201)
	if q := fx.quote(t, order); q.TotalCents != 1000 || q.BalanceCents != 500 {
		t.Fatalf("pre-void total=%d balance=%d, want 1000/500", q.TotalCents, q.BalanceCents)
	}

	ordVoidItem(fx, i2)
	q := fx.quote(t, order)
	if q.SubtotalCents != 500 || q.TotalCents != 500 || q.BalanceCents != 0 {
		t.Fatalf("post-void subtotal=%d total=%d balance=%d, want 500/500/0",
			q.SubtotalCents, q.TotalCents, q.BalanceCents)
	}
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200)
}

// A full house-tab charge settles the order to a receivable — Close must succeed
// and the payment row must retain its house_tab_id link.
func TestCloseOrder_HouseTabPaymentSucceeds(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	tab := fx.seedHouseTab("Staff", true)
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Plate", 1000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 1000)

	var p Payment
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "house_tab", "amount_cents": 1000, "house_tab_id": tab.String()},
		withParam("id", order.String())).expectStatus(201).decode(&p)
	if p.HouseTabID == nil || *p.HouseTabID != tab {
		t.Fatalf("payment house_tab_id = %v, want %s", p.HouseTabID, tab)
	}
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200)
	if got := fx.orderStatus(order); got != "closed" {
		t.Fatalf("order status = %q, want closed", got)
	}
}
