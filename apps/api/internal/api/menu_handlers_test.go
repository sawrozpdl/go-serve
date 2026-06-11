package api

import (
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// ListMenuCategories
// =========================================================================

func TestListMenuCategories_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListMenuCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 0 {
		t.Fatalf("categories = %d, want 0", len(cats))
	}
}

func TestListMenuCategories_WithRows(t *testing.T) {
	fx := newTenant(t)
	fx.seedCategory("Coffee")
	fx.seedCategory("Snacks")
	r := callHandler(t, fx, ListMenuCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 2 {
		t.Fatalf("categories = %d, want 2", len(cats))
	}
}

func TestListMenuCategories_SoftDeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("To Be Deleted")
	// Soft-delete it directly.
	fx.adminExec(`UPDATE menu_categories SET deleted_at = now() WHERE id = $1`, catID)
	r := callHandler(t, fx, ListMenuCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 0 {
		t.Fatalf("categories = %d after soft-delete, want 0", len(cats))
	}
}

func TestListMenuCategories_ItemCountReflectsLiveItems(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Beverages")
	// Seed two items, soft-delete one.
	itemA := fx.seedMenuItem(catID, "Latte", 500)
	fx.seedMenuItem(catID, "Espresso", 400)
	fx.adminExec(`UPDATE menu_items SET deleted_at = now() WHERE id = $1`, itemA)

	r := callHandler(t, fx, ListMenuCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 1 {
		t.Fatalf("want 1 category, got %d", len(cats))
	}
	cat := cats[0].(map[string]any)
	if got := int(cat["item_count"].(float64)); got != 1 {
		t.Fatalf("item_count = %d, want 1 (deleted item should not count)", got)
	}
}

func TestListMenuCategories_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedCategory("Tenant1Cat")
	// fx2 sees nothing from fx1's categories.
	r := callHandler(t, fx2, ListMenuCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 0 {
		t.Fatalf("tenant isolation violated: fx2 sees %d categories", len(cats))
	}
}

// =========================================================================
// CreateMenuCategory
// =========================================================================

func TestCreateMenuCategory_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateMenuCategory, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateMenuCategory_MissingName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"sort": 1}).
		expectErr(400, "bad_request")
}

func TestCreateMenuCategory_BlankName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"name": ""}).
		expectErr(400, "bad_request")
}

func TestCreateMenuCategory_Success(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"name": "Desserts", "sort": 5}).
		expectStatus(201)

	var c MenuCategory
	r.decode(&c)
	if c.Name != "Desserts" {
		t.Fatalf("name = %q, want Desserts", c.Name)
	}
	if c.Sort != 5 {
		t.Fatalf("sort = %d, want 5", c.Sort)
	}
	if !c.IsActive {
		t.Fatal("new category should be active")
	}
	if c.ID == uuid.Nil {
		t.Fatal("id should be set")
	}
	if n := fx.countRows("menu_categories"); n != 1 {
		t.Fatalf("menu_categories rows = %d, want 1", n)
	}
}

func TestCreateMenuCategory_WithOptionalFields(t *testing.T) {
	fx := newTenant(t)
	color := "#ff0000"
	imgURL := "https://example.com/cat.jpg"
	r := callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{
			"name":      "Hot Drinks",
			"color":     color,
			"image_url": imgURL,
			"icon":      "coffee",
		}).
		expectStatus(201)

	var c MenuCategory
	r.decode(&c)
	if c.Color == nil || *c.Color != color {
		t.Fatalf("color = %v, want %q", c.Color, color)
	}
	if c.ImageURL == nil || *c.ImageURL != imgURL {
		t.Fatalf("image_url = %v, want %q", c.ImageURL, imgURL)
	}
	if c.Icon != "coffee" {
		t.Fatalf("icon = %q, want coffee", c.Icon)
	}
}

func TestCreateMenuCategory_ZeroSortDefault(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"name": "NullSort"}).
		expectStatus(201)
	var c MenuCategory
	r.decode(&c)
	if c.Sort != 0 {
		t.Fatalf("sort = %d, want 0 (default)", c.Sort)
	}
}

// The unique index is (tenant_id, lower(name)) WHERE deleted_at IS NULL.
// Two categories with the same name in the same tenant should produce an error
// from Postgres (constraint violation → internal_error from the handler since
// it does not special-case the unique constraint).
func TestCreateMenuCategory_DuplicateName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"name": "Duplicate"}).
		expectStatus(201)
	// Second attempt with the same name.
	callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"name": "Duplicate"}).
		expectStatus(500)
}

