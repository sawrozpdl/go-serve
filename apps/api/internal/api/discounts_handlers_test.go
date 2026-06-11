package api

// Integration tests for discounts.go:
//   ListOrderAdjustments    GET  /v1/orders/{id}/adjustments
//   ApplyOrderAdjustment    POST /v1/orders/{id}/adjustments
//   RemoveOrderAdjustment   DELETE /v1/orders/{id}/adjustments/{adjId}
//
// Each test creates its own throwaway tenant (newTenant) and exercises the
// handler through callHandler against the real app-pool with RLS active.

import (
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// adjSeed helpers
// =========================================================================

// adjSeedOrder creates a minimal open order with one item (subtotal = priceCents).
func adjSeedOrder(fx *fixture, priceCents int64) uuid.UUID {
	cat := fx.seedCategory("AdjCat")
	item := fx.seedMenuItem(cat, "AdjItem", priceCents)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, priceCents)
	return order
}

// adjSeedAdjustment inserts an adjustment row directly via the admin pool.
// adjType must be a valid order_adjustment_type enum value.
func adjSeedAdjustment(fx *fixture, orderID uuid.UUID, adjType string, amountCents int64, reason string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO order_adjustments
		   (tenant_id, order_id, type, amount_cents, reason, applied_by_user_id)
		 VALUES ($1, $2, $3::order_adjustment_type, $4, $5, $6)
		 RETURNING id`,
		fx.Tenant, orderID, adjType, amountCents, reason, fx.User)
	return id
}

// =========================================================================
// ListOrderAdjustments
// =========================================================================

func TestListOrderAdjustments_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListOrderAdjustments, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestListOrderAdjustments_EmptyList(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	r := callHandler(t, fx, ListOrderAdjustments, "GET", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()
	adjs, _ := r["adjustments"].([]any)
	if len(adjs) != 0 {
		t.Fatalf("adjustments = %d, want 0", len(adjs))
	}
}

func TestListOrderAdjustments_WithRows(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	adjSeedAdjustment(fx, order, "discount", 500, "staff discount")
	adjSeedAdjustment(fx, order, "service_charge", 300, "manual service")
	r := callHandler(t, fx, ListOrderAdjustments, "GET", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()
	adjs, _ := r["adjustments"].([]any)
	if len(adjs) != 2 {
		t.Fatalf("adjustments = %d, want 2", len(adjs))
	}
}

// Adjustments scoped to a different order should not leak through.
func TestListOrderAdjustments_OtherOrderIsolated(t *testing.T) {
	fx := newTenant(t)
	orderA := fx.seedOpenOrder(nil)
	orderB := fx.seedOpenOrder(nil)
	adjSeedAdjustment(fx, orderA, "discount", 200, "A discount")

	r := callHandler(t, fx, ListOrderAdjustments, "GET", "/", nil,
		withParam("id", orderB.String())).
		expectStatus(200).json()
	adjs, _ := r["adjustments"].([]any)
	if len(adjs) != 0 {
		t.Fatalf("adjustments for orderB = %d, want 0 (leak from orderA)", len(adjs))
	}
}

// A non-existent order returns 200 with an empty list (the handler does not
// guard existence for list — it just queries and returns nothing).
func TestListOrderAdjustments_UnknownOrderReturnsEmpty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListOrderAdjustments, "GET", "/", nil,
		withParam("id", uuid.NewString())).
		expectStatus(200).json()
	adjs, _ := r["adjustments"].([]any)
	if len(adjs) != 0 {
		t.Fatalf("adjustments = %d, want 0 for unknown order", len(adjs))
	}
}

// =========================================================================
// ApplyOrderAdjustment
// =========================================================================

func TestApplyOrderAdjustment_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 100, "reason": "test"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/", "{not json",
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_InvalidType(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "freebie", "amount_cents": 100, "reason": "test"},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_EmptyType(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "", "amount_cents": 100, "reason": "test"},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 0, "reason": "test"},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": -500, "reason": "test"},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_MissingReason(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	// omit reason entirely
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 100},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_EmptyReason(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 100, "reason": ""},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestApplyOrderAdjustment_OrderNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 100, "reason": "test"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestApplyOrderAdjustment_ClosedOrderConflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "closed")
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 100, "reason": "test"},
		withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

func TestApplyOrderAdjustment_CancelledOrderConflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "cancelled")
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 200, "reason": "test"},
		withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

// Success: discount type — verify 201, response fields, and DB row.
func TestApplyOrderAdjustment_DiscountSuccess(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 10000)
	r := callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 500, "reason": "loyalty"},
		withParam("id", order.String())).
		expectStatus(201)

	var a OrderAdjustment
	r.decode(&a)
	if a.Type != "discount" {
		t.Fatalf("type = %q, want discount", a.Type)
	}
	if a.AmountCents != 500 {
		t.Fatalf("amount_cents = %d, want 500", a.AmountCents)
	}
	if a.Reason != "loyalty" {
		t.Fatalf("reason = %q, want loyalty", a.Reason)
	}
	if a.OrderID != order {
		t.Fatalf("order_id mismatch")
	}
	if a.ID == uuid.Nil {
		t.Fatal("id is nil")
	}
	// applied_by and approved_by should be populated (actor = owner)
	if a.AppliedByUserID == uuid.Nil {
		t.Fatal("applied_by_user_id is nil")
	}
	if a.ApprovedByUserID == uuid.Nil {
		t.Fatal("approved_by_user_id is nil — handler sets approver = actor")
	}

	if n := fx.countRows("order_adjustments"); n != 1 {
		t.Fatalf("order_adjustments rows = %d, want 1", n)
	}
}

// Success: service_charge type.
func TestApplyOrderAdjustment_ServiceChargeSuccess(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 10000)
	r := callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "service_charge", "amount_cents": 1000, "reason": "extra service"},
		withParam("id", order.String())).
		expectStatus(201)

	var a OrderAdjustment
	r.decode(&a)
	if a.Type != "service_charge" {
		t.Fatalf("type = %q, want service_charge", a.Type)
	}
	if a.AmountCents != 1000 {
		t.Fatalf("amount_cents = %d, want 1000", a.AmountCents)
	}
}

// Success: tax_override type.
func TestApplyOrderAdjustment_TaxOverrideSuccess(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 10000)
	r := callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "tax_override", "amount_cents": 300, "reason": "vat exempt"},
		withParam("id", order.String())).
		expectStatus(201)

	var a OrderAdjustment
	r.decode(&a)
	if a.Type != "tax_override" {
		t.Fatalf("type = %q, want tax_override", a.Type)
	}
}

// Multiple adjustments can coexist on the same order.
func TestApplyOrderAdjustment_MultipleAdjustments(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 20000)

	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 1000, "reason": "discount1"},
		withParam("id", order.String())).
		expectStatus(201)

	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 500, "reason": "discount2"},
		withParam("id", order.String())).
		expectStatus(201)

	if n := fx.countRows("order_adjustments"); n != 2 {
		t.Fatalf("order_adjustments rows = %d, want 2", n)
	}
}

// Applying a discount then calling GetSettleQuote should reflect discount_cents
// and a reduced total_cents.
func TestApplyOrderAdjustment_DiscountReflectedInSettleQuote(t *testing.T) {
	fx := newTenant(t)
	// Pure VAT 13%, service 0% so the math is clear.
	fx.setTenantRates("0", "13")
	order := adjSeedOrder(fx, 10000) // subtotal = 10000, VAT 13% = 1300, total = 11300

	// Apply a 1000 discount.
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 1000, "reason": "test"},
		withParam("id", order.String())).
		expectStatus(201)

	q := callHandler(t, fx, GetSettleQuote, "GET", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()

	discountCents := int64(q["discount_cents"].(float64))
	totalCents := int64(q["total_cents"].(float64))

	if discountCents != 1000 {
		t.Fatalf("discount_cents = %d, want 1000", discountCents)
	}
	// subtotal 10000, discount 1000 → taxable base 9000, VAT 13% = 1170, total = 9000 + 1170 = 10170
	if totalCents != 10170 {
		t.Fatalf("total_cents = %d, want 10170", totalCents)
	}
}

// A second user (additional member) can also apply adjustments — applies_by
// should reflect that user.
func TestApplyOrderAdjustment_AppliedByReflectsActingUser(t *testing.T) {
	fx := newTenant(t)
	secondUser := fx.addUser("Staff")
	order := adjSeedOrder(fx, 10000)

	r := callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/",
		map[string]any{"type": "discount", "amount_cents": 200, "reason": "staff perk"},
		withParam("id", order.String()),
		actingAs(secondUser)).
		expectStatus(201)

	var a OrderAdjustment
	r.decode(&a)
	if a.AppliedByUserID != secondUser {
		t.Fatalf("applied_by_user_id = %v, want %v", a.AppliedByUserID, secondUser)
	}
}

// =========================================================================
// RemoveOrderAdjustment
// =========================================================================

func TestRemoveOrderAdjustment_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": "not-a-uuid", "adjId": uuid.NewString()})).
		expectErr(400, "bad_request")
}

func TestRemoveOrderAdjustment_BadAdjID(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": "not-a-uuid"})).
		expectErr(400, "bad_request")
}

// Order does not exist → not_found (the handler queries status and gets no rows).
func TestRemoveOrderAdjustment_OrderNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "adjId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestRemoveOrderAdjustment_ClosedOrderConflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	adj := adjSeedAdjustment(fx, order, "discount", 300, "test")
	fx.setOrderStatus(order, "closed")
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectErr(409, "order_not_open")
}

func TestRemoveOrderAdjustment_CancelledOrderConflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	adj := adjSeedAdjustment(fx, order, "discount", 300, "test")
	fx.setOrderStatus(order, "cancelled")
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectErr(409, "order_not_open")
}

// Adjustment UUID belongs to a different order on the same tenant → 404.
func TestRemoveOrderAdjustment_AdjBelongsToOtherOrder(t *testing.T) {
	fx := newTenant(t)
	orderA := fx.seedOpenOrder(nil)
	orderB := fx.seedOpenOrder(nil)
	adjA := adjSeedAdjustment(fx, orderA, "discount", 100, "for A")
	// Try to delete adjA via orderB's route.
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": orderB.String(), "adjId": adjA.String()})).
		expectErr(404, "not_found")
}

// Completely unknown adjustment ID on an open order → 404.
func TestRemoveOrderAdjustment_NotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestRemoveOrderAdjustment_DiscountSuccess(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 10000)
	adj := adjSeedAdjustment(fx, order, "discount", 500, "will be removed")

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectStatus(204)

	if n := fx.countRows("order_adjustments"); n != 0 {
		t.Fatalf("order_adjustments rows = %d, want 0", n)
	}
}

func TestRemoveOrderAdjustment_ServiceChargeSuccess(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 10000)
	adj := adjSeedAdjustment(fx, order, "service_charge", 800, "manual sc")

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectStatus(204)

	if n := fx.countRows("order_adjustments"); n != 0 {
		t.Fatalf("order_adjustments rows = %d, want 0", n)
	}
}

// Remove one adjustment; verify only that row is gone and the other remains.
func TestRemoveOrderAdjustment_OnlyTargetDeleted(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 20000)
	adj1 := adjSeedAdjustment(fx, order, "discount", 500, "keep")
	adj2 := adjSeedAdjustment(fx, order, "discount", 300, "remove me")

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj2.String()})).
		expectStatus(204)

	if n := fx.countRows("order_adjustments"); n != 1 {
		t.Fatalf("order_adjustments rows = %d, want 1", n)
	}

	// Verify the surviving row is adj1, not adj2.
	var survivingID uuid.UUID
	fx.adminScan([]any{&survivingID},
		`SELECT id FROM order_adjustments WHERE order_id = $1`, order)
	if survivingID != adj1 {
		t.Fatalf("surviving adjustment = %v, want %v", survivingID, adj1)
	}
}

// Apply a discount, then remove it; settle quote should revert to the
// undiscounted total.
func TestRemoveOrderAdjustment_QuoteRevertsAfterRemoval(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("0", "13")
	order := adjSeedOrder(fx, 10000) // subtotal 10000, VAT 1300, total 11300

	adj := adjSeedAdjustment(fx, order, "discount", 1000, "will be removed")

	// Confirm quote is discounted before removal.
	qBefore := callHandler(t, fx, GetSettleQuote, "GET", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()
	if int64(qBefore["discount_cents"].(float64)) != 1000 {
		t.Fatalf("discount_cents before removal = %v, want 1000", qBefore["discount_cents"])
	}

	// Remove the adjustment.
	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectStatus(204)

	// Quote should now show no discount and the original total.
	qAfter := callHandler(t, fx, GetSettleQuote, "GET", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()
	if int64(qAfter["discount_cents"].(float64)) != 0 {
		t.Fatalf("discount_cents after removal = %v, want 0", qAfter["discount_cents"])
	}
	if int64(qAfter["total_cents"].(float64)) != 11300 {
		t.Fatalf("total_cents after removal = %v, want 11300", qAfter["total_cents"])
	}
}

// Idempotency: removing the same adjustment a second time returns 404 (already
// gone), not a crash.
func TestRemoveOrderAdjustment_DoubleRemoveIs404(t *testing.T) {
	fx := newTenant(t)
	order := adjSeedOrder(fx, 10000)
	adj := adjSeedAdjustment(fx, order, "discount", 500, "once")

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectStatus(204)

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.String()})).
		expectErr(404, "not_found")
}
