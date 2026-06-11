package api

import (
	"testing"
)

// TestHarness_PaymentFlow is a smoke test proving the integration harness works
// end-to-end: seed a tenant + menu + table + order + shift, then drive the real
// RecordPayment / GetSettleQuote / CloseOrder handlers through the app-pool
// (RLS-active) transaction path. If this passes, the harness is sound.
func TestHarness_PaymentFlow(t *testing.T) {
	fx := newTenant(t)
	hub := testHub()

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Latte", 30000) // Rs 300.00
	table := fx.seedTable("T1")
	order := fx.seedOpenOrder(ptrUUID(table))
	fx.seedOrderItem(order, item, 2, 30000) // subtotal 60000
	fx.seedOpenShift(100000)

	// Quote: subtotal 60000, vat 13% => tax 7800, total 67800, balance 67800.
	q := callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).json()
	if got := int64(q["total_cents"].(float64)); got != 67800 {
		t.Fatalf("total_cents = %d, want 67800", got)
	}
	if got := int64(q["balance_cents"].(float64)); got != 67800 {
		t.Fatalf("balance_cents = %d, want 67800", got)
	}

	// Overpayment is rejected.
	callHandler(t, fx, RecordPayment(hub), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 99999},
		withParam("id", order.String())).
		expectErr(409, "overpayment")

	// Exact cash payment succeeds.
	callHandler(t, fx, RecordPayment(hub), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 67800},
		withParam("id", order.String())).
		expectStatus(201)

	if n := fx.countRows("payments"); n != 1 {
		t.Fatalf("payments rows = %d, want 1", n)
	}

	// Now balance is zero, so close succeeds.
	callHandler(t, fx, CloseOrder(hub), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200)

	// Order is closed.
	var status string
	fx.adminScan([]any{&status}, `SELECT status::text FROM orders WHERE id = $1`, order)
	if status != "closed" {
		t.Fatalf("order status = %q, want closed", status)
	}
}