// =========================================================================
// UpdateMenuCategory
// =========================================================================

func TestUpdateMenuCategory_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateMenuCategory, "PATCH", "/", map[string]any{"name": "x"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateMenuCategory_BadJSON(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	callHandler(t, fx, UpdateMenuCategory, "PATCH", "/", "{bad",
		withParam("id", catID.String())).
		expectErr(400, "bad_request")
}

func TestUpdateMenuCategory_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"name": "New"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateMenuCategory_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("ToDelete")
	fx.adminExec(`UPDATE menu_categories SET deleted_at = now() WHERE id = $1`, catID)
	callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"name": "New"},
		withParam("id", catID.String())).
		expectErr(404, "not_found")
}

func TestUpdateMenuCategory_NameUpdate(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Old Name")
	r := callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"name": "New Name"},
		withParam("id", catID.String())).
		expectStatus(200)

	var c MenuCategory
	r.decode(&c)
	if c.Name != "New Name" {
		t.Fatalf("name = %q, want New Name", c.Name)
	}
	if c.ID != catID {
		t.Fatalf("id mismatch: got %v, want %v", c.ID, catID)
	}
}

func TestUpdateMenuCategory_SortUpdate(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("SortCat")
	r := callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"sort": 99},
		withParam("id", catID.String())).
		expectStatus(200)

	var c MenuCategory
	r.decode(&c)
	if c.Sort != 99 {
		t.Fatalf("sort = %d, want 99", c.Sort)
	}
}

func TestUpdateMenuCategory_DeactivateAndReactivate(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("ActiveCat")

	// Deactivate.
	r := callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"is_active": false},
		withParam("id", catID.String())).
		expectStatus(200)
	var c MenuCategory
	r.decode(&c)
	if c.IsActive {
		t.Fatal("is_active should be false after deactivation")
	}

	// Reactivate.
	r = callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"is_active": true},
		withParam("id", catID.String())).
		expectStatus(200)
	r.decode(&c)
	if !c.IsActive {
		t.Fatal("is_active should be true after reactivation")
	}
}

func TestUpdateMenuCategory_OmittedFieldsPreserved(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("KeepSort")
	// Set sort to 42 initially.
	callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"sort": 42},
		withParam("id", catID.String())).
		expectStatus(200)
	// Now update only name — sort should stay 42.
	r := callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"name": "NameOnly"},
		withParam("id", catID.String())).
		expectStatus(200)
	var c MenuCategory
	r.decode(&c)
	if c.Sort != 42 {
		t.Fatalf("sort = %d, want 42 (should be preserved)", c.Sort)
	}
	if c.Name != "NameOnly" {
		t.Fatalf("name = %q, want NameOnly", c.Name)
	}
}

// =========================================================================
// DeleteMenuCategory
// =========================================================================

func TestDeleteMenuCategory_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteMenuCategory_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteMenuCategory_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Gone")
	fx.adminExec(`UPDATE menu_categories SET deleted_at = now() WHERE id = $1`, catID)
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectErr(404, "not_found")
}

func TestDeleteMenuCategory_HasItemsBlocked(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("WithItems")
	fx.seedMenuItem(catID, "Latte", 500)
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectErr(409, "category_has_items")
}

func TestDeleteMenuCategory_HasItemsBlockedMultiple(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("MultiItems")
	fx.seedMenuItem(catID, "Item A", 100)
	fx.seedMenuItem(catID, "Item B", 200)
	fx.seedMenuItem(catID, "Item C", 300)
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectErr(409, "category_has_items")
}

// Soft-deleted items should NOT block category deletion.
func TestDeleteMenuCategory_SoftDeletedItemsDoNotBlock(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("EmptyAfterDelete")
	itemID := fx.seedMenuItem(catID, "Gone Item", 500)
	fx.adminExec(`UPDATE menu_items SET deleted_at = now() WHERE id = $1`, itemID)

	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectStatus(204)

	// Verify soft-deleted in DB.
	var deletedAt *string
	fx.adminScan([]any{&deletedAt},
		`SELECT deleted_at::text FROM menu_categories WHERE id = $1`, catID)
	if deletedAt == nil {
		t.Fatal("deleted_at should be set after delete")
	}
}

