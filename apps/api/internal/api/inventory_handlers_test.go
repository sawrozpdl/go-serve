package api

// Integration tests for inventory.go:
//   - ListInventoryItems
//   - CreateInventoryItem
//   - UpdateInventoryItem
//   - DeleteInventoryItem
//   - ListInventoryMovements
//   - AdjustInventory
//   - ListPackRules
//   - CreatePackRule
//   - DeletePackRule
//   - GetMenuItemLink
//   - PutMenuItemLink

import (
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// inventory fixture helpers (domain-prefixed: inv*)
// =========================================================================

// invSeedItem inserts an inventory_item row directly via the admin pool and
// returns its id. kind must be "retail" or "ingredient".
func (fx *fixture) invSeedItem(name, kind, saleUnit string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO inventory_items (tenant_id, name, kind, sale_unit)
		 VALUES ($1, $2, $3::inventory_item_kind, $4) RETURNING id`,
		fx.Tenant, name, kind, saleUnit)
	return id
}

// invSeedItemWithPar inserts an inventory_item with a custom par_low_units.
func (fx *fixture) invSeedItemWithPar(name string, parLow string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO inventory_items (tenant_id, name, kind, sale_unit, par_low_units)
		 VALUES ($1, $2, 'retail', 'unit', $3::numeric) RETURNING id`,
		fx.Tenant, name, parLow)
	return id
}

