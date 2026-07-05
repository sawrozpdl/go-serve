package api

import (
	"testing"

	"github.com/google/uuid"
)

// seedOutlet inserts an outlet row directly and returns its id.
func (fx *fixture) seedOutlet(name string, isDefault bool) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO outlets (tenant_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, name, isDefault)
	return id
}

// =========================================================================
// ListOutlets
// =========================================================================

func TestListOutlets_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListOutlets, "GET", "/", nil).
		expectStatus(200).json()
	outlets, _ := r["outlets"].([]any)
	if len(outlets) != 0 {
		t.Fatalf("outlets = %d, want 0", len(outlets))
	}
}

func TestListOutlets_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedOutlet("Bar", false)
	r := callHandler(t, fx2, ListOutlets, "GET", "/", nil).
		expectStatus(200).json()
	outlets, _ := r["outlets"].([]any)
	if len(outlets) != 0 {
		t.Fatalf("tenant isolation violated: fx2 sees %d outlets", len(outlets))
	}
}

// =========================================================================
// CreateOutlet — also exercises the INSERT grant on outlets (runs as app_user).
// =========================================================================

func TestCreateOutlet_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOutlet, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateOutlet_MissingName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOutlet, "POST", "/", map[string]any{"sort": 1}).
		expectErr(400, "bad_request")
}

func TestCreateOutlet_Success(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateOutlet, "POST", "/",
		map[string]any{"name": "Bar"}).
		expectStatus(201)
	var o Outlet
	r.decode(&o)
	if o.Name != "Bar" {
		t.Fatalf("name = %q, want Bar", o.Name)
	}
	if o.PrinterPort != 9100 {
		t.Fatalf("printer_port = %d, want 9100 (default)", o.PrinterPort)
	}
	if o.PrinterWidth != "80" {
		t.Fatalf("printer_width = %q, want 80 (default)", o.PrinterWidth)
	}
	if !o.IsActive {
		t.Fatal("new outlet should be active")
	}
	if o.IsDefault {
		t.Fatal("new outlet should not be default")
	}
	if o.ID == uuid.Nil {
		t.Fatal("id should be set")
	}
	if n := fx.countRows("outlets"); n != 1 {
		t.Fatalf("outlets rows = %d, want 1", n)
	}
}

func TestCreateOutlet_WithPrinter(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateOutlet, "POST", "/",
		map[string]any{"name": "Bar", "printer_ip": "192.168.1.9", "printer_port": 9101, "printer_width": "58"}).
		expectStatus(201)
	var o Outlet
	r.decode(&o)
	if o.PrinterIP == nil || *o.PrinterIP != "192.168.1.9" {
		t.Fatalf("printer_ip = %v, want 192.168.1.9", o.PrinterIP)
	}
	if o.PrinterPort != 9101 {
		t.Fatalf("printer_port = %d, want 9101", o.PrinterPort)
	}
	if o.PrinterWidth != "58" {
		t.Fatalf("printer_width = %q, want 58", o.PrinterWidth)
	}
}

func TestCreateOutlet_InvalidWidth(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOutlet, "POST", "/",
		map[string]any{"name": "Bar", "printer_width": "72"}).
		expectErr(400, "bad_request")
}

func TestCreateOutlet_DuplicateName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOutlet, "POST", "/", map[string]any{"name": "Bar"}).
		expectStatus(201)
	callHandler(t, fx, CreateOutlet, "POST", "/", map[string]any{"name": "Bar"}).
		expectErr(409, "name_taken")
}

func TestCreateOutlet_DuplicateNameCaseInsensitive(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOutlet, "POST", "/", map[string]any{"name": "Bar"}).
		expectStatus(201)
	// The unique index is on lower(name), so "bar" collides with "Bar".
	callHandler(t, fx, CreateOutlet, "POST", "/", map[string]any{"name": "bar"}).
		expectErr(409, "name_taken")
}