func TestDeleteMenuCategory_Success(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Empty Cat")
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectStatus(204)

	// Category should now be invisible to RLS/list query.
	r := callHandler(t, fx, ListMenuCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 0 {
		t.Fatalf("categories = %d after delete, want 0", len(cats))
	}
}

func TestDeleteMenuCategory_SecondDeleteFails(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("OneShot")
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectStatus(204)
	// Second delete should 404 because deleted_at IS NOT NULL.
	callHandler(t, fx, DeleteMenuCategory, "DELETE", "/", nil,
		withParam("id", catID.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// ListMenuItems
// =========================================================================

func TestListMenuItems_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0", len(items))
	}
}

func TestListMenuItems_WithRows(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Beverages")
	fx.seedMenuItem(catID, "Latte", 500)
	fx.seedMenuItem(catID, "Cappuccino", 450)
	r := callHandler(t, fx, ListMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}
}

func TestListMenuItems_SoftDeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Deleted Item", 500)
	fx.adminExec(`UPDATE menu_items SET deleted_at = now() WHERE id = $1`, itemID)
	r := callHandler(t, fx, ListMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d after soft-delete, want 0", len(items))
	}
}

func TestListMenuItems_FilterByCategoryID(t *testing.T) {
	fx := newTenant(t)
	catA := fx.seedCategory("Cat A")
	catB := fx.seedCategory("Cat B")
	fx.seedMenuItem(catA, "Item A1", 100)
	fx.seedMenuItem(catA, "Item A2", 200)
	fx.seedMenuItem(catB, "Item B1", 300)

	// Filter by catA.
	r := callHandler(t, fx, ListMenuItems, "GET", "/", nil,
		withQuery("category_id="+catA.String())).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items in catA = %d, want 2", len(items))
	}

	// Filter by catB.
	r = callHandler(t, fx, ListMenuItems, "GET", "/", nil,
		withQuery("category_id="+catB.String())).
		expectStatus(200).json()
	items, _ = r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items in catB = %d, want 1", len(items))
	}
}

func TestListMenuItems_PresetNotesNeverNull(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	fx.seedMenuItem(catID, "Plain", 100)
	r := callHandler(t, fx, ListMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	item := items[0].(map[string]any)
	notes, ok := item["preset_notes"]
	if !ok {
		t.Fatal("preset_notes field missing")
	}
	// Should be an array (possibly empty), not null.
	if notes == nil {
		t.Fatal("preset_notes should be [] not null")
	}
	arr, ok := notes.([]any)
	if !ok {
		t.Fatalf("preset_notes type = %T, want []any", notes)
	}
	if len(arr) != 0 {
		t.Fatalf("preset_notes = %v, want []", arr)
	}
}

func TestListMenuItems_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	catID := fx1.seedCategory("Cat")
	fx1.seedMenuItem(catID, "Tenant1Item", 100)

	r := callHandler(t, fx2, ListMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("tenant isolation violated: fx2 sees %d items", len(items))
	}
}

// =========================================================================
// CreateMenuItem
// =========================================================================

func TestCreateMenuItem_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateMenuItem, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateMenuItem_MissingName(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{"category_id": catID.String(), "price_cents": 500}).
		expectErr(400, "bad_request")
}

func TestCreateMenuItem_BlankName(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{"name": "", "category_id": catID.String(), "price_cents": 500}).
		expectErr(400, "bad_request")
}

func TestCreateMenuItem_MissingCategoryID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{"name": "Latte", "price_cents": 500}).
		expectErr(400, "bad_request")
}

func TestCreateMenuItem_NilCategoryID(t *testing.T) {
	fx := newTenant(t)
	// uuid.Nil as category_id should be rejected.
	callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{"name": "Latte", "category_id": uuid.Nil.String(), "price_cents": 500}).
		expectErr(400, "bad_request")
}

func TestCreateMenuItem_Success(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Beverages")
	r := callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":        "Latte",
			"category_id": catID.String(),
			"price_cents": 500,
			"sort":        3,
		}).
		expectStatus(201)

	var m MenuItem
	r.decode(&m)
	if m.Name != "Latte" {
		t.Fatalf("name = %q, want Latte", m.Name)
	}
	if m.PriceCents != 500 {
		t.Fatalf("price_cents = %d, want 500", m.PriceCents)
	}
	if m.CategoryID != catID {
		t.Fatalf("category_id mismatch")
	}
	if !m.IsActive {
		t.Fatal("new item should be active")
	}
	if m.IsFeatured {
		t.Fatal("new item should not be featured by default")
	}
	if m.Sort != 3 {
		t.Fatalf("sort = %d, want 3", m.Sort)
	}
	if n := fx.countRows("menu_items"); n != 1 {
		t.Fatalf("menu_items rows = %d, want 1", n)
	}
}

