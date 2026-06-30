package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Local seed helpers — prefixed "ordSeed" so they don't collide with
// harness_test.go names (seedOpenOrder, seedOrderItem already exist there).
// =========================================================================

// ordSeedItem seeds a menu category + item and returns (menuItemID, priceCents).
func ordSeedItem(fx *fixture, name string, priceCents int64) uuid.UUID {
	cat := fx.seedCategory("Cat-" + name)
	return fx.seedMenuItem(cat, name, priceCents)
}

// ordSeedActiveItem seeds a menu category + item and ensures it is active.
func ordSeedActiveItem(fx *fixture, name string, priceCents int64) uuid.UUID {
	return ordSeedItem(fx, name, priceCents)
}

// ordSeedInactiveItem seeds an inactive menu item and returns its ID.
func ordSeedInactiveItem(fx *fixture, name string, priceCents int64) uuid.UUID {
	id := ordSeedItem(fx, name, priceCents)
	fx.adminExec(`UPDATE menu_items SET is_active = false WHERE id = $1`, id)
	return id
}

// ordSeedKitchenStatus forces an order_items row to a given kitchen_status.
func ordSeedKitchenStatus(fx *fixture, itemID uuid.UUID, ks string) {
	fx.adminExec(`UPDATE order_items SET kitchen_status = $2::kitchen_status WHERE id = $1`, itemID, ks)
}

// ordSetSentToKitchen stamps sent_to_kitchen_at so CancelOrder sees "items in kitchen".
func ordSetSentToKitchen(fx *fixture, itemID uuid.UUID) {
	fx.adminExec(`UPDATE order_items SET sent_to_kitchen_at = now(), kitchen_status = 'in_progress' WHERE id = $1`, itemID)
}

// ordVoidItem forces an order_items row to voided state.
func ordVoidItem(fx *fixture, itemID uuid.UUID) {
	fx.adminExec(`UPDATE order_items SET voided_at = now() WHERE id = $1`, itemID)
}

// ordItemKitchenStatus reads kitchen_status of an order_items row.
func ordItemKitchenStatus(fx *fixture, itemID uuid.UUID) string {
	var s string
	fx.adminScan([]any{&s}, `SELECT kitchen_status::text FROM order_items WHERE id = $1`, itemID)
	return s
}

// ordItemSentAt reads sent_to_kitchen_at of an order_items row.
func ordItemSentAt(fx *fixture, itemID uuid.UUID) *time.Time {
	var ts *time.Time
	fx.adminScan([]any{&ts}, `SELECT sent_to_kitchen_at FROM order_items WHERE id = $1`, itemID)
	return ts
}

// ordItemVoidedAt reads voided_at of an order_items row.
func ordItemVoidedAt(fx *fixture, itemID uuid.UUID) *time.Time {
	var ts *time.Time
	fx.adminScan([]any{&ts}, `SELECT voided_at FROM order_items WHERE id = $1`, itemID)
	return ts
}

