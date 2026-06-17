package api

// reconciliation_edge_test.go — cash + inventory reconciliation under messy real
// service. The headline target is DecrementInventoryForOrder (driven via
// CloseOrder), the lowest-covered critical function: it runs on every settle and
// quietly moves stock, so its odd branches (no links, fractional recipes,
// oversell, voided lines, multi-ingredient items) deserve hard assertions.

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// payOnlineAndClose fully settles an order with an online tender (no shift
// needed) and closes it, which is what fires DecrementInventoryForOrder.
func (fx *fixture) payOnlineAndClose(t *testing.T, orderID uuid.UUID, amount int64) {
	t.Helper()
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "online", "amount_cents": amount}, withParam("id", orderID.String())).
		expectStatus(201)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", orderID.String())).
		expectStatus(200)
}

// An item with no inventory link must be a clean no-op: no stock movement and no
// stray audit entry (the early-return-on-empty branch).
func TestDecrement_NoLinks_NoMovementCreated(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	cat := fx.seedCategory("C")
	item := fx.seedMenuItem(cat, "Espresso", 300) // never linked to inventory
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 300)

	fx.payOnlineAndClose(t, order, 600)
	if n := fx.countRows("stock_movements"); n != 0 {
		t.Fatalf("stock_movements = %d, want 0 (no links → no decrement)", n)
	}
}

// Recipes consume fractional units per sale (0.5 L of milk per latte). The
// decrement must do the qty × per-sale math in the DB without float drift.
func TestDecrement_FractionalQtyPerSale(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	cat := fx.seedCategory("C")
	drink := fx.seedMenuItem(cat, "Latte", 500)
	milk := fx.invSeedItem("Milk", "ingredient", "L")
	fx.invSeedMovement(milk, "200", "purchase") // 200 on hand
	fx.invSeedMenuItemLink(drink, milk, "0.5")
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, drink, 4, 500) // 4 lattes → 4 × 0.5 = 2 L

	fx.payOnlineAndClose(t, order, 2000)
	if q := fx.invQtyOnHand(milk); q != "198.000" {
		t.Fatalf("milk on hand = %q, want 198.000 (200 − 4×0.5)", q)
	}
}

// Overselling beyond stock is allowed (the cafe can't refuse a sale because the
// counter is wrong), but it must drive the balance negative AND flag it in the
// audit trail so the owner notices the bad count.
func TestDecrement_OversellGoesNegative_AuditWarns(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	cat := fx.seedCategory("C")
	coffee := fx.seedMenuItem(cat, "Coffee", 300)
	beans := fx.invSeedItem("Beans", "ingredient", "g")
	fx.invSeedMovement(beans, "3", "purchase") // only 3g on hand
	fx.invSeedMenuItemLink(coffee, beans, "5")  // needs 5g per cup
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, coffee, 1, 300)

	fx.payOnlineAndClose(t, order, 300)
	if q := fx.invQtyOnHand(beans); q != "-2.000" {
		t.Fatalf("beans on hand = %q, want -2.000 (oversell allowed)", q)
	}
	var summary string
	fx.adminScan([]any{&summary},
		`SELECT summary FROM audit_log WHERE entity='inventory' AND entity_id=$1`, order)
	if !strings.Contains(summary, "negative") {
		t.Fatalf("audit summary = %q, want it to flag negative stock", summary)
	}
}

// Voided lines must never consume stock — only the lines actually served.
func TestDecrement_VoidedItemsExcluded(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	cat := fx.seedCategory("C")
	combo := fx.seedMenuItem(cat, "Combo", 500)
	itemA := fx.invSeedItem("ItemA", "ingredient", "unit")
	fx.invSeedMovement(itemA, "10", "purchase")
	fx.invSeedMenuItemLink(combo, itemA, "1")
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, combo, 1, 500) // live
	v1 := fx.seedOrderItem(order, combo, 1, 500)
	v2 := fx.seedOrderItem(order, combo, 1, 500)
	ordVoidItem(fx, v1)
	ordVoidItem(fx, v2)

	fx.payOnlineAndClose(t, order, 500) // only the 1 live line is owed
	if q := fx.invQtyOnHand(itemA); q != "9.000" {
		t.Fatalf("itemA on hand = %q, want 9.000 (only 1 non-voided line consumed)", q)
	}
}

// One menu item with several ingredient links must decrement each independently.
func TestDecrement_MultipleLinksPerItem(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")
	cat := fx.seedCategory("C")
	capp := fx.seedMenuItem(cat, "Cappuccino", 500)
	beans := fx.invSeedItem("Beans", "ingredient", "g")
	milk := fx.invSeedItem("Milk", "ingredient", "L")
	fx.invSeedMovement(beans, "200", "purchase")
	fx.invSeedMovement(milk, "10", "purchase")
	fx.invSeedMenuItemLink(capp, beans, "18.5")
	fx.invSeedMenuItemLink(capp, milk, "0.25")
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, capp, 4, 500)

	fx.payOnlineAndClose(t, order, 2000)
	if q := fx.invQtyOnHand(beans); q != "126.000" {
		t.Fatalf("beans on hand = %q, want 126.000 (200 − 4×18.5)", q)
	}
	if q := fx.invQtyOnHand(milk); q != "9.000" {
		t.Fatalf("milk on hand = %q, want 9.000 (10 − 4×0.25)", q)
	}
}

// A drawer that counts HIGHER than expected stamps a positive variance (the
// existing reconciliation test only covers a shortage).
func TestCloseShift_VarianceOverage(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	order := fx.shftOpenOrder(2000)
	fx.seedPayment(order, "cash", 2000, ptrUUID(shiftID))

	var s Shift
	callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 3100}, withParam("id", shiftID.String())).
		expectStatus(200).decode(&s)
	// expected = 1000 float + 2000 cash = 3000; counted 3100 → +100 over.
	if s.ExpectedCashCents == nil || *s.ExpectedCashCents != 3000 {
		t.Fatalf("expected_cash = %v, want 3000", s.ExpectedCashCents)
	}
	if s.VarianceCents == nil || *s.VarianceCents != 100 {
		t.Fatalf("variance = %v, want +100 (drawer over)", s.VarianceCents)
	}
}

// One tenant must not be able to close another tenant's shift — RLS hides the
// row, so it reads as not-found and the real shift stays open.
func TestCloseShift_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	shiftID := fx1.seedOpenShift(1000)

	callHandler(t, fx2, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 1000}, withParam("id", shiftID.String())).
		expectErr(404, "not_found")

	var closed *time.Time
	fx1.adminScan([]any{&closed}, `SELECT closed_at FROM shifts WHERE id = $1`, shiftID)
	if closed != nil {
		t.Fatal("fx1's shift was closed across the tenant boundary")
	}
}