func TestCreateMenuItem_WithDescription(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Food")
	r := callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":        "Sandwich",
			"category_id": catID.String(),
			"price_cents": 800,
			"description": "Club sandwich with fries",
		}).
		expectStatus(201)
	var m MenuItem
	r.decode(&m)
	if m.Description != "Club sandwich with fries" {
		t.Fatalf("description = %q, want 'Club sandwich with fries'", m.Description)
	}
}

func TestCreateMenuItem_WithCostCents(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	cost := int64(200)
	r := callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":        "CostItem",
			"category_id": catID.String(),
			"price_cents": 500,
			"cost_cents":  cost,
		}).
		expectStatus(201)
	var m MenuItem
	r.decode(&m)
	if m.CostCents == nil || *m.CostCents != cost {
		t.Fatalf("cost_cents = %v, want %d", m.CostCents, cost)
	}
}

func TestCreateMenuItem_WithPresetNotes(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	r := callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":         "Tea",
			"category_id":  catID.String(),
			"price_cents":  300,
			"preset_notes": []string{"hot", "iced", "extra sugar"},
		}).
		expectStatus(201)
	var m MenuItem
	r.decode(&m)
	if len(m.PresetNotes) != 3 {
		t.Fatalf("preset_notes = %v, want 3 entries", m.PresetNotes)
	}
}

func TestCreateMenuItem_ZeroPriceCentsAllowed(t *testing.T) {
	// price_cents >= 0 is the DB constraint (zero is valid for complimentary items).
	fx := newTenant(t)
	catID := fx.seedCategory("Comp")
	r := callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":        "Free Water",
			"category_id": catID.String(),
			"price_cents": 0,
		}).
		expectStatus(201)
	var m MenuItem
	r.decode(&m)
	if m.PriceCents != 0 {
		t.Fatalf("price_cents = %d, want 0", m.PriceCents)
	}
}

func TestCreateMenuItem_SKUUniquePerTenant(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	sku := "SKU-001"
	callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":        "Item1",
			"category_id": catID.String(),
			"price_cents": 500,
			"sku":         sku,
		}).
		expectStatus(201)
	// Same SKU in same tenant → unique constraint violation → internal_error.
	callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{
			"name":        "Item2",
			"category_id": catID.String(),
			"price_cents": 500,
			"sku":         sku,
		}).
		expectStatus(500)
}

func TestCreateMenuItem_SKUSameAcrossTenantsAllowed(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	catID1 := fx1.seedCategory("Cat1")
	catID2 := fx2.seedCategory("Cat2")
	sku := "CROSS-SKU"
	callHandler(t, fx1, CreateMenuItem, "POST", "/",
		map[string]any{"name": "I1", "category_id": catID1.String(), "price_cents": 100, "sku": sku}).
		expectStatus(201)
	callHandler(t, fx2, CreateMenuItem, "POST", "/",
		map[string]any{"name": "I2", "category_id": catID2.String(), "price_cents": 100, "sku": sku}).
		expectStatus(201)
}

// =========================================================================
// UpdateMenuItem
// =========================================================================

func TestUpdateMenuItem_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"name": "x"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateMenuItem_BadJSON(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Item", 500)
	callHandler(t, fx, UpdateMenuItem, "PATCH", "/", "{bad",
		withParam("id", itemID.String())).
		expectErr(400, "bad_request")
}

func TestUpdateMenuItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	name := "Updated"
	callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"name": &name},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateMenuItem_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Item", 500)
	fx.adminExec(`UPDATE menu_items SET deleted_at = now() WHERE id = $1`, itemID)
	name := "New"
	callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"name": &name},
		withParam("id", itemID.String())).
		expectErr(404, "not_found")
}

func TestUpdateMenuItem_NameUpdate(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Old Name", 500)
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"name": "New Name"},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if m.Name != "New Name" {
		t.Fatalf("name = %q, want New Name", m.Name)
	}
}

func TestUpdateMenuItem_PriceUpdate(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Item", 500)
	newPrice := int64(750)
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"price_cents": newPrice},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if m.PriceCents != newPrice {
		t.Fatalf("price_cents = %d, want %d", m.PriceCents, newPrice)
	}
}