// invSeedMovement inserts a stock_movement row directly.
func (fx *fixture) invSeedMovement(itemID uuid.UUID, delta, reason string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, notes, by_user_id)
		 VALUES ($1, $2, $3::numeric, $4::stock_movement_reason, 'seeded', $5) RETURNING id`,
		fx.Tenant, itemID, delta, reason, fx.User)
	return id
}

// invSeedPackRule inserts a pack_rule row directly.
func (fx *fixture) invSeedPackRule(itemID uuid.UUID, containerUnit string, containerQty int, saleUnit string, saleQty int) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO pack_rules (tenant_id, inventory_item_id, container_unit, container_qty, sale_unit, sale_qty_per_container)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		fx.Tenant, itemID, containerUnit, containerQty, saleUnit, saleQty)
	return id
}

// invQtyOnHand reads the current qty_on_hand_units (as text) for an item.
func (fx *fixture) invQtyOnHand(itemID uuid.UUID) string {
	fx.t.Helper()
	var qty string
	fx.adminScan([]any{&qty},
		`SELECT qty_on_hand_units::text FROM inventory_items WHERE id = $1`, itemID)
	return qty
}

// invLastCost reads last_purchase_unit_cost_cents for an item.
func (fx *fixture) invLastCost(itemID uuid.UUID) *int64 {
	fx.t.Helper()
	var cost *int64
	fx.adminScan([]any{&cost},
		`SELECT last_purchase_unit_cost_cents FROM inventory_items WHERE id = $1`, itemID)
	return cost
}

// invItemDeleted returns true if the item has a non-null deleted_at.
func (fx *fixture) invItemDeleted(itemID uuid.UUID) bool {
	fx.t.Helper()
	var deleted bool
	fx.adminScan([]any{&deleted},
		`SELECT deleted_at IS NOT NULL FROM inventory_items WHERE id = $1`, itemID)
	return deleted
}

// invSeedMenuItemLink creates a menu_item_inventory_link row directly.
func (fx *fixture) invSeedMenuItemLink(menuItemID, invItemID uuid.UUID, qtyPerSale string) {
	fx.t.Helper()
	fx.adminExec(
		`INSERT INTO menu_item_inventory_link (menu_item_id, tenant_id, inventory_item_id, qty_consumed_per_sale)
		 VALUES ($1, $2, $3, $4::numeric)
		 ON CONFLICT (menu_item_id) DO UPDATE
		   SET inventory_item_id = EXCLUDED.inventory_item_id,
		       qty_consumed_per_sale = EXCLUDED.qty_consumed_per_sale`,
		menuItemID, fx.Tenant, invItemID, qtyPerSale)
}

// =========================================================================
// ListInventoryItems
// =========================================================================

func TestListInventoryItems_EmptyResult(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0", len(items))
	}
}

func TestListInventoryItems_ReturnsActiveOnly(t *testing.T) {
	fx := newTenant(t)
	// Create two items — then soft-delete one.
	id1 := fx.invSeedItem("Sugar", "ingredient", "kg")
	id2 := fx.invSeedItem("Cups", "retail", "unit")
	// soft-delete id2
	fx.adminExec(`UPDATE inventory_items SET deleted_at = now() WHERE id = $1`, id2)

	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1 (deleted excluded)", len(items))
	}
	first := items[0].(map[string]any)
	if first["id"] != id1.String() {
		t.Fatalf("got item id %v, want %v", first["id"], id1)
	}
}

func TestListInventoryItems_OrderedByName(t *testing.T) {
	fx := newTenant(t)
	fx.invSeedItem("Zebra", "retail", "unit")
	fx.invSeedItem("Apple", "retail", "unit")
	fx.invSeedItem("Mango", "ingredient", "kg")

	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	names := []string{
		items[0].(map[string]any)["name"].(string),
		items[1].(map[string]any)["name"].(string),
		items[2].(map[string]any)["name"].(string),
	}
	if names[0] != "Apple" || names[1] != "Mango" || names[2] != "Zebra" {
		t.Fatalf("order = %v, want [Apple Mango Zebra]", names)
	}
}

func TestListInventoryItems_LowStockFlag(t *testing.T) {
	fx := newTenant(t)
	// item with par = 5, qty = 3 → low stock
	id := fx.invSeedItemWithPar("Coffee Beans", "5")
	// Set qty to 3 via a movement so the trigger updates it.
	fx.invSeedMovement(id, "3", "purchase")

	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	item := items[0].(map[string]any)
	if item["is_low_stock"] != true {
		t.Fatalf("is_low_stock = %v, want true", item["is_low_stock"])
	}
}

func TestListInventoryItems_NotLowStockAbovePar(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItemWithPar("Milk", "2")
	fx.invSeedMovement(id, "10", "purchase")

	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	item := items[0].(map[string]any)
	if item["is_low_stock"] != false {
		t.Fatalf("is_low_stock = %v, want false (qty 10 > par 2)", item["is_low_stock"])
	}
}

func TestListInventoryItems_ZeroParNeverLowStock(t *testing.T) {
	fx := newTenant(t)
	// par = 0 (default) → low-stock logic: par > 0 AND qty <= par → always false
	fx.invSeedItem("Salt", "ingredient", "g")

	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	item := items[0].(map[string]any)
	if item["is_low_stock"] != false {
		t.Fatalf("is_low_stock = %v, want false when par = 0", item["is_low_stock"])
	}
}

func TestListInventoryItems_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.invSeedItem("ItemA", "retail", "unit")
	// fx2 has no items

	r := callHandler(t, fx2, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("tenant isolation broken: fx2 sees %d items, want 0", len(items))
	}
}

// =========================================================================
// CreateInventoryItem
// =========================================================================

func TestCreateInventoryItem_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInventoryItem, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateInventoryItem_MissingName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"kind": "retail", "sale_unit": "unit"}).
		expectErr(400, "bad_request")
}

func TestCreateInventoryItem_BlankName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "", "kind": "retail"}).
		expectErr(400, "bad_request")
}

func TestCreateInventoryItem_DefaultsApplied(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "Espresso Beans"}).
		expectStatus(201)
	var it InventoryItem
	r.decode(&it)
	if it.Kind != "retail" {
		t.Fatalf("kind = %q, want retail (default)", it.Kind)
	}
	if it.SaleUnit != "unit" {
		t.Fatalf("sale_unit = %q, want unit (default)", it.SaleUnit)
	}
	if it.ParLowUnits != "0.000" {
		t.Fatalf("par_low_units = %q, want 0 (default)", it.ParLowUnits)
	}
	if it.QtyOnHandUnits != "0.000" {
		t.Fatalf("qty_on_hand = %q, want 0", it.QtyOnHandUnits)
	}
}

func TestCreateInventoryItem_InvalidKindFallsBackToRetail(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "Mystery Item", "kind": "bogus"}).
		expectStatus(201)
	var it InventoryItem
	r.decode(&it)
	if it.Kind != "retail" {
		t.Fatalf("kind = %q, want retail for unknown kind input", it.Kind)
	}
}

func TestCreateInventoryItem_IngredientKind(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "Flour", "kind": "ingredient", "sale_unit": "kg"}).
		expectStatus(201)
	var it InventoryItem
	r.decode(&it)
	if it.Kind != "ingredient" {
		t.Fatalf("kind = %q, want ingredient", it.Kind)
	}
	if it.SaleUnit != "kg" {
		t.Fatalf("sale_unit = %q, want kg", it.SaleUnit)
	}
}

func TestCreateInventoryItem_WithSKU(t *testing.T) {
	fx := newTenant(t)
	sku := "SKU-001"
	r := callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "Widget", "sku": sku}).
		expectStatus(201)
	var it InventoryItem
	r.decode(&it)
	if it.SKU == nil || *it.SKU != sku {
		t.Fatalf("sku = %v, want %q", it.SKU, sku)
	}
}

func TestCreateInventoryItem_WithParLowUnits(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "Coffee", "par_low_units": "10.5"}).
		expectStatus(201)
	var it InventoryItem
	r.decode(&it)
	if it.ParLowUnits != "10.500" {
		t.Fatalf("par_low_units = %q, want 10.5", it.ParLowUnits)
	}
}

func TestCreateInventoryItem_DBSideEffect(t *testing.T) {
	fx := newTenant(t)
	if n := fx.countRows("inventory_items"); n != 0 {
		t.Fatalf("pre-count = %d, want 0", n)
	}
	callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "New Item"}).
		expectStatus(201)
	if n := fx.countRows("inventory_items"); n != 1 {
		t.Fatalf("post-count = %d, want 1", n)
	}
}

func TestCreateInventoryItem_ReturnedIDIsUUID(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateInventoryItem, "POST", "/",
		map[string]any{"name": "Item"}).
		expectStatus(201)
	var it InventoryItem
	r.decode(&it)
	if it.ID == uuid.Nil {
		t.Fatal("id is nil uuid")
	}
}

// =========================================================================
// UpdateInventoryItem
// =========================================================================

func TestUpdateInventoryItem_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"name": "X"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateInventoryItem_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", "{bad json",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateInventoryItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"name": "X"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateInventoryItem_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	fx.adminExec(`UPDATE inventory_items SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"name": "New Name"},
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestUpdateInventoryItem_UpdateName(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Old Name", "retail", "unit")
	r := callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"name": "New Name"},
		withParam("id", id.String())).
		expectStatus(200)
	var it InventoryItem
	r.decode(&it)
	if it.Name != "New Name" {
		t.Fatalf("name = %q, want New Name", it.Name)
	}
	if it.ID != id {
		t.Fatalf("id = %v, want %v", it.ID, id)
	}
}