func TestCreateOutlet_NameReusableAfterSoftDelete(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Bar", false)
	fx.adminExec(`UPDATE outlets SET deleted_at = now() WHERE id = $1`, id)
	// Partial unique index (WHERE deleted_at IS NULL) frees the name once soft-deleted.
	callHandler(t, fx, CreateOutlet, "POST", "/", map[string]any{"name": "Bar"}).
		expectStatus(201)
}

func TestCreateOutlet_BadPort(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOutlet, "POST", "/",
		map[string]any{"name": "Bar", "printer_ip": "1.2.3.4", "printer_port": 0}).
		expectErr(400, "bad_request")
	callHandler(t, fx, CreateOutlet, "POST", "/",
		map[string]any{"name": "Bar2", "printer_ip": "1.2.3.4", "printer_port": 70000}).
		expectErr(400, "bad_request")
}

func TestCreateOutlet_BlankPrinterIPStoredAsNull(t *testing.T) {
	fx := newTenant(t)
	// A whitespace-only IP normalises to no-printer (NULL), not "  ".
	r := callHandler(t, fx, CreateOutlet, "POST", "/",
		map[string]any{"name": "Bar", "printer_ip": "   "}).
		expectStatus(201)
	var o Outlet
	r.decode(&o)
	if o.PrinterIP != nil {
		t.Fatalf("printer_ip = %q, want nil (blank normalised)", *o.PrinterIP)
	}
}

// =========================================================================
// UpdateOutlet
// =========================================================================