func TestUpdateMenuItem_DeactivateAndReactivate(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Active Item", 500)

	// Deactivate.
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"is_active": false},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if m.IsActive {
		t.Fatal("is_active should be false after deactivation")
	}

	// Reactivate.
	r = callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"is_active": true},
		withParam("id", itemID.String())).
		expectStatus(200)
	r.decode(&m)
	if !m.IsActive {
		t.Fatal("is_active should be true after reactivation")
	}
}

func TestUpdateMenuItem_SetFeatured(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Ordinary", 500)

	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"is_featured": true},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if !m.IsFeatured {
		t.Fatal("is_featured should be true after update")
	}
}

func TestUpdateMenuItem_UpdatePresetNotes(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Tea", 300)

	notes := []string{"hot", "iced"}
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"preset_notes": notes},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if len(m.PresetNotes) != 2 {
		t.Fatalf("preset_notes = %v, want 2 entries", m.PresetNotes)
	}
}

func TestUpdateMenuItem_ClearPresetNotes(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Tea2", 300)
	// First set some notes.
	callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"preset_notes": []string{"hot", "iced"}},
		withParam("id", itemID.String())).
		expectStatus(200)
	// Clear with empty array.
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"preset_notes": []string{}},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if len(m.PresetNotes) != 0 {
		t.Fatalf("preset_notes = %v after clear, want []", m.PresetNotes)
	}
}

func TestUpdateMenuItem_ChangeCategoryID(t *testing.T) {
	fx := newTenant(t)
	catA := fx.seedCategory("Cat A")
	catB := fx.seedCategory("Cat B")
	itemID := fx.seedMenuItem(catA, "Mover", 500)

	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"category_id": catB.String()},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if m.CategoryID != catB {
		t.Fatalf("category_id = %v, want %v", m.CategoryID, catB)
	}
}

func TestUpdateMenuItem_OmittedFieldsPreserved(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "OrigName", 500)
	// Update only sort — name must stay "OrigName".
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"sort": 77},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if m.Name != "OrigName" {
		t.Fatalf("name = %q, want OrigName (omitted fields preserved)", m.Name)
	}
	if m.Sort != 77 {
		t.Fatalf("sort = %d, want 77", m.Sort)
	}
}

// =========================================================================
// DeleteMenuItem
// =========================================================================

func TestDeleteMenuItem_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteMenuItem_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteMenuItem_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Item", 500)
	fx.adminExec(`UPDATE menu_items SET deleted_at = now() WHERE id = $1`, itemID)
	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", itemID.String())).
		expectErr(404, "not_found")
}

func TestDeleteMenuItem_Success(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Delete Me", 500)

	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", itemID.String())).
		expectStatus(204)

	// Item should be excluded from list after soft-delete.
	r := callHandler(t, fx, ListMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d after delete, want 0", len(items))
	}
}

func TestDeleteMenuItem_SecondDeleteFails(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "OneShot", 500)
	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", itemID.String())).
		expectStatus(204)
	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", itemID.String())).
		expectErr(404, "not_found")
}

// Deleting a menu item referenced by an order_item succeeds: DeleteMenuItem is
// a SOFT delete (sets deleted_at), so the FK from order_items is never hit and
// historical orders keep pointing at the now-hidden item.
func TestDeleteMenuItem_ReferencedByOrderItemSoftDeletes(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Ordered Item", 500)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, 1, 500)

	callHandler(t, fx, DeleteMenuItem, "DELETE", "/", nil,
		withParam("id", itemID.String())).
		expectStatus(204)
	var deleted bool
	fx.adminScan([]any{&deleted}, `SELECT deleted_at IS NOT NULL FROM menu_items WHERE id = $1`, itemID)
	if !deleted {
		t.Fatal("menu item not soft-deleted")
	}
}

// =========================================================================
// ListServiceTables
// =========================================================================

func TestListServiceTables_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListServiceTables, "GET", "/", nil).
		expectStatus(200).json()
	tables, _ := r["tables"].([]any)
	if len(tables) != 0 {
		t.Fatalf("tables = %d, want 0", len(tables))
	}
}

func TestListServiceTables_WithRows(t *testing.T) {
	fx := newTenant(t)
	fx.seedTable("T1")
	fx.seedTable("T2")
	r := callHandler(t, fx, ListServiceTables, "GET", "/", nil).
		expectStatus(200).json()
	tables, _ := r["tables"].([]any)
	if len(tables) != 2 {
		t.Fatalf("tables = %d, want 2", len(tables))
	}
}