func TestUpdateInventoryItem_UpdateKind(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	r := callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"kind": "ingredient"},
		withParam("id", id.String())).
		expectStatus(200)
	var it InventoryItem
	r.decode(&it)
	if it.Kind != "ingredient" {
		t.Fatalf("kind = %q, want ingredient", it.Kind)
	}
}

func TestUpdateInventoryItem_UpdateParLowUnits(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	r := callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"par_low_units": "25"},
		withParam("id", id.String())).
		expectStatus(200)
	var it InventoryItem
	r.decode(&it)
	if it.ParLowUnits != "25.000" {
		t.Fatalf("par_low_units = %q, want 25", it.ParLowUnits)
	}
}

func TestUpdateInventoryItem_PartialUpdatePreservesOtherFields(t *testing.T) {
	fx := newTenant(t)
	// Create with all fields set.
	sku := "SKU-99"
	id := uuid.Nil
	fx.adminScan([]any{&id},
		`INSERT INTO inventory_items (tenant_id, name, sku, kind, sale_unit, par_low_units, notes)
		 VALUES ($1, 'Widget', $2, 'ingredient', 'kg', 5, 'important notes') RETURNING id`,
		fx.Tenant, sku)

	// Only update the name; all other fields should be unchanged.
	r := callHandler(t, fx, UpdateInventoryItem, "PATCH", "/", map[string]any{"name": "Updated Widget"},
		withParam("id", id.String())).
		expectStatus(200)
	var it InventoryItem
	r.decode(&it)
	if it.Kind != "ingredient" {
		t.Fatalf("kind changed: got %q", it.Kind)
	}
	if it.SaleUnit != "kg" {
		t.Fatalf("sale_unit changed: got %q", it.SaleUnit)
	}
	if it.SKU == nil || *it.SKU != sku {
		t.Fatalf("sku changed: got %v", it.SKU)
	}
}

// =========================================================================
// DeleteInventoryItem
// =========================================================================