func TestUpdateOutlet_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateOutlet, "PATCH", "/", map[string]any{"name": "x"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateOutlet_NameAndPrinter(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Bar", false)
	r := callHandler(t, fx, UpdateOutlet, "PATCH", "/",
		map[string]any{"name": "Cocktail Bar", "printer_ip": "10.0.0.5"},
		withParam("id", id.String())).
		expectStatus(200)
	var o Outlet
	r.decode(&o)
	if o.Name != "Cocktail Bar" {
		t.Fatalf("name = %q, want Cocktail Bar", o.Name)
	}
	if o.PrinterIP == nil || *o.PrinterIP != "10.0.0.5" {
		t.Fatalf("printer_ip = %v, want 10.0.0.5", o.PrinterIP)
	}
}

func TestUpdateOutlet_ClearPrinter(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Bar", false)
	fx.adminExec(`UPDATE outlets SET printer_ip = '1.2.3.4' WHERE id = $1`, id)
	r := callHandler(t, fx, UpdateOutlet, "PATCH", "/",
		map[string]any{"printer_ip": ""},
		withParam("id", id.String())).
		expectStatus(200)
	var o Outlet
	r.decode(&o)
	if o.PrinterIP != nil {
		t.Fatalf("printer_ip = %v, want nil after clear", *o.PrinterIP)
	}
}

func TestUpdateOutlet_BadWidth(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Bar", false)
	callHandler(t, fx, UpdateOutlet, "PATCH", "/",
		map[string]any{"printer_width": "72"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateOutlet_RenameCollision(t *testing.T) {
	fx := newTenant(t)
	fx.seedOutlet("Kitchen", true)
	bar := fx.seedOutlet("Bar", false)
	// Renaming Bar → Kitchen collides with the existing default.
	callHandler(t, fx, UpdateOutlet, "PATCH", "/",
		map[string]any{"name": "Kitchen"},
		withParam("id", bar.String())).
		expectErr(409, "name_taken")
}

func TestUpdateOutlet_DemoteDefaultIsNoop(t *testing.T) {
	fx := newTenant(t)
	kitchen := fx.seedOutlet("Kitchen", true)
	// Sending is_default:false must NOT leave the tenant with zero defaults.
	callHandler(t, fx, UpdateOutlet, "PATCH", "/",
		map[string]any{"is_default": false},
		withParam("id", kitchen.String())).
		expectStatus(200)
	var stillDefault bool
	fx.adminScan([]any{&stillDefault}, `SELECT is_default FROM outlets WHERE id = $1`, kitchen)
	if !stillDefault {
		t.Fatal("demoting the sole default should be a no-op (kept default)")
	}
}

func TestUpdateOutlet_PromoteDefaultClearsOld(t *testing.T) {
	fx := newTenant(t)
	kitchen := fx.seedOutlet("Kitchen", true)
	bar := fx.seedOutlet("Bar", false)

	callHandler(t, fx, UpdateOutlet, "PATCH", "/",
		map[string]any{"is_default": true},
		withParam("id", bar.String())).
		expectStatus(200)

	var kitchenDefault, barDefault bool
	fx.adminScan([]any{&kitchenDefault}, `SELECT is_default FROM outlets WHERE id = $1`, kitchen)
	fx.adminScan([]any{&barDefault}, `SELECT is_default FROM outlets WHERE id = $1`, bar)
	if kitchenDefault {
		t.Fatal("old default (Kitchen) should have been cleared")
	}
	if !barDefault {
		t.Fatal("Bar should now be the default")
	}
	var defaults int
	fx.adminScan([]any{&defaults}, `SELECT count(*) FROM outlets WHERE tenant_id = $1 AND is_default AND deleted_at IS NULL`, fx.Tenant)
	if defaults != 1 {
		t.Fatalf("default outlet count = %d, want exactly 1", defaults)
	}
}

// =========================================================================
// DeleteOutlet
// =========================================================================

func TestDeleteOutlet_Default_Blocked(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Kitchen", true)
	callHandler(t, fx, DeleteOutlet, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(409, "outlet_is_default")
}

func TestDeleteOutlet_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteOutlet, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteOutlet_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Bar", false)
	fx.adminExec(`UPDATE outlets SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, DeleteOutlet, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestDeleteOutlet_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedOutlet("Bar", false)
	callHandler(t, fx, DeleteOutlet, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	// Soft delete leaves the row, so assert via deleted_at.
	var deletedAt *string
	fx.adminScan([]any{&deletedAt}, `SELECT deleted_at::text FROM outlets WHERE id = $1`, id)
	if deletedAt == nil {
		t.Fatal("deleted_at should be set after delete")
	}
}

func TestDeleteOutlet_FallsCategoryAndItemToNull(t *testing.T) {
	fx := newTenant(t)
	outletID := fx.seedOutlet("Bar", false)
	catID := fx.seedCategory("Cocktails")
	itemID := fx.seedMenuItem(catID, "Mojito", 700)
	fx.adminExec(`UPDATE menu_categories SET outlet_id = $2 WHERE id = $1`, catID, outletID)
	fx.adminExec(`UPDATE menu_items SET outlet_id = $2 WHERE id = $1`, itemID, outletID)

	callHandler(t, fx, DeleteOutlet, "DELETE", "/", nil,
		withParam("id", outletID.String())).
		expectStatus(204)

	var catOutlet, itemOutlet *uuid.UUID
	fx.adminScan([]any{&catOutlet}, `SELECT outlet_id FROM menu_categories WHERE id = $1`, catID)
	fx.adminScan([]any{&itemOutlet}, `SELECT outlet_id FROM menu_items WHERE id = $1`, itemID)
	if catOutlet != nil {
		t.Fatalf("category outlet_id = %v, want nil after outlet delete", *catOutlet)
	}
	if itemOutlet != nil {
		t.Fatalf("item outlet_id = %v, want nil after outlet delete", *itemOutlet)
	}
}

// =========================================================================
// Category/item outlet_id assignment + cross-tenant guard
// =========================================================================

func TestCreateMenuCategory_WithOutlet(t *testing.T) {
	fx := newTenant(t)
	outletID := fx.seedOutlet("Bar", false)
	r := callHandler(t, fx, CreateMenuCategory, "POST", "/",
		map[string]any{"name": "Cocktails", "outlet_id": outletID.String()}).
		expectStatus(201)
	var c MenuCategory
	r.decode(&c)
	if c.OutletID == nil || *c.OutletID != outletID {
		t.Fatalf("category outlet_id = %v, want %v", c.OutletID, outletID)
	}
}

func TestCreateMenuCategory_CrossTenantOutletRejected(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	foreign := fx2.seedOutlet("Bar", false)
	// fx1 tries to route a category to fx2's outlet — RLS hides it, so 400.
	callHandler(t, fx1, CreateMenuCategory, "POST", "/",
		map[string]any{"name": "Cocktails", "outlet_id": foreign.String()}).
		expectErr(400, "bad_request")
}

func TestCreateMenuItem_WithOutletOverride(t *testing.T) {
	fx := newTenant(t)
	outletID := fx.seedOutlet("Bar", false)
	catID := fx.seedCategory("Drinks")
	r := callHandler(t, fx, CreateMenuItem, "POST", "/",
		map[string]any{"name": "Beer", "category_id": catID.String(), "price_cents": 400, "outlet_id": outletID.String()}).
		expectStatus(201)
	var m MenuItem
	r.decode(&m)
	if m.OutletID == nil || *m.OutletID != outletID {
		t.Fatalf("item outlet_id = %v, want %v", m.OutletID, outletID)
	}
}

func TestCreateMenuItem_CrossTenantOutletRejected(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	foreign := fx2.seedOutlet("Bar", false)
	catID := fx1.seedCategory("Drinks")
	callHandler(t, fx1, CreateMenuItem, "POST", "/",
		map[string]any{"name": "Beer", "category_id": catID.String(), "price_cents": 400, "outlet_id": foreign.String()}).
		expectErr(400, "bad_request")
}

func TestUpdateMenuItem_ClearAndPreserveOutlet(t *testing.T) {
	fx := newTenant(t)
	outletID := fx.seedOutlet("Bar", false)
	catID := fx.seedCategory("Drinks")
	itemID := fx.seedMenuItem(catID, "Beer", 400)
	fx.adminExec(`UPDATE menu_items SET outlet_id = $2 WHERE id = $1`, itemID, outletID)

	// Omitting outlet_id preserves it.
	r := callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"price_cents": 450},
		withParam("id", itemID.String())).
		expectStatus(200)
	var m MenuItem
	r.decode(&m)
	if m.OutletID == nil || *m.OutletID != outletID {
		t.Fatalf("outlet_id = %v, want preserved %v", m.OutletID, outletID)
	}

	// Explicit null clears it. Assert against the DB rather than the response —
	// MenuItem.outlet_id is `omitempty`, so a cleared value is absent from JSON.
	callHandler(t, fx, UpdateMenuItem, "PATCH", "/",
		map[string]any{"outlet_id": nil},
		withParam("id", itemID.String())).
		expectStatus(200)
	var cleared *uuid.UUID
	fx.adminScan([]any{&cleared}, `SELECT outlet_id FROM menu_items WHERE id = $1`, itemID)
	if cleared != nil {
		t.Fatalf("outlet_id = %v, want nil after clear", *cleared)
	}
}

func TestUpdateMenuCategory_ClearOutlet(t *testing.T) {
	fx := newTenant(t)
	outletID := fx.seedOutlet("Bar", false)
	catID := fx.seedCategory("Cocktails")
	fx.adminExec(`UPDATE menu_categories SET outlet_id = $2 WHERE id = $1`, catID, outletID)
	// Sending outlet_id: null clears it; omitting would keep it.
	r := callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"outlet_id": nil},
		withParam("id", catID.String())).
		expectStatus(200)
	var c MenuCategory
	r.decode(&c)
	if c.OutletID != nil {
		t.Fatalf("outlet_id = %v, want nil after clear", *c.OutletID)
	}
}

func TestUpdateMenuCategory_OmittedOutletPreserved(t *testing.T) {
	fx := newTenant(t)
	outletID := fx.seedOutlet("Bar", false)
	catID := fx.seedCategory("Cocktails")
	fx.adminExec(`UPDATE menu_categories SET outlet_id = $2 WHERE id = $1`, catID, outletID)
	// A partial patch that omits outlet_id must not wipe it.
	r := callHandler(t, fx, UpdateMenuCategory, "PATCH", "/",
		map[string]any{"sort": 5},
		withParam("id", catID.String())).
		expectStatus(200)
	var c MenuCategory
	r.decode(&c)
	if c.OutletID == nil || *c.OutletID != outletID {
		t.Fatalf("outlet_id = %v, want preserved %v", c.OutletID, outletID)
	}
}

// =========================================================================
// Send-to-kitchen stamps the resolved outlet onto order_items
// =========================================================================

func TestSendOrderToKitchen_StampsOutlet(t *testing.T) {
	fx := newTenant(t)
	kitchen := fx.seedOutlet("Kitchen", true)
	bar := fx.seedOutlet("Bar", false)

	// Category routed to Bar; a second category with no outlet (→ default Kitchen).
	barCat := fx.seedCategory("Cocktails")
	fx.adminExec(`UPDATE menu_categories SET outlet_id = $2 WHERE id = $1`, barCat, bar)
	kitchenCat := fx.seedCategory("Food")

	barItem := fx.seedMenuItem(barCat, "Mojito", 700)
	foodItem := fx.seedMenuItem(kitchenCat, "Momo", 300)

	orderID := fx.seedOpenOrder(nil)
	barLine := fx.seedOrderItem(orderID, barItem, 1, 700)
	foodLine := fx.seedOrderItem(orderID, foodItem, 1, 300)

	callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", orderID.String())).
		expectStatus(200)

	var barOutlet, foodOutlet *uuid.UUID
	fx.adminScan([]any{&barOutlet}, `SELECT outlet_id FROM order_items WHERE id = $1`, barLine)
	fx.adminScan([]any{&foodOutlet}, `SELECT outlet_id FROM order_items WHERE id = $1`, foodLine)
	if barOutlet == nil || *barOutlet != bar {
		t.Fatalf("bar line outlet = %v, want %v (category override)", barOutlet, bar)
	}
	if foodOutlet == nil || *foodOutlet != kitchen {
		t.Fatalf("food line outlet = %v, want %v (tenant default fallback)", foodOutlet, kitchen)
	}
}

func TestSendOrderToKitchen_ItemOverrideBeatsCategory(t *testing.T) {
	fx := newTenant(t)
	fx.seedOutlet("Kitchen", true)
	bar := fx.seedOutlet("Bar", false)

	// Category has NO outlet (→ default), but the item overrides to Bar.
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Special", 500)
	fx.adminExec(`UPDATE menu_items SET outlet_id = $2 WHERE id = $1`, item, bar)

	orderID := fx.seedOpenOrder(nil)
	line := fx.seedOrderItem(orderID, item, 1, 500)
	callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", orderID.String())).
		expectStatus(200)

	var outlet *uuid.UUID
	fx.adminScan([]any{&outlet}, `SELECT outlet_id FROM order_items WHERE id = $1`, line)
	if outlet == nil || *outlet != bar {
		t.Fatalf("outlet = %v, want %v (item override wins)", outlet, bar)
	}
}

func TestSendOrderToKitchen_NoOutletsLeavesNull(t *testing.T) {
	fx := newTenant(t)
	// Tenant has no outlets at all — the fallback subquery returns nothing, so
	// the item still sends but with a NULL outlet (folds onto the default board).
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Momo", 300)
	orderID := fx.seedOpenOrder(nil)
	line := fx.seedOrderItem(orderID, item, 1, 300)

	callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", orderID.String())).
		expectStatus(200)

	var outlet *uuid.UUID
	var status string
	fx.adminScan([]any{&outlet, &status},
		`SELECT outlet_id, kitchen_status::text FROM order_items WHERE id = $1`, line)
	if outlet != nil {
		t.Fatalf("outlet = %v, want nil (no outlets configured)", *outlet)
	}
	if status != "in_progress" {
		t.Fatalf("kitchen_status = %q, want in_progress", status)
	}
}

// =========================================================================
// KDS ?outlet= filter
// =========================================================================

func TestListKitchenTickets_InvalidOutletFilter(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListKitchenTickets, "GET", "/", nil,
		withQuery("outlet=not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestListKitchenTickets_NonDefaultOutletExcludesUnstamped(t *testing.T) {
	fx := newTenant(t)
	fx.seedOutlet("Kitchen", true)
	bar := fx.seedOutlet("Bar", false)

	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Thing", 100)
	orderID := fx.seedOpenOrder(nil)
	legacy := fx.seedOrderItem(orderID, item, 1, 100)
	// Unstamped legacy ticket (no outlet).
	fx.adminExec(`UPDATE order_items SET kitchen_status = 'in_progress' WHERE id = $1`, legacy)

	// Filtering to a NON-default outlet must NOT surface the unstamped ticket.
	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil,
		withQuery("outlet="+bar.String())).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("bar tickets = %d, want 0 (unstamped only folds into the default)", len(tickets))
	}
}

func TestListKitchenTickets_OutletNameIncluded(t *testing.T) {
	fx := newTenant(t)
	bar := fx.seedOutlet("Bar", false)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Thing", 100)
	orderID := fx.seedOpenOrder(nil)
	line := fx.seedOrderItem(orderID, item, 1, 100)
	fx.adminExec(`UPDATE order_items SET kitchen_status = 'in_progress', outlet_id = $2 WHERE id = $1`, line, bar)

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 1 {
		t.Fatalf("tickets = %d, want 1", len(tickets))
	}
	tk := tickets[0].(map[string]any)
	if tk["outlet_name"] != "Bar" {
		t.Fatalf("outlet_name = %v, want Bar", tk["outlet_name"])
	}
}

func TestListKitchenTickets_OutletFilter(t *testing.T) {
	fx := newTenant(t)
	kitchen := fx.seedOutlet("Kitchen", true)
	bar := fx.seedOutlet("Bar", false)

	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Thing", 100)
	orderID := fx.seedOpenOrder(nil)
	kLine := fx.seedOrderItem(orderID, item, 1, 100)
	bLine := fx.seedOrderItem(orderID, item, 1, 100)
	// Put both in the kitchen board, one per outlet.
	fx.adminExec(`UPDATE order_items SET kitchen_status = 'in_progress', outlet_id = $2 WHERE id = $1`, kLine, kitchen)
	fx.adminExec(`UPDATE order_items SET kitchen_status = 'in_progress', outlet_id = $2 WHERE id = $1`, bLine, bar)

	// No filter → both.
	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	all, _ := r["tickets"].([]any)
	if len(all) != 2 {
		t.Fatalf("unfiltered tickets = %d, want 2", len(all))
	}

	// Filter to Bar → only the bar line.
	r = callHandler(t, fx, ListKitchenTickets, "GET", "/", nil,
		withQuery("outlet="+bar.String())).
		expectStatus(200).json()
	barOnly, _ := r["tickets"].([]any)
	if len(barOnly) != 1 {
		t.Fatalf("bar tickets = %d, want 1", len(barOnly))
	}
}

func TestListKitchenTickets_DefaultOutletIncludesUnstamped(t *testing.T) {
	fx := newTenant(t)
	kitchen := fx.seedOutlet("Kitchen", true)

	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Thing", 100)
	orderID := fx.seedOpenOrder(nil)
	legacy := fx.seedOrderItem(orderID, item, 1, 100)
	// Legacy ticket: in the board but with no stamped outlet (predates outlets).
	fx.adminExec(`UPDATE order_items SET kitchen_status = 'in_progress' WHERE id = $1`, legacy)

	// Filtering to the default outlet should still surface the unstamped ticket.
	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil,
		withQuery("outlet="+kitchen.String())).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 1 {
		t.Fatalf("default-outlet tickets = %d, want 1 (unstamped folds in)", len(tickets))
	}
}