func TestListServiceTables_SoftDeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("ToDelete")
	fx.adminExec(`UPDATE service_tables SET deleted_at = now() WHERE id = $1`, tblID)
	r := callHandler(t, fx, ListServiceTables, "GET", "/", nil).
		expectStatus(200).json()
	tables, _ := r["tables"].([]any)
	if len(tables) != 0 {
		t.Fatalf("tables = %d after soft-delete, want 0", len(tables))
	}
}

func TestListServiceTables_StatusFieldPresent(t *testing.T) {
	fx := newTenant(t)
	fx.seedTable("TableA")
	r := callHandler(t, fx, ListServiceTables, "GET", "/", nil).
		expectStatus(200).json()
	tables, _ := r["tables"].([]any)
	tbl := tables[0].(map[string]any)
	if _, ok := tbl["status"]; !ok {
		t.Fatal("status field missing from table response")
	}
	// Default status should be "free".
	if tbl["status"] != "free" {
		t.Fatalf("default status = %v, want free", tbl["status"])
	}
}

func TestListServiceTables_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedTable("T1")

	r := callHandler(t, fx2, ListServiceTables, "GET", "/", nil).
		expectStatus(200).json()
	tables, _ := r["tables"].([]any)
	if len(tables) != 0 {
		t.Fatalf("tenant isolation violated: fx2 sees %d tables", len(tables))
	}
}

// =========================================================================
// CreateServiceTable
// =========================================================================

func TestCreateServiceTable_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateServiceTable, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateServiceTable_MissingName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"capacity": 4}).
		expectErr(400, "bad_request")
}

func TestCreateServiceTable_BlankName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": ""}).
		expectErr(400, "bad_request")
}

func TestCreateServiceTable_Success(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "Table 1", "capacity": 4, "area": "Window"}).
		expectStatus(201)

	var s ServiceTable
	r.decode(&s)
	if s.Name != "Table 1" {
		t.Fatalf("name = %q, want Table 1", s.Name)
	}
	if s.Capacity != 4 {
		t.Fatalf("capacity = %d, want 4", s.Capacity)
	}
	if s.Area != "Window" {
		t.Fatalf("area = %q, want Window", s.Area)
	}
	if s.Status != "free" {
		t.Fatalf("status = %q, want free (default)", s.Status)
	}
	if s.ID == uuid.Nil {
		t.Fatal("id should be set")
	}
	if n := fx.countRows("service_tables"); n != 1 {
		t.Fatalf("service_tables rows = %d, want 1", n)
	}
}

func TestCreateServiceTable_ZeroCapacityDefaultsToTwo(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "DefaultCap"}).
		expectStatus(201)
	var s ServiceTable
	r.decode(&s)
	// capacity <= 0 is normalized to 2 by the handler.
	if s.Capacity != 2 {
		t.Fatalf("capacity = %d, want 2 (default for zero/missing)", s.Capacity)
	}
}

func TestCreateServiceTable_NegativeCapacityDefaultsToTwo(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "NegCap", "capacity": -5}).
		expectStatus(201)
	var s ServiceTable
	r.decode(&s)
	if s.Capacity != 2 {
		t.Fatalf("capacity = %d, want 2 (negative normalized to 2)", s.Capacity)
	}
}

func TestCreateServiceTable_WithIcon(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "IconTable", "icon": "sofa"}).
		expectStatus(201)
	var s ServiceTable
	r.decode(&s)
	if s.Icon != "sofa" {
		t.Fatalf("icon = %q, want sofa", s.Icon)
	}
}

func TestCreateServiceTable_WithSort(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "SortTable", "sort": 10}).
		expectStatus(201)
	var s ServiceTable
	r.decode(&s)
	if s.Sort != 10 {
		t.Fatalf("sort = %d, want 10", s.Sort)
	}
}

func TestCreateServiceTable_DuplicateName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "Dup"}).
		expectStatus(201)
	// Same name → unique constraint → internal_error.
	callHandler(t, fx, CreateServiceTable, "POST", "/",
		map[string]any{"name": "Dup"}).
		expectStatus(500)
}

// =========================================================================
// UpdateServiceTable
// =========================================================================

func TestUpdateServiceTable_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"name": "x"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateServiceTable_BadJSON(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")
	callHandler(t, fx, UpdateServiceTable, "PATCH", "/", "{bad",
		withParam("id", tblID.String())).
		expectErr(400, "bad_request")
}

func TestUpdateServiceTable_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"name": "x"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateServiceTable_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")
	fx.adminExec(`UPDATE service_tables SET deleted_at = now() WHERE id = $1`, tblID)
	callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"name": "x"},
		withParam("id", tblID.String())).
		expectErr(404, "not_found")
}