func TestDeleteInventoryItem_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteInventoryItem, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteInventoryItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteInventoryItem, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteInventoryItem_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Gone", "retail", "unit")
	fx.adminExec(`UPDATE inventory_items SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, DeleteInventoryItem, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestDeleteInventoryItem_Success_SoftDelete(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, DeleteInventoryItem, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	// Verify soft-delete: row still exists but has deleted_at set.
	if !fx.invItemDeleted(id) {
		t.Fatal("item not soft-deleted: deleted_at is NULL after delete")
	}
}

func TestDeleteInventoryItem_DoesNotAppearInList(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("ToDelete", "retail", "unit")
	callHandler(t, fx, DeleteInventoryItem, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	r := callHandler(t, fx, ListInventoryItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("list items = %d after delete, want 0", len(items))
	}
}

// =========================================================================
// ListInventoryMovements
// =========================================================================

func TestListInventoryMovements_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestListInventoryMovements_EmptyForNewItem(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	r := callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	mvts, _ := r["movements"].([]any)
	if len(mvts) != 0 {
		t.Fatalf("movements = %d, want 0 for new item", len(mvts))
	}
	if total := int64(r["total"].(float64)); total != 0 {
		t.Fatalf("total = %d, want 0", total)
	}
}

func TestListInventoryMovements_ReturnsMovements(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Rice", "ingredient", "kg")
	fx.invSeedMovement(id, "10", "purchase")
	fx.invSeedMovement(id, "-2", "waste")

	r := callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	mvts, _ := r["movements"].([]any)
	if len(mvts) != 2 {
		t.Fatalf("movements = %d, want 2", len(mvts))
	}
	if total := int64(r["total"].(float64)); total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
}

func TestListInventoryMovements_OrderedDescByAt(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Beans", "ingredient", "kg")
	// Seed with explicit timestamps to ensure ordering.
	fx.adminExec(
		`INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, notes, by_user_id, at)
		 VALUES ($1, $2, 5, 'purchase', 'first', $3, now() - interval '2 minutes')`,
		fx.Tenant, id, fx.User)
	fx.adminExec(
		`INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, notes, by_user_id, at)
		 VALUES ($1, $2, -1, 'waste', 'second', $3, now() - interval '1 minute')`,
		fx.Tenant, id, fx.User)

	r := callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	mvts, _ := r["movements"].([]any)
	if len(mvts) != 2 {
		t.Fatalf("movements = %d, want 2", len(mvts))
	}
	// Most-recent first: the "waste" (-1) was inserted later.
	first := mvts[0].(map[string]any)
	if first["reason"] != "waste" {
		t.Fatalf("first movement reason = %q, want waste (desc order)", first["reason"])
	}
}

func TestListInventoryMovements_LimitAndOffset(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Wheat", "ingredient", "kg")
	for i := 0; i < 5; i++ {
		fx.invSeedMovement(id, "1", "purchase")
	}

	// limit=2
	r := callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id.String()),
		withQuery("limit=2")).
		expectStatus(200).json()
	mvts, _ := r["movements"].([]any)
	if len(mvts) != 2 {
		t.Fatalf("limit=2 → got %d movements, want 2", len(mvts))
	}
	// total should still reflect all 5 rows.
	if total := int64(r["total"].(float64)); total != 5 {
		t.Fatalf("total = %d, want 5", total)
	}

	// offset=3 → 2 remaining.
	r2 := callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id.String()),
		withQuery("offset=3")).
		expectStatus(200).json()
	mvts2, _ := r2["movements"].([]any)
	if len(mvts2) != 2 {
		t.Fatalf("offset=3 → got %d movements, want 2", len(mvts2))
	}
}

func TestListInventoryMovements_LimitCappedAt200(t *testing.T) {
	// This test checks that the handler enforces the max-200 cap without
	// blowing up. We just verify a limit=300 request succeeds.
	fx := newTenant(t)
	id := fx.invSeedItem("Cap", "retail", "unit")
	r := callHandler(t, fx, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id.String()),
		withQuery("limit=300")).
		expectStatus(200).json()
	mvts, _ := r["movements"].([]any)
	if len(mvts) != 0 {
		t.Fatalf("expected empty for new item, got %d", len(mvts))
	}
}

func TestListInventoryMovements_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id1 := fx1.invSeedItem("Item", "retail", "unit")
	// Insert a movement for fx1's item through admin — bypasses RLS.
	fx1.invSeedMovement(id1, "5", "purchase")

	// fx2 tries to list movements for fx1's item ID.
	r := callHandler(t, fx2, ListInventoryMovements, "GET", "/", nil,
		withParam("id", id1.String())).
		expectStatus(200).json()
	mvts, _ := r["movements"].([]any)
	// RLS means fx2 can't see fx1's stock_movements.
	if len(mvts) != 0 {
		t.Fatalf("tenant isolation broken: fx2 sees %d movements for fx1's item", len(mvts))
	}
}

// =========================================================================
// AdjustInventory
// =========================================================================

func TestAdjustInventory_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "5", "reason": "purchase", "notes": "x"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestAdjustInventory_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, AdjustInventory, "POST", "/", "{bad json",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestAdjustInventory_MissingDeltaUnits(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"reason": "purchase", "notes": "x"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestAdjustInventory_BlankDeltaUnits(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "", "reason": "purchase", "notes": "x"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestAdjustInventory_MissingNotes(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "5", "reason": "purchase"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestAdjustInventory_BlankNotes(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "5", "reason": "purchase", "notes": ""},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestAdjustInventory_BadReason(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "5", "reason": "invented", "notes": "x"},
		withParam("id", id.String())).
		expectErr(400, "bad_reason")
}

func TestAdjustInventory_AllValidReasons(t *testing.T) {
	for _, reason := range []string{"purchase", "waste", "adjust", "transfer"} {
		t.Run(reason, func(t *testing.T) {
			fx := newTenant(t)
			id := fx.invSeedItem("Item-"+reason, "retail", "unit")
			delta := "3"
			if reason == "waste" || reason == "transfer" {
				delta = "-3"
				// Pre-seed some stock so waste doesn't go negative in a way
				// that violates any constraint.
				fx.invSeedMovement(id, "10", "purchase")
			}
			callHandler(t, fx, AdjustInventory, "POST", "/",
				map[string]any{"delta_units": delta, "reason": reason, "notes": "valid reason test"},
				withParam("id", id.String())).
				expectStatus(201)
		})
	}
}

func TestAdjustInventory_PurchaseIncreasesQty(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Flour", "ingredient", "kg")

	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "10", "reason": "purchase", "notes": "weekly delivery"},
		withParam("id", id.String())).
		expectStatus(201)

	qty := fx.invQtyOnHand(id)
	if qty != "10.000" {
		t.Fatalf("qty_on_hand = %q, want 10.000", qty)
	}
}

func TestAdjustInventory_WasteDecreasesQty(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Milk", "ingredient", "L")
	// Stock up first.
	fx.invSeedMovement(id, "20", "purchase")

	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "-5", "reason": "waste", "notes": "spilled"},
		withParam("id", id.String())).
		expectStatus(201)

	qty := fx.invQtyOnHand(id)
	if qty != "15.000" {
		t.Fatalf("qty_on_hand = %q, want 15.000 (20 - 5)", qty)
	}
}

func TestAdjustInventory_DecimalDeltaUnits(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Sugar", "ingredient", "kg")

	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "2.5", "reason": "purchase", "notes": "partial bag"},
		withParam("id", id.String())).
		expectStatus(201)

	qty := fx.invQtyOnHand(id)
	if qty != "2.500" {
		t.Fatalf("qty_on_hand = %q, want 2.500", qty)
	}
}

func TestAdjustInventory_NegativeAdjust(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Rice", "ingredient", "kg")
	fx.invSeedMovement(id, "50", "purchase")

	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "-15", "reason": "adjust", "notes": "recount"},
		withParam("id", id.String())).
		expectStatus(201)

	qty := fx.invQtyOnHand(id)
	if qty != "35.000" {
		t.Fatalf("qty_on_hand = %q, want 35.000 (50 - 15)", qty)
	}
}

func TestAdjustInventory_PurchaseStoresUnitCost(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Butter", "ingredient", "kg")
	cost := int64(500)

	r := callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{
			"delta_units":     "2",
			"reason":          "purchase",
			"notes":           "bulk buy",
			"unit_cost_cents": cost,
		},
		withParam("id", id.String())).
		expectStatus(201)

	var m StockMovement
	r.decode(&m)
	if m.UnitCostCents == nil || *m.UnitCostCents != cost {
		t.Fatalf("unit_cost_cents = %v, want %d", m.UnitCostCents, cost)
	}
	// Trigger should have updated last_purchase_unit_cost_cents on the item.
	lastCost := fx.invLastCost(id)
	if lastCost == nil || *lastCost != cost {
		t.Fatalf("last_purchase_unit_cost_cents = %v, want %d", lastCost, cost)
	}
}

func TestAdjustInventory_NonPurchaseCostIsCleared(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Coffee", "ingredient", "kg")
	fx.invSeedMovement(id, "10", "purchase")

	// Provide unit_cost_cents with a waste reason — handler should strip it.
	r := callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{
			"delta_units":     "-2",
			"reason":          "waste",
			"notes":           "expired",
			"unit_cost_cents": int64(100),
		},
		withParam("id", id.String())).
		expectStatus(201)

	var m StockMovement
	r.decode(&m)
	if m.UnitCostCents != nil {
		t.Fatalf("unit_cost_cents = %v, want nil for non-purchase reason", m.UnitCostCents)
	}
}

func TestAdjustInventory_ReturnedMovementFields(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Tea", "ingredient", "bag")

	r := callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "7", "reason": "adjust", "notes": "correction"},
		withParam("id", id.String())).
		expectStatus(201)

	var m StockMovement
	r.decode(&m)
	if m.ID == uuid.Nil {
		t.Fatal("movement id is nil uuid")
	}
	if m.InventoryItemID != id {
		t.Fatalf("inventory_item_id = %v, want %v", m.InventoryItemID, id)
	}
	if m.DeltaUnits != "7.000" {
		t.Fatalf("delta_units = %q, want 7", m.DeltaUnits)
	}
	if m.Reason != "adjust" {
		t.Fatalf("reason = %q, want adjust", m.Reason)
	}
	if m.RefType == nil || *m.RefType != "manual" {
		t.Fatalf("ref_type = %v, want manual", m.RefType)
	}
	if m.Notes != "correction" {
		t.Fatalf("notes = %q, want correction", m.Notes)
	}
	if m.ByUserID == nil || *m.ByUserID != fx.User {
		t.Fatalf("by_user_id = %v, want %v", m.ByUserID, fx.User)
	}
}

func TestAdjustInventory_AccumulatesMultipleMovements(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Eggs", "retail", "dozen")

	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "12", "reason": "purchase", "notes": "batch 1"},
		withParam("id", id.String())).
		expectStatus(201)
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "6", "reason": "purchase", "notes": "batch 2"},
		withParam("id", id.String())).
		expectStatus(201)
	callHandler(t, fx, AdjustInventory, "POST", "/",
		map[string]any{"delta_units": "-3", "reason": "waste", "notes": "broken"},
		withParam("id", id.String())).
		expectStatus(201)

	qty := fx.invQtyOnHand(id)
	if qty != "15.000" {
		t.Fatalf("qty_on_hand = %q, want 15.000 (12+6-3)", qty)
	}
	if n := fx.countRows("stock_movements"); n != 3 {
		t.Fatalf("stock_movements = %d, want 3", n)
	}
}

// =========================================================================
// ListPackRules
// =========================================================================

func TestListPackRules_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListPackRules, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestListPackRules_EmptyForNewItem(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	r := callHandler(t, fx, ListPackRules, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	rules, _ := r["pack_rules"].([]any)
	if len(rules) != 0 {
		t.Fatalf("pack_rules = %d, want 0", len(rules))
	}
}

func TestListPackRules_ReturnsRules(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Beer", "retail", "bottle")
	fx.invSeedPackRule(id, "case", 24, "bottle", 24)
	fx.invSeedPackRule(id, "sixpack", 6, "bottle", 6)

	r := callHandler(t, fx, ListPackRules, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	rules, _ := r["pack_rules"].([]any)
	if len(rules) != 2 {
		t.Fatalf("pack_rules = %d, want 2", len(rules))
	}
}

func TestListPackRules_OrderedByContainerQty(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Soda", "retail", "can")
	fx.invSeedPackRule(id, "pallet", 120, "can", 120)
	fx.invSeedPackRule(id, "case", 24, "can", 24)
	fx.invSeedPackRule(id, "sixpack", 6, "can", 6)

	r := callHandler(t, fx, ListPackRules, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	rules, _ := r["pack_rules"].([]any)
	if len(rules) != 3 {
		t.Fatalf("pack_rules = %d, want 3", len(rules))
	}
	// Ordered ascending by container_qty.
	qtys := []float64{
		rules[0].(map[string]any)["container_qty"].(float64),
		rules[1].(map[string]any)["container_qty"].(float64),
		rules[2].(map[string]any)["container_qty"].(float64),
	}
	if qtys[0] != 6 || qtys[1] != 24 || qtys[2] != 120 {
		t.Fatalf("container_qty order = %v, want [6 24 120]", qtys)
	}
}

func TestListPackRules_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id1 := fx1.invSeedItem("Item", "retail", "unit")
	fx1.invSeedPackRule(id1, "box", 12, "unit", 12)

	r := callHandler(t, fx2, ListPackRules, "GET", "/", nil,
		withParam("id", id1.String())).
		expectStatus(200).json()
	rules, _ := r["pack_rules"].([]any)
	if len(rules) != 0 {
		t.Fatalf("tenant isolation broken: fx2 sees %d pack_rules for fx1's item", len(rules))
	}
}

// =========================================================================
// CreatePackRule
// =========================================================================

func TestCreatePackRule_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"container_unit": "box", "sale_unit": "unit", "sale_qty_per_container": 12},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestCreatePackRule_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, CreatePackRule, "POST", "/", "{bad json",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreatePackRule_MissingContainerUnit(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"sale_unit": "unit", "sale_qty_per_container": 12},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreatePackRule_MissingSaleUnit(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"container_unit": "box", "sale_qty_per_container": 12},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreatePackRule_ZeroSaleQty(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"container_unit": "box", "sale_unit": "unit", "sale_qty_per_container": 0},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreatePackRule_NegativeSaleQty(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"container_unit": "box", "sale_unit": "unit", "sale_qty_per_container": -5},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreatePackRule_ZeroContainerQtyDefaultsToOne(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Water", "retail", "bottle")
	r := callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{
			"container_unit":         "case",
			"container_qty":          0, // zero → should default to 1
			"sale_unit":              "bottle",
			"sale_qty_per_container": 24,
		},
		withParam("id", id.String())).
		expectStatus(201)
	var p PackRule
	r.decode(&p)
	if p.ContainerQty != 1 {
		t.Fatalf("container_qty = %d, want 1 (default when <=0)", p.ContainerQty)
	}
}

func TestCreatePackRule_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Juice", "retail", "bottle")
	r := callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{
			"container_unit":         "case",
			"container_qty":          12,
			"sale_unit":              "bottle",
			"sale_qty_per_container": 12,
		},
		withParam("id", id.String())).
		expectStatus(201)

	var p PackRule
	r.decode(&p)
	if p.ID == uuid.Nil {
		t.Fatal("id is nil uuid")
	}
	if p.InventoryItemID != id {
		t.Fatalf("inventory_item_id = %v, want %v", p.InventoryItemID, id)
	}
	if p.ContainerUnit != "case" {
		t.Fatalf("container_unit = %q, want case", p.ContainerUnit)
	}
	if p.ContainerQty != 12 {
		t.Fatalf("container_qty = %d, want 12", p.ContainerQty)
	}
	if p.SaleUnit != "bottle" {
		t.Fatalf("sale_unit = %q, want bottle", p.SaleUnit)
	}
	if p.SaleQtyPerContainer != 12 {
		t.Fatalf("sale_qty_per_container = %d, want 12", p.SaleQtyPerContainer)
	}
	if n := fx.countRows("pack_rules"); n != 1 {
		t.Fatalf("pack_rules count = %d, want 1", n)
	}
}

func TestCreatePackRule_MultipleRulesPerItem(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Chips", "retail", "bag")
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"container_unit": "box", "container_qty": 20, "sale_unit": "bag", "sale_qty_per_container": 20},
		withParam("id", id.String())).
		expectStatus(201)
	callHandler(t, fx, CreatePackRule, "POST", "/",
		map[string]any{"container_unit": "pallet", "container_qty": 100, "sale_unit": "bag", "sale_qty_per_container": 100},
		withParam("id", id.String())).
		expectStatus(201)
	if n := fx.countRows("pack_rules"); n != 2 {
		t.Fatalf("pack_rules = %d, want 2", n)
	}
}

// =========================================================================
// DeletePackRule
// =========================================================================

func TestDeletePackRule_BadRuleID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeletePackRule, "DELETE", "/", nil,
		withParam("ruleId", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeletePackRule_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeletePackRule, "DELETE", "/", nil,
		withParam("ruleId", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeletePackRule_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	ruleID := fx.invSeedPackRule(id, "box", 10, "unit", 10)

	callHandler(t, fx, DeletePackRule, "DELETE", "/", nil,
		withParam("ruleId", ruleID.String())).
		expectStatus(204)
	if n := fx.countRows("pack_rules"); n != 0 {
		t.Fatalf("pack_rules = %d, want 0 after delete", n)
	}
}

func TestDeletePackRule_DeleteOnlyTargetedRule(t *testing.T) {
	fx := newTenant(t)
	id := fx.invSeedItem("Item", "retail", "unit")
	ruleID1 := fx.invSeedPackRule(id, "box", 10, "unit", 10)
	_ = fx.invSeedPackRule(id, "pallet", 100, "unit", 100)

	callHandler(t, fx, DeletePackRule, "DELETE", "/", nil,
		withParam("ruleId", ruleID1.String())).
		expectStatus(204)
	if n := fx.countRows("pack_rules"); n != 1 {
		t.Fatalf("pack_rules = %d, want 1 (only target deleted)", n)
	}
}

func TestDeletePackRule_TenantIsolation(t *testing.T) {
	// fx2 must not be able to delete fx1's pack rule, even if it knows the ID.
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id1 := fx1.invSeedItem("Item", "retail", "unit")
	ruleID := fx1.invSeedPackRule(id1, "box", 10, "unit", 10)

	callHandler(t, fx2, DeletePackRule, "DELETE", "/", nil,
		withParam("ruleId", ruleID.String())).
		expectErr(404, "not_found")
	// Rule should still exist.
	var n int
	fx1.adminScan([]any{&n}, `SELECT count(*) FROM pack_rules WHERE id = $1`, ruleID)
	if n != 1 {
		t.Fatalf("pack_rule deleted by other tenant!")
	}
}

// =========================================================================
// GetMenuItemLink
// =========================================================================

func TestGetMenuItemLink_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetMenuItemLink, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestGetMenuItemLink_NoLink_ReturnsNullBody(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Espresso", 300)

	// A menu item with no inventory link should return 200 with null body.
	r := callHandler(t, fx, GetMenuItemLink, "GET", "/", nil,
		withParam("id", menuItem.String())).
		expectStatus(200)
	// Body should be "null\n" for a nil JSON response.
	body := string(r.Body)
	if body != "null\n" {
		// Might also be valid as empty JSON object — check it's not a link.
		var l *MenuItemInventoryLink
		r.decode(&l)
		if l != nil {
			t.Fatalf("expected null link, got %+v", l)
		}
	}
}

func TestGetMenuItemLink_WithLink(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Latte", 400)
	invItem := fx.invSeedItem("Milk", "ingredient", "L")
	fx.invSeedMenuItemLink(menuItem, invItem, "0.25")

	r := callHandler(t, fx, GetMenuItemLink, "GET", "/", nil,
		withParam("id", menuItem.String())).
		expectStatus(200)
	var l MenuItemInventoryLink
	r.decode(&l)
	if l.MenuItemID != menuItem {
		t.Fatalf("menu_item_id = %v, want %v", l.MenuItemID, menuItem)
	}
	if l.InventoryItemID != invItem {
		t.Fatalf("inventory_item_id = %v, want %v", l.InventoryItemID, invItem)
	}
	if l.QtyConsumedPerSale != "0.250" {
		t.Fatalf("qty_consumed_per_sale = %q, want 0.250", l.QtyConsumedPerSale)
	}
}

func TestGetMenuItemLink_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	cat := fx1.seedCategory("Cat")
	menuItem := fx1.seedMenuItem(cat, "Item", 100)
	invItem := fx1.invSeedItem("Inv", "retail", "unit")
	fx1.invSeedMenuItemLink(menuItem, invItem, "1")

	// fx2 tries to look up fx1's menu item link — should get null (not found via RLS).
	r := callHandler(t, fx2, GetMenuItemLink, "GET", "/", nil,
		withParam("id", menuItem.String())).
		expectStatus(200)
	body := string(r.Body)
	if body != "null\n" {
		var l *MenuItemInventoryLink
		r.decode(&l)
		if l != nil {
			t.Fatalf("tenant isolation broken: fx2 sees fx1's link")
		}
	}
}

// =========================================================================
// PutMenuItemLink
// =========================================================================

func TestPutMenuItemLink_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{"inventory_item_id": uuid.NewString(), "qty_consumed_per_sale": "1"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestPutMenuItemLink_BadJSON(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Item", 100)
	callHandler(t, fx, PutMenuItemLink, "PUT", "/", "{bad json",
		withParam("id", menuItem.String())).
		expectErr(400, "bad_request")
}

func TestPutMenuItemLink_NullInventoryItemIDDeletesLink(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Cappuccino", 500)
	invItem := fx.invSeedItem("Milk", "ingredient", "L")
	fx.invSeedMenuItemLink(menuItem, invItem, "0.2")

	// Verify link exists.
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM menu_item_inventory_link WHERE menu_item_id = $1`, menuItem)
	if n != 1 {
		t.Fatalf("pre-check: link count = %d, want 1", n)
	}

	callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{"inventory_item_id": nil},
		withParam("id", menuItem.String())).
		expectStatus(204)

	fx.adminScan([]any{&n},
		`SELECT count(*) FROM menu_item_inventory_link WHERE menu_item_id = $1`, menuItem)
	if n != 0 {
		t.Fatalf("link count = %d, want 0 after null-id delete", n)
	}
}