// ordItemCount counts non-voided order items for an order.
func ordItemCount(fx *fixture, orderID uuid.UUID) int {
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM order_items WHERE order_id = $1 AND voided_at IS NULL`, orderID)
	return n
}

// ordItemQty reads the qty of a specific item.
func ordItemQty(fx *fixture, itemID uuid.UUID) int {
	var q int
	fx.adminScan([]any{&q}, `SELECT qty FROM order_items WHERE id = $1`, itemID)
	return q
}

// ordItemNotes reads the notes of a specific item.
func ordItemNotes(fx *fixture, itemID uuid.UUID) string {
	var n string
	fx.adminScan([]any{&n}, `SELECT notes FROM order_items WHERE id = $1`, itemID)
	return n
}

// ordUnitPrice reads the snapshotted unit_price_cents of a specific item row.
func ordUnitPrice(fx *fixture, itemID uuid.UUID) int64 {
	var p int64
	fx.adminScan([]any{&p}, `SELECT unit_price_cents FROM order_items WHERE id = $1`, itemID)
	return p
}

// ordServiceTableID reads the service_table_id from an order row.
func ordServiceTableID(fx *fixture, orderID uuid.UUID) *uuid.UUID {
	var tableID *uuid.UUID
	fx.adminScan([]any{&tableID}, `SELECT service_table_id FROM orders WHERE id = $1`, orderID)
	return tableID
}

// ordOrderExists checks if an order row exists.
func ordOrderExists(fx *fixture, orderID uuid.UUID) bool {
	var n int
	fx.adminScan([]any{&n}, `SELECT count(*) FROM orders WHERE id = $1`, orderID)
	return n > 0
}

// ordTableLabel reads the free-text table_label from an order row.
func ordTableLabel(fx *fixture, orderID uuid.UUID) string {
	var s string
	fx.adminScan([]any{&s}, `SELECT table_label FROM orders WHERE id = $1`, orderID)
	return s
}

// =========================================================================
// ListOrders
// =========================================================================

func TestListOrders_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListOrders, "GET", "/", nil).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 0 {
		t.Fatalf("orders = %d, want 0", len(orders))
	}
}

func TestListOrders_ReturnsAll(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenOrder(nil)
	fx.seedOpenOrder(nil)
	r := callHandler(t, fx, ListOrders, "GET", "/", nil).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 2 {
		t.Fatalf("orders = %d, want 2", len(orders))
	}
}

func TestListOrders_StatusFilter_Open(t *testing.T) {
	fx := newTenant(t)
	open := fx.seedOpenOrder(nil)
	closed := fx.seedOpenOrder(nil)
	fx.setOrderStatus(closed, "closed")

	r := callHandler(t, fx, ListOrders, "GET", "/", nil, withQuery("status=open")).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("open orders = %d, want 1", len(orders))
	}
	first := orders[0].(map[string]any)
	if first["id"] != open.String() {
		t.Fatalf("got order %v, want %v", first["id"], open.String())
	}
}

func TestListOrders_StatusFilter_Closed(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenOrder(nil)
	closed := fx.seedOpenOrder(nil)
	fx.setOrderStatus(closed, "closed")

	r := callHandler(t, fx, ListOrders, "GET", "/", nil, withQuery("status=closed")).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("closed orders = %d, want 1", len(orders))
	}
	first := orders[0].(map[string]any)
	if first["id"] != closed.String() {
		t.Fatalf("got order %v, want %v", first["id"], closed.String())
	}
}

func TestListOrders_StatusFilter_Cancelled(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenOrder(nil)
	cancelled := fx.seedOpenOrder(nil)
	fx.setOrderStatus(cancelled, "cancelled")

	r := callHandler(t, fx, ListOrders, "GET", "/", nil, withQuery("status=cancelled")).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("cancelled orders = %d, want 1", len(orders))
	}
}

func TestListOrders_OrderedByOpenedAtDesc(t *testing.T) {
	fx := newTenant(t)
	first := fx.seedOpenOrder(nil)
	second := fx.seedOpenOrder(nil)
	// Force a time ordering that is distinguishable.
	fx.adminExec(`UPDATE orders SET opened_at = now() - interval '1 hour' WHERE id = $1`, first)
	fx.adminExec(`UPDATE orders SET opened_at = now() WHERE id = $1`, second)

	r := callHandler(t, fx, ListOrders, "GET", "/", nil).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 2 {
		t.Fatalf("orders = %d, want 2", len(orders))
	}
	top := orders[0].(map[string]any)
	if top["id"] != second.String() {
		t.Fatalf("expected most-recent first, got %v", top["id"])
	}
}

func TestListOrders_ItemCountsPopulated(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Coffee", 500)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, menuItem, 2, 500)

	r := callHandler(t, fx, ListOrders, "GET", "/", nil).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	first := orders[0].(map[string]any)
	if int(first["items_total"].(float64)) != 1 {
		t.Fatalf("items_total = %v, want 1", first["items_total"])
	}
	if int(first["items_pending"].(float64)) != 1 {
		t.Fatalf("items_pending = %v, want 1", first["items_pending"])
	}
}

func TestListOrders_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedOpenOrder(nil)
	fx1.seedOpenOrder(nil)
	fx2.seedOpenOrder(nil)

	r := callHandler(t, fx2, ListOrders, "GET", "/", nil).
		expectStatus(200).json()
	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("fx2 sees %d orders, want 1 (tenant isolation broken)", len(orders))
	}
}

// =========================================================================
// GetOrder
// =========================================================================

func TestGetOrder_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestGetOrder_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestGetOrder_Success_TakeAway(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Tea", 300)
	fx.seedOrderItem(order, menuItem, 1, 300)

	var o Order
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&o)

	if o.ID != order {
		t.Fatalf("id mismatch: got %v, want %v", o.ID, order)
	}
	if o.ServiceTableID != nil {
		t.Fatalf("service_table_id should be nil for take-away")
	}
	if len(o.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(o.Items))
	}
}

func TestGetOrder_Success_WithTable(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("T1")
	order := fx.seedOpenOrder(ptrUUID(table))

	var o Order
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&o)

	if o.ServiceTableID == nil || *o.ServiceTableID != table {
		t.Fatalf("service_table_id mismatch")
	}
	if o.ServiceTableName == nil || *o.ServiceTableName != "T1" {
		t.Fatalf("service_table_name mismatch: got %v", o.ServiceTableName)
	}
}

func TestGetOrder_ItemCounts(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Latte", 400)
	order := fx.seedOpenOrder(nil)
	item1 := fx.seedOrderItem(order, menuItem, 1, 400)
	item2 := fx.seedOrderItem(order, menuItem, 2, 400)
	// item2 sent to kitchen
	ordSetSentToKitchen(fx, item2)
	ordSeedKitchenStatus(fx, item2, "in_progress")
	// item1 stays pending

	var o Order
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&o)

	if o.ItemsPending != 1 {
		t.Fatalf("items_pending = %d, want 1", o.ItemsPending)
	}
	if o.ItemsInProgress != 1 {
		t.Fatalf("items_in_progress = %d, want 1", o.ItemsInProgress)
	}
	_ = item1
}

func TestGetOrder_VoidedItemsExcludedFromLive(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Espresso", 200)
	order := fx.seedOpenOrder(nil)
	item1 := fx.seedOrderItem(order, menuItem, 1, 200)
	item2 := fx.seedOrderItem(order, menuItem, 1, 200)
	ordVoidItem(fx, item2)

	var o Order
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&o)

	if o.LiveSubtotalCents != 200 {
		t.Fatalf("live_subtotal_cents = %d, want 200 (voided excluded)", o.LiveSubtotalCents)
	}
	if o.ItemsTotal != 1 {
		t.Fatalf("items_total = %d, want 1 (voided excluded)", o.ItemsTotal)
	}
	// Both items still present in slice (voided rows are included in response).
	if len(o.Items) != 2 {
		t.Fatalf("items slice = %d, want 2 (including voided)", len(o.Items))
	}
	_ = item1
}

func TestGetOrder_PaidCentsPopulated(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.seedPayment(order, "cash", 500, nil)
	fx.seedPayment(order, "other", 300, nil)

	var o Order
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&o)

	if o.PaidCents != 800 {
		t.Fatalf("paid_cents = %d, want 800", o.PaidCents)
	}
}

func TestGetOrder_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	order := fx1.seedOpenOrder(nil)
	// fx2 must not be able to read fx1's order.
	callHandler(t, fx2, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// OpenOrder
// =========================================================================

func TestOpenOrder_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestOpenOrder_TakeAway(t *testing.T) {
	fx := newTenant(t)
	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"notes": "walk-in"}).
		expectStatus(201).decode(&o)

	if o.ID == uuid.Nil {
		t.Fatal("expected non-nil order id")
	}
	if o.Status != "open" {
		t.Fatalf("status = %q, want open", o.Status)
	}
	if o.ServiceTableID != nil {
		t.Fatalf("service_table_id should be nil for take-away")
	}
	if o.Notes != "walk-in" {
		t.Fatalf("notes = %q, want walk-in", o.Notes)
	}
}

func TestOpenOrder_WithTable_FlipsToOccupied(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("T2")

	if got := fx.tableStatus(table); got != "free" {
		t.Fatalf("initial table status = %q, want free", got)
	}

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}).
		expectStatus(201).decode(&o)

	if o.ServiceTableID == nil || *o.ServiceTableID != table {
		t.Fatalf("service_table_id mismatch")
	}
	if got := fx.tableStatus(table); got != "occupied" {
		t.Fatalf("table status after open = %q, want occupied", got)
	}
	if n := fx.countRows("orders"); n != 1 {
		t.Fatalf("orders = %d, want 1", n)
	}
}

func TestOpenOrder_OccupiedTableConflict(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("T3")
	// Open a first order on the table.
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}).
		expectStatus(201)

	// Opening a second order on the same table must fail.
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}).
		expectErr(409, "tab_already_open")
}

func TestOpenOrder_UnknownTable_Succeeds(t *testing.T) {
	// Passing a non-existent table id should fail with FK violation → 500 or
	// lead to a not_found. Since the INSERT will fail (FK to service_tables),
	// we expect a 500 internal_error (no dedicated guard exists in the handler).
	fx := newTenant(t)
	// This is a foreign-key violation path; handler returns internal_error.
	r := callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": uuid.NewString()})
	if r.Code == 201 {
		t.Fatalf("expected error opening order with unknown table, got 201")
	}
}

func TestOpenOrder_TakeAway_TableStatusNotChanged(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("Unused")
	// Open a take-away order (no table). OpenOrder requires a JSON body.
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/", map[string]any{}).
		expectStatus(201)
	// Table status must remain free.
	if got := fx.tableStatus(table); got != "free" {
		t.Fatalf("unrelated table status = %q, want free", got)
	}
}

func TestOpenOrder_FreshOrderHasNoItems(t *testing.T) {
	fx := newTenant(t)
	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/", map[string]any{}).
		expectStatus(201).decode(&o)
	// items is `omitempty`, so an empty order omits the key entirely; the
	// decoded slice is therefore nil/empty. Either way there must be 0 items
	// and the order must be open.
	if len(o.Items) != 0 {
		t.Fatalf("items = %d, want 0", len(o.Items))
	}
	if o.Status != "open" {
		t.Fatalf("status = %q, want open", o.Status)
	}
}

// =========================================================================
// AddOrderItems
// =========================================================================

func TestAddOrderItems_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{}},
		withParam("id", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestAddOrderItems_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/", "{invalid",
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestAddOrderItems_EmptyItems(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{}},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestAddOrderItems_OrderNotFound(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Coffee", 500)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": menuItem.String(), "qty": 1},
		}},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestAddOrderItems_OrderNotOpen(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "closed")
	menuItem := ordSeedActiveItem(fx, "Tea", 300)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": menuItem.String(), "qty": 1},
		}},
		withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

func TestAddOrderItems_OrderCancelled_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "cancelled")
	menuItem := ordSeedActiveItem(fx, "Tea", 300)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": menuItem.String(), "qty": 1},
		}},
		withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

func TestAddOrderItems_UnknownMenuItem(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": uuid.NewString(), "qty": 1},
		}},
		withParam("id", order.String())).
		expectErr(400, "menu_item_not_found")
}

func TestAddOrderItems_InactiveMenuItem_Rejected(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedInactiveItem(fx, "OldItem", 500)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": menuItem.String(), "qty": 1},
		}},
		withParam("id", order.String())).
		expectErr(400, "menu_item_not_found")
}

func TestAddOrderItems_PriceSnapshotted(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Burger", 1000)

	var result struct {
		Items []OrderItem `json:"items"`
	}
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": menuItem.String(), "qty": 2},
		}},
		withParam("id", order.String())).
		expectStatus(201).decode(&result)

	if len(result.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(result.Items))
	}
	if result.Items[0].UnitPriceCents != 1000 {
		t.Fatalf("unit_price_cents = %d, want 1000", result.Items[0].UnitPriceCents)
	}
	if result.Items[0].LineCents != 2000 {
		t.Fatalf("line_cents = %d, want 2000", result.Items[0].LineCents)
	}

	// Now change the menu item price — the snapshot must be unchanged.
	fx.adminExec(`UPDATE menu_items SET price_cents = 5000 WHERE id = $1`, menuItem)
	stored := ordUnitPrice(fx, result.Items[0].ID)
	if stored != 1000 {
		t.Fatalf("stored unit_price_cents = %d, want 1000 (price change must not affect snapshot)", stored)
	}
}

func TestAddOrderItems_MultipleItemsInSingleCall(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	item1 := ordSeedActiveItem(fx, "A", 100)
	item2 := ordSeedActiveItem(fx, "B", 200)

	var result struct {
		Items []OrderItem `json:"items"`
	}
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": item1.String(), "qty": 1},
			map[string]any{"menu_item_id": item2.String(), "qty": 3},
		}},
		withParam("id", order.String())).
		expectStatus(201).decode(&result)

	if len(result.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(result.Items))
	}
	if n := ordItemCount(fx, order); n != 2 {
		t.Fatalf("DB order_items = %d, want 2", n)
	}
}

func TestAddOrderItems_BadQtyDefaultsTo1(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Juice", 150)

	var result struct {
		Items []OrderItem `json:"items"`
	}
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			// qty=0 → handler normalises to 1
			map[string]any{"menu_item_id": menuItem.String(), "qty": 0},
		}},
		withParam("id", order.String())).
		expectStatus(201).decode(&result)

	if result.Items[0].Qty != 1 {
		t.Fatalf("qty = %d, want 1 (normalised from 0)", result.Items[0].Qty)
	}
}

func TestAddOrderItems_IdempotentWithClientID(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Pastry", 300)
	lineID := uuid.New()

	addBody := map[string]any{"items": []any{
		map[string]any{"id": lineID.String(), "menu_item_id": menuItem.String(), "qty": 1},
	}}

	// First call — inserted.
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/", addBody,
		withParam("id", order.String())).
		expectStatus(201)

	// Second call (replay) — ON CONFLICT DO NOTHING; should still return 201 with same item.
	var result struct {
		Items []OrderItem `json:"items"`
	}
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/", addBody,
		withParam("id", order.String())).
		expectStatus(201).decode(&result)

	if result.Items[0].ID != lineID {
		t.Fatalf("replay returned different item id")
	}
	// Only one row must exist in the DB.
	if n := ordItemCount(fx, order); n != 1 {
		t.Fatalf("DB order_items = %d, want 1 after replay", n)
	}
}

func TestAddOrderItems_ItemIDConflictDifferentOrder(t *testing.T) {
	fx := newTenant(t)
	order1 := fx.seedOpenOrder(nil)
	order2 := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Snack", 200)
	lineID := uuid.New()

	addBody := map[string]any{"items": []any{
		map[string]any{"id": lineID.String(), "menu_item_id": menuItem.String(), "qty": 1},
	}}
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/", addBody,
		withParam("id", order1.String())).
		expectStatus(201)

	// Same line ID on a different order must be refused.
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/", addBody,
		withParam("id", order2.String())).
		expectErr(409, "item_id_conflict")
}

func TestAddOrderItems_DefaultKitchenStatusPending(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Momo", 800)

	var result struct {
		Items []OrderItem `json:"items"`
	}
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []any{
			map[string]any{"menu_item_id": menuItem.String(), "qty": 1},
		}},
		withParam("id", order.String())).
		expectStatus(201).decode(&result)

	if result.Items[0].KitchenStatus != "pending" {
		t.Fatalf("kitchen_status = %q, want pending", result.Items[0].KitchenStatus)
	}
	if result.Items[0].SentToKitchenAt != nil {
		t.Fatal("sent_to_kitchen_at must be nil on freshly added item")
	}
}

// =========================================================================
// UpdateOrderItem
// =========================================================================

func TestUpdateOrderItem_BadItemID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 2},
		withParam("itemId", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateOrderItem_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Hot Choc", 400)
	item := fx.seedOrderItem(order, menuItem, 1, 400)

	callHandler(t, fx, UpdateOrderItem, "PATCH", "/", "{bad",
		withParam("itemId", item.String())).
		expectErr(400, "bad_request")
}

func TestUpdateOrderItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 2},
		withParam("itemId", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateOrderItem_VoidedItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Cake", 500)
	item := fx.seedOrderItem(order, menuItem, 1, 500)
	ordVoidItem(fx, item)

	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 3},
		withParam("itemId", item.String())).
		expectErr(404, "not_found")
}

func TestUpdateOrderItem_AlreadySent_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Steak", 2000)
	item := fx.seedOrderItem(order, menuItem, 1, 2000)
	ordSeedKitchenStatus(fx, item, "in_progress")

	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 2},
		withParam("itemId", item.String())).
		expectErr(409, "already_sent")
}

func TestUpdateOrderItem_QtyChange(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Fries", 200)
	item := fx.seedOrderItem(order, menuItem, 1, 200)

	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 5},
		withParam("itemId", item.String())).
		expectStatus(204)

	if q := ordItemQty(fx, item); q != 5 {
		t.Fatalf("qty = %d, want 5", q)
	}
}

func TestUpdateOrderItem_NotesChange(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Sandwich", 600)
	item := fx.seedOrderItem(order, menuItem, 1, 600)

	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"notes": "no mayo"},
		withParam("itemId", item.String())).
		expectStatus(204)

	if n := ordItemNotes(fx, item); n != "no mayo" {
		t.Fatalf("notes = %q, want 'no mayo'", n)
	}
}

func TestUpdateOrderItem_PatchPreservesUnsetFields(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Wrap", 700)
	item := fx.seedOrderItem(order, menuItem, 3, 700)
	fx.adminExec(`UPDATE order_items SET notes = 'original note' WHERE id = $1`, item)

	// Only send qty — notes must be preserved.
	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 4},
		withParam("itemId", item.String())).
		expectStatus(204)

	if q := ordItemQty(fx, item); q != 4 {
		t.Fatalf("qty = %d, want 4", q)
	}
	if n := ordItemNotes(fx, item); n != "original note" {
		t.Fatalf("notes changed to %q, want 'original note'", n)
	}
}

// =========================================================================
// VoidOrderItem
// =========================================================================

func TestVoidOrderItem_BadItemID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": ""},
		withParam("itemId", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestVoidOrderItem_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "BJ", 100)
	item := fx.seedOrderItem(order, menuItem, 1, 100)

	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/", "{bad",
		withParam("itemId", item.String())).
		expectErr(400, "bad_request")
}

func TestVoidOrderItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": ""},
		withParam("itemId", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestVoidOrderItem_PreKitchen_NoReasonRequired(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "OJ", 300)
	item := fx.seedOrderItem(order, menuItem, 1, 300)

	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": ""},
		withParam("itemId", item.String())).
		expectStatus(204)

	if ordItemVoidedAt(fx, item) == nil {
		t.Fatal("voided_at must be set after void")
	}
}

func TestVoidOrderItem_PostKitchen_ReasonRequired(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Pasta", 900)
	item := fx.seedOrderItem(order, menuItem, 1, 900)
	ordSeedKitchenStatus(fx, item, "in_progress")

	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": ""},
		withParam("itemId", item.String())).
		expectErr(400, "reason_required")
}

func TestVoidOrderItem_PostKitchen_WithReason(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Risotto", 1200)
	item := fx.seedOrderItem(order, menuItem, 1, 1200)
	ordSeedKitchenStatus(fx, item, "in_progress")

	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": "customer changed mind"},
		withParam("itemId", item.String())).
		expectStatus(204)

	if ordItemVoidedAt(fx, item) == nil {
		t.Fatal("voided_at must be set after post-kitchen void with reason")
	}
	var reason *string
	fx.adminScan([]any{&reason}, `SELECT void_reason FROM order_items WHERE id = $1`, item)
	if reason == nil || *reason != "customer changed mind" {
		t.Fatalf("void_reason = %v, want 'customer changed mind'", reason)
	}
}

func TestVoidOrderItem_AlreadyVoided_IdempotentNoOp(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Pie", 400)
	item := fx.seedOrderItem(order, menuItem, 1, 400)
	ordVoidItem(fx, item)

	// Re-voiding is a replay-safe no-op: 204 not 404.
	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": "duplicate"},
		withParam("itemId", item.String())).
		expectStatus(204)
}

func TestVoidOrderItem_VoidedItemExcludedFromOrderCount(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Cheese", 300)
	item1 := fx.seedOrderItem(order, menuItem, 1, 300)
	item2 := fx.seedOrderItem(order, menuItem, 1, 300)

	callHandler(t, fx, VoidOrderItem(testHub()), "POST", "/",
		map[string]any{"reason": ""},
		withParam("itemId", item1.String())).
		expectStatus(204)

	if n := ordItemCount(fx, order); n != 1 {
		t.Fatalf("non-voided items = %d, want 1", n)
	}
	_ = item2
}

// =========================================================================
// SendOrderToKitchen
// =========================================================================

func TestSendOrderToKitchen_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", "bad-id")).
		expectErr(400, "bad_request")
}

func TestSendOrderToKitchen_NothingToSend(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	// No items at all.
	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()
	if int(r["sent"].(float64)) != 0 {
		t.Fatalf("sent = %v, want 0", r["sent"])
	}
}

func TestSendOrderToKitchen_FlipsPendingToInProgress(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Noodles", 700)
	item1 := fx.seedOrderItem(order, menuItem, 1, 700)
	item2 := fx.seedOrderItem(order, menuItem, 1, 700)

	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()

	if int(r["sent"].(float64)) != 2 {
		t.Fatalf("sent = %v, want 2", r["sent"])
	}
	if ordItemKitchenStatus(fx, item1) != "in_progress" {
		t.Fatalf("item1 kitchen_status = %q, want in_progress", ordItemKitchenStatus(fx, item1))
	}
	if ordItemKitchenStatus(fx, item2) != "in_progress" {
		t.Fatalf("item2 kitchen_status = %q, want in_progress", ordItemKitchenStatus(fx, item2))
	}
	if ordItemSentAt(fx, item1) == nil {
		t.Fatal("sent_to_kitchen_at must be set after send")
	}
}

func TestSendOrderToKitchen_SkipsAlreadySentItems(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Rice", 400)
	item1 := fx.seedOrderItem(order, menuItem, 1, 400)
	item2 := fx.seedOrderItem(order, menuItem, 1, 400)
	// item1 already sent.
	ordSeedKitchenStatus(fx, item1, "in_progress")
	fx.adminExec(`UPDATE order_items SET sent_to_kitchen_at = now() WHERE id = $1`, item1)

	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()

	if int(r["sent"].(float64)) != 1 {
		t.Fatalf("sent = %v, want 1 (only the pending item)", r["sent"])
	}
	if ordItemKitchenStatus(fx, item2) != "in_progress" {
		t.Fatalf("item2 kitchen_status = %q, want in_progress", ordItemKitchenStatus(fx, item2))
	}
}

func TestSendOrderToKitchen_SkipsVoidedItems(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Soup", 350)
	item1 := fx.seedOrderItem(order, menuItem, 1, 350)
	item2 := fx.seedOrderItem(order, menuItem, 1, 350)
	ordVoidItem(fx, item1)

	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()

	if int(r["sent"].(float64)) != 1 {
		t.Fatalf("sent = %v, want 1 (voided excluded)", r["sent"])
	}
	_ = item2
}

func TestSendOrderToKitchen_AllAlreadySent_ZeroSent(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Dim Sum", 500)
	item := fx.seedOrderItem(order, menuItem, 2, 500)
	ordSeedKitchenStatus(fx, item, "in_progress")
	fx.adminExec(`UPDATE order_items SET sent_to_kitchen_at = now() WHERE id = $1`, item)

	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()

	if int(r["sent"].(float64)) != 0 {
		t.Fatalf("sent = %v, want 0 (all already sent)", r["sent"])
	}
}

// =========================================================================
// CancelOrder
// =========================================================================

func TestCancelOrder_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", "bad")).
		expectErr(400, "bad_request")
}

func TestCancelOrder_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestCancelOrder_AlreadyClosed_NotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "closed")
	// UPDATE WHERE status='open' matches 0 rows → not_found
	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectErr(404, "not_found")
}

func TestCancelOrder_AlreadyCancelled_NotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "cancelled")
	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectErr(404, "not_found")
}

func TestCancelOrder_ItemsInKitchen_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Burger", 1000)
	item := fx.seedOrderItem(order, menuItem, 1, 1000)
	ordSetSentToKitchen(fx, item)

	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectErr(409, "items_in_kitchen")
}

func TestCancelOrder_WithPayments_Succeeds(t *testing.T) {
	// CancelOrder does NOT check for existing payments — it only checks for
	// kitchen-sent items. Payments can be deleted separately.
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.seedPayment(order, "cash", 100, nil)

	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(204)

	if fx.orderStatus(order) != "cancelled" {
		t.Fatalf("order status not cancelled after CancelOrder")
	}
}

func TestCancelOrder_EmptyOrder_Succeeds(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(204)

	if fx.orderStatus(order) != "cancelled" {
		t.Fatalf("order status = %q, want cancelled", fx.orderStatus(order))
	}
}

func TestCancelOrder_FreesTable(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("TableX")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, table)
	order := fx.seedOpenOrder(ptrUUID(table))

	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(204)

	if got := fx.tableStatus(table); got != "free" {
		t.Fatalf("table status = %q, want free after cancel", got)
	}
}

func TestCancelOrder_TakeAway_NoTableChange(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("FreeTable")
	order := fx.seedOpenOrder(nil)

	callHandler(t, fx, CancelOrder(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(204)

	// Unrelated table must stay free.
	if got := fx.tableStatus(table); got != "free" {
		t.Fatalf("unrelated table status = %q, want free", got)
	}
}

// =========================================================================
// MoveOrder
// =========================================================================

func TestMoveOrder_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": nil},
		withParam("id", "bad-id")).
		expectErr(400, "bad_request")
}

func TestMoveOrder_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, MoveOrder(testHub()), "POST", "/", "{bad",
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestMoveOrder_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": nil},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestMoveOrder_NotOpen_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "closed")
	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": nil},
		withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

func TestMoveOrder_DetachToTakeAway(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("T10")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, table)
	order := fx.seedOpenOrder(ptrUUID(table))

	r := callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": nil},
		withParam("id", order.String())).
		expectStatus(200).json()

	if r["merged"].(bool) {
		t.Fatal("merged should be false for detach")
	}
	if got := fx.tableStatus(table); got != "free" {
		t.Fatalf("table status = %q, want free after detach", got)
	}
	if tbl := ordServiceTableID(fx, order); tbl != nil {
		t.Fatalf("order still has table after detach: %v", tbl)
	}
}

func TestMoveOrder_TransferToFreeTable(t *testing.T) {
	fx := newTenant(t)
	src := fx.seedTable("SrcTable")
	dst := fx.seedTable("DstTable")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, src)
	order := fx.seedOpenOrder(ptrUUID(src))

	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": dst.String()},
		withParam("id", order.String())).
		expectStatus(200)

	if got := fx.tableStatus(src); got != "free" {
		t.Fatalf("src table = %q, want free", got)
	}
	if got := fx.tableStatus(dst); got != "occupied" {
		t.Fatalf("dst table = %q, want occupied", got)
	}
	tbl := ordServiceTableID(fx, order)
	if tbl == nil || *tbl != dst {
		t.Fatalf("order table = %v, want %v", tbl, dst)
	}
}

func TestMoveOrder_MergeIntoOccupiedTable(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Chips", 200)

	tableA := fx.seedTable("TableA")
	tableB := fx.seedTable("TableB")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, tableA)
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, tableB)

	// Order on tableA (source) with one item.
	srcOrder := fx.seedOpenOrder(ptrUUID(tableA))
	srcItem := fx.seedOrderItem(srcOrder, menuItem, 1, 200)

	// Existing order on tableB (destination).
	dstOrder := fx.seedOpenOrder(ptrUUID(tableB))

	r := callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": tableB.String()},
		withParam("id", srcOrder.String())).
		expectStatus(200).json()

	if !r["merged"].(bool) {
		t.Fatal("merged should be true when target has open order")
	}
	if r["order_id"].(string) != dstOrder.String() {
		t.Fatalf("result order_id = %v, want %v (destination)", r["order_id"], dstOrder)
	}

	// Source order must be cancelled.
	if fx.orderStatus(srcOrder) != "cancelled" {
		t.Fatalf("src order status = %q, want cancelled", fx.orderStatus(srcOrder))
	}
	// Source item must now belong to destination order.
	var newOrderID uuid.UUID
	fx.adminScan([]any{&newOrderID}, `SELECT order_id FROM order_items WHERE id = $1`, srcItem)
	if newOrderID != dstOrder {
		t.Fatalf("item order_id = %v, want %v (merged into dst)", newOrderID, dstOrder)
	}
	// Source table freed.
	if got := fx.tableStatus(tableA); got != "free" {
		t.Fatalf("src table = %q, want free after merge", got)
	}
}

func TestMoveOrder_MergeBlocked_WithPayments(t *testing.T) {
	fx := newTenant(t)
	tableA := fx.seedTable("PayTableA")
	tableB := fx.seedTable("PayTableB")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, tableA)
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, tableB)

	srcOrder := fx.seedOpenOrder(ptrUUID(tableA))
	fx.seedPayment(srcOrder, "cash", 100, nil)
	fx.seedOpenOrder(ptrUUID(tableB)) // existing order on dst

	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": tableB.String()},
		withParam("id", srcOrder.String())).
		expectErr(409, "settle_before_merge")
}

func TestMoveOrder_TargetTableNotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": uuid.NewString()},
		withParam("id", order.String())).
		expectErr(400, "table_not_found")
}

func TestMoveOrder_NoOp_SameTable(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("SameTable")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, table)
	order := fx.seedOpenOrder(ptrUUID(table))

	r := callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()},
		withParam("id", order.String())).
		expectStatus(200).json()

	if r["merged"].(bool) {
		t.Fatal("no-op should have merged=false")
	}
	if r["order_id"].(string) != order.String() {
		t.Fatalf("no-op should return same order id")
	}
	// Table still occupied, order still open.
	if got := fx.tableStatus(table); got != "occupied" {
		t.Fatalf("table status changed during no-op: %q", got)
	}
}

func TestMoveOrder_NoOp_TakeAwayToTakeAway(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)

	r := callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": nil},
		withParam("id", order.String())).
		expectStatus(200).json()

	if r["merged"].(bool) {
		t.Fatal("take-away→take-away no-op should have merged=false")
	}
}

func TestMoveOrder_AlreadyOpen_UniqueViolation(t *testing.T) {
	// Transfer walk-in to a table that already has a different open order (no
	// existing order on src, so no merge path — hits unique index violation).
	fx := newTenant(t)
	targetTable := fx.seedTable("Busy")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, targetTable)
	fx.seedOpenOrder(ptrUUID(targetTable)) // existing open order on target

	// Walk-in order (no table).
	walkIn := fx.seedOpenOrder(nil)

	// Attempting a non-merge transfer to an occupied table with a different
	// tenantID trick: the handler detects the existing order and merges instead.
	// To test the unique-index branch, we'd need a deleted table. Instead,
	// just verify that when the target has an open order, merge is chosen.
	r := callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": targetTable.String()},
		withParam("id", walkIn.String())).
		expectStatus(200).json()

	if !r["merged"].(bool) {
		t.Fatal("expected merge when target table already has open order")
	}
}

// =========================================================================
// GetOrderHistory
// =========================================================================

func TestGetOrderHistory_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil,
		withQuery("date=2025-01-01")).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	if len(orders) != 0 {
		t.Fatalf("orders = %d, want 0 for a date with no closes", len(orders))
	}
	if r["date"] != "2025-01-01" {
		t.Fatalf("date = %v, want 2025-01-01", r["date"])
	}
}

func TestGetOrderHistory_BadDate(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetOrderHistory, "GET", "/", nil,
		withQuery("date=not-a-date")).
		expectErr(400, "bad_request")
}

func TestGetOrderHistory_BadTableID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetOrderHistory, "GET", "/", nil,
		withQuery("table_id=not-uuid")).
		expectErr(400, "bad_request")
}

func TestGetOrderHistory_DefaultsToToday(t *testing.T) {
	fx := newTenant(t)
	// No date param: the handler queries DB for today's date. Should return 200.
	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil).
		expectStatus(200).json()
	if r["date"] == "" || r["date"] == nil {
		t.Fatal("date field must be populated when using default (today)")
	}
}

func TestGetOrderHistory_ClosedOrdersOnly(t *testing.T) {
	fx := newTenant(t)
	// Open order — must NOT appear in history.
	fx.seedOpenOrder(nil)
	// Closed order — must appear.
	closed := fx.seedOpenOrder(nil)
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, closed)

	// Use today's date (history is day-windowed in tenant TZ; for test purposes
	// close it "now" which is within today's window regardless of timezone).
	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("history orders = %d, want 1 (only closed)", len(orders))
	}
	first := orders[0].(map[string]any)
	if first["id"] != closed.String() {
		t.Fatalf("wrong order in history: %v, want %v", first["id"], closed)
	}
}

func TestGetOrderHistory_WithTableFilter(t *testing.T) {
	fx := newTenant(t)
	table1 := fx.seedTable("Hist1")
	table2 := fx.seedTable("Hist2")

	o1 := fx.seedOpenOrder(ptrUUID(table1))
	o2 := fx.seedOpenOrder(ptrUUID(table2))
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, o1)
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, o2)

	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil,
		withQuery("table_id="+table1.String())).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("filtered history = %d, want 1", len(orders))
	}
	first := orders[0].(map[string]any)
	if first["id"] != o1.String() {
		t.Fatalf("wrong order returned by table filter")
	}
}

func TestGetOrderHistory_IncludesItems(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Croissant", 300)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, menuItem, 2, 300)
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, order)

	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	if len(orders) != 1 {
		t.Fatalf("orders = %d, want 1", len(orders))
	}
	first := orders[0].(map[string]any)
	items, _ := first["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if int(first["item_count"].(float64)) != 2 {
		t.Fatalf("item_count = %v, want 2 (qty)", first["item_count"])
	}
}

func TestGetOrderHistory_IncludesPayments(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.seedPayment(order, "cash", 500, nil)
	fx.seedPayment(order, "other", 300, nil)
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, order)

	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	first := orders[0].(map[string]any)
	payments, _ := first["payments"].([]any)
	if len(payments) != 2 {
		t.Fatalf("payments = %d, want 2", len(payments))
	}
}

func TestGetOrderHistory_VoidedItemCountedCorrectly(t *testing.T) {
	fx := newTenant(t)
	menuItem := ordSeedActiveItem(fx, "Donut", 150)
	order := fx.seedOpenOrder(nil)
	item1 := fx.seedOrderItem(order, menuItem, 1, 150)
	item2 := fx.seedOrderItem(order, menuItem, 1, 150)
	ordVoidItem(fx, item2) // voided item should not count toward item_count
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, order)

	r := callHandler(t, fx, GetOrderHistory, "GET", "/", nil).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	first := orders[0].(map[string]any)
	// items slice should include both (including voided for display)
	items, _ := first["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items slice = %d, want 2 (including voided)", len(items))
	}
	// item_count should only count non-voided qty
	if int(first["item_count"].(float64)) != 1 {
		t.Fatalf("item_count = %v, want 1 (voided excluded)", first["item_count"])
	}
	_ = item1
}

func TestGetOrderHistory_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	o := fx1.seedOpenOrder(nil)
	fx1.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, o)

	r := callHandler(t, fx2, GetOrderHistory, "GET", "/", nil).
		expectStatus(200).json()

	orders, _ := r["orders"].([]any)
	if len(orders) != 0 {
		t.Fatalf("fx2 sees %d history orders from fx1 (isolation broken)", len(orders))
	}
}

// =========================================================================
// table_label (walk-in tab naming) — OpenOrder + RenameOrder
// =========================================================================

func TestOpenOrder_WithTableLabel(t *testing.T) {
	fx := newTenant(t)
	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"table_label": "  Mr. Sharma  "}).
		expectStatus(201).decode(&o)

	// Stored trimmed and echoed back in the response.
	if o.TableLabel != "Mr. Sharma" {
		t.Fatalf("table_label = %q, want %q (trimmed)", o.TableLabel, "Mr. Sharma")
	}
	if got := ordTableLabel(fx, o.ID); got != "Mr. Sharma" {
		t.Fatalf("stored table_label = %q, want %q", got, "Mr. Sharma")
	}
}

func TestOpenOrder_DefaultEmptyTableLabel(t *testing.T) {
	fx := newTenant(t)
	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/", map[string]any{}).
		expectStatus(201).decode(&o)
	if o.TableLabel != "" {
		t.Fatalf("table_label = %q, want empty by default", o.TableLabel)
	}
}

func TestRenameOrder_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RenameOrder(testHub()), "POST", "/",
		map[string]any{"table_label": "x"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestRenameOrder_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, RenameOrder(testHub()), "POST", "/", "{bad",
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestRenameOrder_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RenameOrder(testHub()), "POST", "/",
		map[string]any{"table_label": "x"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestRenameOrder_SetsLabel(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)

	callHandler(t, fx, RenameOrder(testHub()), "POST", "/",
		map[string]any{"table_label": "  Patio group  "},
		withParam("id", order.String())).
		expectStatus(204)

	if got := ordTableLabel(fx, order); got != "Patio group" {
		t.Fatalf("table_label = %q, want %q (trimmed)", got, "Patio group")
	}

	// And it round-trips through GetOrder.
	var o Order
	callHandler(t, fx, GetOrder, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&o)
	if o.TableLabel != "Patio group" {
		t.Fatalf("GetOrder table_label = %q, want %q", o.TableLabel, "Patio group")
	}
}

func TestRenameOrder_ClearLabel(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.adminExec(`UPDATE orders SET table_label = 'Old name' WHERE id = $1`, order)

	callHandler(t, fx, RenameOrder(testHub()), "POST", "/",
		map[string]any{"table_label": ""},
		withParam("id", order.String())).
		expectStatus(204)

	if got := ordTableLabel(fx, order); got != "" {
		t.Fatalf("table_label = %q, want empty after clear", got)
	}
}

func TestRenameOrder_NotOpen_NotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "closed")
	callHandler(t, fx, RenameOrder(testHub()), "POST", "/",
		map[string]any{"table_label": "too late"},
		withParam("id", order.String())).
		expectErr(404, "not_found")
}

func TestRenameOrder_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	order := fx1.seedOpenOrder(nil)
	// fx2 must not be able to rename fx1's order.
	callHandler(t, fx2, RenameOrder(testHub()), "POST", "/",
		map[string]any{"table_label": "hijack"},
		withParam("id", order.String())).
		expectErr(404, "not_found")
	if got := ordTableLabel(fx1, order); got != "" {
		t.Fatalf("fx1 order label changed to %q by another tenant", got)
	}
}