func TestUpdateServiceTable_NameUpdate(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("Old")
	r := callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"name": "New"},
		withParam("id", tblID.String())).
		expectStatus(200)
	var s ServiceTable
	r.decode(&s)
	if s.Name != "New" {
		t.Fatalf("name = %q, want New", s.Name)
	}
}

func TestUpdateServiceTable_CapacityUpdate(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")
	newCap := 8
	r := callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"capacity": newCap},
		withParam("id", tblID.String())).
		expectStatus(200)
	var s ServiceTable
	r.decode(&s)
	if s.Capacity != newCap {
		t.Fatalf("capacity = %d, want %d", s.Capacity, newCap)
	}
}

func TestUpdateServiceTable_StatusUpdate(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")

	for _, status := range []string{"occupied", "reserved", "dirty", "free"} {
		r := callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
			map[string]any{"status": status},
			withParam("id", tblID.String())).
			expectStatus(200)
		var s ServiceTable
		r.decode(&s)
		if s.Status != status {
			t.Fatalf("status = %q, want %q", s.Status, status)
		}
	}
}

func TestUpdateServiceTable_AreaUpdate(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")
	r := callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"area": "Terrace"},
		withParam("id", tblID.String())).
		expectStatus(200)
	var s ServiceTable
	r.decode(&s)
	if s.Area != "Terrace" {
		t.Fatalf("area = %q, want Terrace", s.Area)
	}
}

func TestUpdateServiceTable_SortUpdate(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")
	r := callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"sort": 55},
		withParam("id", tblID.String())).
		expectStatus(200)
	var s ServiceTable
	r.decode(&s)
	if s.Sort != 55 {
		t.Fatalf("sort = %d, want 55", s.Sort)
	}
}

func TestUpdateServiceTable_OmittedFieldsPreserved(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("OrigName")
	callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"capacity": 6},
		withParam("id", tblID.String())).
		expectStatus(200)
	// Update only area, name and capacity should be preserved.
	r := callHandler(t, fx, UpdateServiceTable, "PATCH", "/",
		map[string]any{"area": "Patio"},
		withParam("id", tblID.String())).
		expectStatus(200)
	var s ServiceTable
	r.decode(&s)
	if s.Name != "OrigName" {
		t.Fatalf("name = %q, want OrigName", s.Name)
	}
	if s.Capacity != 6 {
		t.Fatalf("capacity = %d, want 6 (preserved)", s.Capacity)
	}
	if s.Area != "Patio" {
		t.Fatalf("area = %q, want Patio", s.Area)
	}
}

// =========================================================================
// DeleteServiceTable
// =========================================================================

func TestDeleteServiceTable_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteServiceTable_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteServiceTable_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("T1")
	fx.adminExec(`UPDATE service_tables SET deleted_at = now() WHERE id = $1`, tblID)
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", tblID.String())).
		expectErr(404, "not_found")
}

func TestDeleteServiceTable_Success(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("Removable")
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", tblID.String())).
		expectStatus(204)

	r := callHandler(t, fx, ListServiceTables, "GET", "/", nil).
		expectStatus(200).json()
	tables, _ := r["tables"].([]any)
	if len(tables) != 0 {
		t.Fatalf("tables = %d after delete, want 0", len(tables))
	}
}

func TestDeleteServiceTable_SecondDeleteFails(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("OneShot")
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", tblID.String())).
		expectStatus(204)
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", tblID.String())).
		expectErr(404, "not_found")
}

// A table referenced by an open order cannot be hard-deleted via FK; the
// handler soft-deletes it, so an order referencing it (with DELETE RESTRICT
// on service_table_id) should be fine for soft-delete. Verify the soft-delete
// succeeds even when an order is open on the table.
func TestDeleteServiceTable_SoftDeleteWithOpenOrder(t *testing.T) {
	fx := newTenant(t)
	tblID := fx.seedTable("Occupied")
	fx.seedOpenOrder(ptrUUID(tblID))

	// Soft-delete should succeed (it only sets deleted_at; no FK violation).
	callHandler(t, fx, DeleteServiceTable, "DELETE", "/", nil,
		withParam("id", tblID.String())).
		expectStatus(204)

	// Verify deleted_at is stamped in the DB.
	var deletedAt *string
	fx.adminScan([]any{&deletedAt},
		`SELECT deleted_at::text FROM service_tables WHERE id = $1`, tblID)
	if deletedAt == nil {
		t.Fatal("deleted_at should be set after delete")
	}
}