func TestPutMenuItemLink_NullInventoryItemIDNoLinkIsNoOp(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Flat White", 450)
	// No link exists. Sending null should be a no-op (204).
	callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{"inventory_item_id": nil},
		withParam("id", menuItem.String())).
		expectStatus(204)
}

func TestPutMenuItemLink_CreateLink(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Americano", 350)
	invItem := fx.invSeedItem("Coffee Beans", "ingredient", "g")

	r := callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{
			"inventory_item_id":     invItem.String(),
			"qty_consumed_per_sale": "15",
		},
		withParam("id", menuItem.String())).
		expectStatus(200)

	var l MenuItemInventoryLink
	r.decode(&l)
	if l.MenuItemID != menuItem {
		t.Fatalf("menu_item_id = %v, want %v", l.MenuItemID, menuItem)
	}
	if l.InventoryItemID != invItem {
		t.Fatalf("inventory_item_id = %v, want %v", l.InventoryItemID, invItem)
	}
	if l.QtyConsumedPerSale != "15.000" {
		t.Fatalf("qty_consumed_per_sale = %q, want 15", l.QtyConsumedPerSale)
	}
}

func TestPutMenuItemLink_DefaultQtyConsumedIsOne(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Tea", 200)
	invItem := fx.invSeedItem("Tea Bags", "ingredient", "unit")

	r := callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{
			"inventory_item_id": invItem.String(),
			// no qty_consumed_per_sale → should default to "1"
		},
		withParam("id", menuItem.String())).
		expectStatus(200)

	var l MenuItemInventoryLink
	r.decode(&l)
	if l.QtyConsumedPerSale != "1.000" {
		t.Fatalf("qty_consumed_per_sale = %q, want 1 (default)", l.QtyConsumedPerSale)
	}
}