// =========================================================================
// ListPopularMenuItems
// =========================================================================

func TestListPopularMenuItems_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	// No items seeded — result should be empty, not error.
	if items == nil {
		t.Fatal("items should be [] not nil")
	}
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0 (empty tenant)", len(items))
	}
}

func TestListPopularMenuItems_FeaturedAppears(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Special", 500)
	fx.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, itemID)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1 (featured item)", len(items))
	}
	item := items[0].(map[string]any)
	if item["is_featured"] != true {
		t.Fatal("is_featured should be true")
	}
}

func TestListPopularMenuItems_InactiveItemExcluded(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Inactive", 500)
	fx.adminExec(`UPDATE menu_items SET is_featured = true, is_active = false WHERE id = $1`, itemID)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0 (inactive item should not appear)", len(items))
	}
}

func TestListPopularMenuItems_DeletedItemExcluded(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Deleted", 500)
	fx.adminExec(`UPDATE menu_items SET is_featured = true, deleted_at = now() WHERE id = $1`, itemID)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0 (deleted item should not appear)", len(items))
	}
}

func TestListPopularMenuItems_Qty30dField(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "Bestseller", 500)
	fx.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, itemID)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	item := items[0].(map[string]any)
	if _, ok := item["qty_30d"]; !ok {
		t.Fatal("qty_30d field missing from popular item response")
	}
}

func TestListPopularMenuItems_LimitQueryParam(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	// Seed 5 featured items.
	for i := 0; i < 5; i++ {
		itemID := fx.seedMenuItem(catID, "Item"+uuid.NewString()[:4], int64(100+i))
		fx.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, itemID)
	}

	// Request with limit=3 should return at most 3.
	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil,
		withQuery("limit=3")).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) > 3 {
		t.Fatalf("items = %d with limit=3, want <= 3", len(items))
	}
}

func TestListPopularMenuItems_LimitOutOfRangeIgnored(t *testing.T) {
	// limit > 50 or <= 0 should fall back to default (8).
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	for i := 0; i < 10; i++ {
		itemID := fx.seedMenuItem(catID, "I"+uuid.NewString()[:4], int64(100+i))
		fx.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, itemID)
	}
	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil,
		withQuery("limit=999")).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) > 8 {
		t.Fatalf("items = %d with limit=999 (>50), want <= 8 (default capped)", len(items))
	}
}

func TestListPopularMenuItems_PaddingActiveItemsForNewTenant(t *testing.T) {
	// A tenant with no featured items and no order history should still get
	// padding results from the newest active items.
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	fx.seedMenuItem(catID, "PadItem1", 100)
	fx.seedMenuItem(catID, "PadItem2", 200)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	// Should be padded with the 2 active items.
	if len(items) != 2 {
		t.Fatalf("items = %d with padding, want 2", len(items))
	}
}

func TestListPopularMenuItems_FeaturedBeforeSalesVelocity(t *testing.T) {
	// Featured item should appear before a non-featured item with order history.
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")

	featuredID := fx.seedMenuItem(catID, "Featured", 500)
	fx.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, featuredID)

	// Seed a non-featured item with closed-order sales.
	soldID := fx.seedMenuItem(catID, "BestSeller", 300)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, soldID, 5, 300)
	// Close the order so it counts towards velocity.
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now() WHERE id = $1`, orderID)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) < 2 {
		t.Fatalf("items = %d, want >= 2", len(items))
	}
	first := items[0].(map[string]any)
	if first["is_featured"] != true {
		t.Fatalf("first item is_featured = %v, want true (featured items rank first)", first["is_featured"])
	}
}

func TestListPopularMenuItems_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	catID := fx1.seedCategory("Cat")
	itemID := fx1.seedMenuItem(catID, "Fx1Item", 500)
	fx1.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, itemID)

	r := callHandler(t, fx2, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("tenant isolation violated: fx2 sees %d popular items", len(items))
	}
}

func TestListPopularMenuItems_PresetNotesNeverNull(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Cat")
	itemID := fx.seedMenuItem(catID, "NoNotes", 500)
	fx.adminExec(`UPDATE menu_items SET is_featured = true WHERE id = $1`, itemID)

	r := callHandler(t, fx, ListPopularMenuItems, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	item := items[0].(map[string]any)
	notes := item["preset_notes"]
	if notes == nil {
		t.Fatal("preset_notes should be [] not null")
	}
}