func TestPutMenuItemLink_UpsertChangesInventoryItem(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Mocha", 550)
	invItem1 := fx.invSeedItem("Milk", "ingredient", "L")
	invItem2 := fx.invSeedItem("Oat Milk", "ingredient", "L")

	// Create initial link.
	callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{"inventory_item_id": invItem1.String(), "qty_consumed_per_sale": "0.2"},
		withParam("id", menuItem.String())).
		expectStatus(200)

	// Upsert to a different inventory item.
	r := callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{"inventory_item_id": invItem2.String(), "qty_consumed_per_sale": "0.3"},
		withParam("id", menuItem.String())).
		expectStatus(200)

	var l MenuItemInventoryLink
	r.decode(&l)
	if l.InventoryItemID != invItem2 {
		t.Fatalf("upserted inventory_item_id = %v, want %v", l.InventoryItemID, invItem2)
	}
	if l.QtyConsumedPerSale != "0.300" {
		t.Fatalf("qty_consumed_per_sale = %q, want 0.3", l.QtyConsumedPerSale)
	}
	// Should still be exactly one link row.
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM menu_item_inventory_link WHERE menu_item_id = $1`, menuItem)
	if n != 1 {
		t.Fatalf("link count = %d after upsert, want 1", n)
	}
}

func TestPutMenuItemLink_DecimalQtyConsumed(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	menuItem := fx.seedMenuItem(cat, "Half Shot", 250)
	invItem := fx.invSeedItem("Beans", "ingredient", "g")

	r := callHandler(t, fx, PutMenuItemLink, "PUT", "/",
		map[string]any{"inventory_item_id": invItem.String(), "qty_consumed_per_sale": "7.5"},
		withParam("id", menuItem.String())).
		expectStatus(200)

	var l MenuItemInventoryLink
	r.decode(&l)
	if l.QtyConsumedPerSale != "7.500" {
		t.Fatalf("qty_consumed_per_sale = %q, want 7.5", l.QtyConsumedPerSale)
	}
}

// =========================================================================
// trimNumeric (pure unit tests)
// =========================================================================

func TestTrimNumeric(t *testing.T) {
	cases := map[string]string{
		"2.000":  "2",
		"0.050":  "0.05",
		"10.100": "10.1",
		"5":      "5",
		"0":      "0",
		"1.500":  "1.5",
		"100.00": "100",
	}
	for in, want := range cases {
		if got := trimNumeric(in); got != want {
			t.Errorf("trimNumeric(%q) = %q, want %q", in, got, want)
		}
	}
}
