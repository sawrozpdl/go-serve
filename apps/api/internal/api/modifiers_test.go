package api

// Integration tests for add-ons / modifier groups (migration 0062).
//
// The load-bearing property is the FOLD: a line's unit_price_cents must equal
// its own price plus its add-ons, because ~30 downstream money queries read
// unit_price_cents and know nothing about add-ons. Every test that adds a line
// therefore checks the fold, and the fold invariant itself
// (platform_accuracy_check_addons) is asserted directly at the end.

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// seed helpers
// =========================================================================

func (fx *fixture) seedModifierGroup(name string, minSelect int, maxSelect *int) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO menu_modifier_groups (tenant_id, name, min_select, max_select)
		VALUES ($1, $2, $3, $4) RETURNING id
	`, fx.Tenant, name, minSelect, maxSelect)
	return id
}

func (fx *fixture) seedModifier(groupID uuid.UUID, name string, priceCents int64, costCents *int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO menu_modifiers (tenant_id, group_id, name, price_cents, cost_cents)
		VALUES ($1, $2, $3, $4, $5) RETURNING id
	`, fx.Tenant, groupID, name, priceCents, costCents)
	return id
}

func (fx *fixture) attachGroupToItem(itemID, groupID uuid.UUID) {
	fx.t.Helper()
	fx.adminExec(`
		INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id)
		VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
	`, fx.Tenant, itemID, groupID)
}

func (fx *fixture) attachGroupToCategory(catID, groupID uuid.UUID) {
	fx.t.Helper()
	fx.adminExec(`
		INSERT INTO menu_category_modifier_groups (tenant_id, category_id, group_id)
		VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
	`, fx.Tenant, catID, groupID)
}

// addLineWithAddOns posts one line with the given add-ons and returns the decoded
// response, so a test can assert on the folded price the API reports back.
func addLineWithAddOns(fx *fixture, orderID, menuItemID uuid.UUID, qty float64, addOns []map[string]any) *apiResp {
	fx.t.Helper()
	item := map[string]any{
		"id":           uuid.NewString(),
		"menu_item_id": menuItemID.String(),
		"qty":          qty,
	}
	if addOns != nil {
		item["add_ons"] = addOns
	}
	return callHandler(fx.t, fx, AddOrderItems(testHub()), http.MethodPost, "/",
		map[string]any{"items": []map[string]any{item}},
		withParam("id", orderID.String()))
}

// lineFold reads the persisted fold columns for a line.
func lineFold(fx *fixture, lineID uuid.UUID) (unitPrice, basePrice, unitCost, baseCost int64) {
	fx.t.Helper()
	fx.adminScan([]any{&unitPrice, &basePrice, &unitCost, &baseCost}, `
		SELECT unit_price_cents, base_price_cents, unit_cost_cents, base_cost_cents
		FROM order_items WHERE id = $1
	`, lineID)
	return
}

// addonViolations runs the fold invariant over this tenant. Any test that writes
// a line with add-ons should end with this at zero.
func addonViolations(fx *fixture) int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*)::int FROM platform_accuracy_check_addons($1)`, fx.Tenant)
	return n
}

// =========================================================================
// The fold
// =========================================================================

// The headline: an add-on's price rides inside the line's unit price, so every
// downstream money query is right without knowing add-ons exist — and the base
// price is preserved so the two can still be told apart.
func TestAddOns_FoldIntoUnitPrice(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	sandwich := fx.seedMenuItem(cat, "Chicken Sandwich", 20000)
	fx.adminExec(`UPDATE menu_items SET cost_cents = 6000 WHERE id = $1`, sandwich)
	grp := fx.seedModifierGroup("Sandwich extras", 0, nil)
	cheeseCost := int64(1200)
	cheese := fx.seedModifier(grp, "Extra cheese", 5000, &cheeseCost)
	fx.attachGroupToItem(sandwich, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, sandwich, 1,
		[]map[string]any{{"modifier_id": cheese.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)

	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	if len(resp.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(resp.Items))
	}
	it := resp.Items[0]

	// 20000 + 5000 folded into ONE line, not two lines.
	if it.UnitPriceCents != 25000 {
		t.Errorf("unit_price_cents = %d, want 25000 (200 sandwich + 50 cheese)", it.UnitPriceCents)
	}
	if it.BasePriceCents != 20000 {
		t.Errorf("base_price_cents = %d, want 20000 (the sandwich alone)", it.BasePriceCents)
	}
	if it.LineCents != 25000 {
		t.Errorf("line_cents = %d, want 25000", it.LineCents)
	}
	if len(it.AddOns) != 1 || it.AddOns[0].Name != "Extra cheese" {
		t.Fatalf("add_ons = %+v, want one Extra cheese", it.AddOns)
	}
	if it.AddOns[0].PriceCents != 5000 {
		t.Errorf("add-on price snapshot = %d, want 5000", it.AddOns[0].PriceCents)
	}
	if it.AddOns[0].GroupName != "Sandwich extras" {
		t.Errorf("add-on group_name = %q, want %q", it.AddOns[0].GroupName, "Sandwich extras")
	}

	// Cost folds the same way, or margin on this line would be overstated.
	_, _, unitCost, baseCost := lineFold(fx, it.ID)
	if unitCost != 7200 {
		t.Errorf("unit_cost_cents = %d, want 7200 (6000 + 1200)", unitCost)
	}
	if baseCost != 6000 {
		t.Errorf("base_cost_cents = %d, want 6000", baseCost)
	}

	// Exactly ONE order_items row — the whole point. An add-on that became its
	// own line is the bug this feature replaces.
	var lines int
	fx.adminScan([]any{&lines},
		`SELECT count(*)::int FROM order_items WHERE order_id = $1`, orderID)
	if lines != 1 {
		t.Errorf("order_items rows = %d, want 1 — the add-on must not be its own line", lines)
	}

	if v := addonViolations(fx); v != 0 {
		t.Errorf("fold invariant violations = %d, want 0", v)
	}
}

// The parent's qty multiplies through the folded price, and an add-on's own qty
// is per-unit-of-parent: 2 sandwiches × double cheese = 2 × (200 + 2×50).
func TestAddOns_QtyMultipliesThroughFold(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	sandwich := fx.seedMenuItem(cat, "Sandwich", 20000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	cheese := fx.seedModifier(grp, "Extra cheese", 5000, nil)
	fx.attachGroupToItem(sandwich, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, sandwich, 2,
		[]map[string]any{{"modifier_id": cheese.String(), "qty": 2}}).
		expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	it := resp.Items[0]

	if it.UnitPriceCents != 30000 {
		t.Errorf("unit_price_cents = %d, want 30000 (200 + 2×50 per sandwich)", it.UnitPriceCents)
	}
	if it.LineCents != 60000 {
		t.Errorf("line_cents = %d, want 60000 (2 × 300)", it.LineCents)
	}
	if v := addonViolations(fx); v != 0 {
		t.Errorf("fold invariant violations = %d, want 0", v)
	}
}

// Repeated picks of the same add-on collapse into one row with summed qty,
// so tapping "+" twice reads as "×2" rather than two identical rows.
func TestAddOns_DuplicatePicksCollapse(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, item, 1, []map[string]any{
		{"modifier_id": bacon.String(), "qty": 1},
		{"modifier_id": bacon.String(), "qty": 1},
	}).expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	it := resp.Items[0]

	if len(it.AddOns) != 1 {
		t.Fatalf("add_ons = %d rows, want 1 collapsed row", len(it.AddOns))
	}
	if it.AddOns[0].Qty != 2 {
		t.Errorf("collapsed qty = %v, want 2", it.AddOns[0].Qty)
	}
	if it.UnitPriceCents != 38000 {
		t.Errorf("unit_price_cents = %d, want 38000 (300 + 2×40)", it.UnitPriceCents)
	}
}

// A free add-on ("No onion") is legal — menu items reject price <= 0, modifiers
// must not, or half the real use cases are unrepresentable.
func TestAddOns_ZeroPriceAllowed(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Preferences", 0, nil)
	fx.attachGroupToItem(item, grp)

	r := callHandler(t, fx, CreateModifier, http.MethodPost, "/",
		map[string]any{"name": "No onion", "price_cents": 0},
		withParam("id", grp.String())).
		expectStatus(http.StatusCreated)
	var m Modifier
	r.decode(&m)
	if m.PriceCents != 0 {
		t.Fatalf("price_cents = %d, want 0", m.PriceCents)
	}

	orderID := fx.seedOpenOrder(nil)
	res := addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": m.ID.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	res.decode(&resp)
	if resp.Items[0].UnitPriceCents != 30000 {
		t.Errorf("unit_price_cents = %d, want 30000 — a free add-on must not change the price",
			resp.Items[0].UnitPriceCents)
	}
	if len(resp.Items[0].AddOns) != 1 {
		t.Error("a free add-on must still be recorded so the kitchen sees it")
	}
}

// =========================================================================
// Validation
// =========================================================================

// An add-on from a group that isn't attached to this item is refused. Without
// this, a client could bolt any priced modifier onto any item.
func TestAddOns_RejectsUnattachedGroup(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	sandwich := fx.seedMenuItem(cat, "Sandwich", 20000)
	coffeeCat := fx.seedCategory("Drinks")
	_ = fx.seedMenuItem(coffeeCat, "Latte", 15000)

	// A group that exists but is attached to nothing the sandwich can see.
	grp := fx.seedModifierGroup("Coffee extras", 0, nil)
	shot := fx.seedModifier(grp, "Extra shot", 6000, nil)

	orderID := fx.seedOpenOrder(nil)
	addLineWithAddOns(fx, orderID, sandwich, 1,
		[]map[string]any{{"modifier_id": shot.String(), "qty": 1}}).
		expectErr(http.StatusBadRequest, "modifier_not_allowed")

	// And nothing was written — the refusal must not leave a partial line.
	var lines int
	fx.adminScan([]any{&lines},
		`SELECT count(*)::int FROM order_items WHERE order_id = $1`, orderID)
	if lines != 0 {
		t.Errorf("order_items rows = %d, want 0 after a rejected add-on", lines)
	}
}

// A group attached to the CATEGORY applies to every item in it, and composes
// with the item's own groups rather than being overridden by them.
func TestAddOns_CategoryAttachmentComposesWithItem(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Drinks")
	latte := fx.seedMenuItem(cat, "Latte", 15000)

	catGrp := fx.seedModifierGroup("Drink extras", 0, nil)
	shot := fx.seedModifier(catGrp, "Extra shot", 6000, nil)
	fx.attachGroupToCategory(cat, catGrp)

	itemGrp := fx.seedModifierGroup("Latte syrups", 0, nil)
	vanilla := fx.seedModifier(itemGrp, "Vanilla", 3000, nil)
	fx.attachGroupToItem(latte, itemGrp)

	orderID := fx.seedOpenOrder(nil)
	// Both must be accepted on the same line — that is what "composes" means.
	r := addLineWithAddOns(fx, orderID, latte, 1, []map[string]any{
		{"modifier_id": shot.String(), "qty": 1},
		{"modifier_id": vanilla.String(), "qty": 1},
	}).expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	if got := resp.Items[0].UnitPriceCents; got != 24000 {
		t.Errorf("unit_price_cents = %d, want 24000 (150 + 60 + 30)", got)
	}
	if len(resp.Items[0].AddOns) != 2 {
		t.Errorf("add_ons = %d, want 2 (one from the category group, one from the item's)",
			len(resp.Items[0].AddOns))
	}
}

// max_select caps how many choices a group accepts.
func TestAddOns_EnforcesMaxSelect(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Pizza", 50000)
	one := 1
	grp := fx.seedModifierGroup("Choose a size", 0, &one)
	small := fx.seedModifier(grp, "Small", 0, nil)
	large := fx.seedModifier(grp, "Large", 10000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	addLineWithAddOns(fx, orderID, item, 1, []map[string]any{
		{"modifier_id": small.String(), "qty": 1},
		{"modifier_id": large.String(), "qty": 1},
	}).expectErr(http.StatusBadRequest, "modifier_selection_invalid")

	// One choice is fine.
	addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": large.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
}

// min_select makes a group required: the line cannot be added without a choice.
func TestAddOns_EnforcesMinSelect(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Pizza", 50000)
	one := 1
	grp := fx.seedModifierGroup("Pick a base", 1, &one)
	thin := fx.seedModifier(grp, "Thin", 0, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	// No add-ons at all → refused, because the group is required.
	addLineWithAddOns(fx, orderID, item, 1, []map[string]any{}).
		expectErr(http.StatusBadRequest, "modifier_selection_invalid")
	// Omitting the key entirely must be refused for the same reason — otherwise
	// a client could skip a required choice just by leaving the field out.
	addLineWithAddOns(fx, orderID, item, 1, nil).
		expectErr(http.StatusBadRequest, "modifier_selection_invalid")

	addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": thin.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
}

// An inactive or soft-deleted add-on can't be sold, even if a stale client still
// has its id.
func TestAddOns_RejectsInactiveModifier(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)
	fx.adminExec(`UPDATE menu_modifiers SET is_active = false WHERE id = $1`, bacon)

	orderID := fx.seedOpenOrder(nil)
	addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": bacon.String(), "qty": 1}}).
		expectErr(http.StatusBadRequest, "modifier_not_found")
}

// Fractional add-on quantities are refused: "half an extra cheese" is not a
// thing, and the half-plate allowance belongs to the parent item.
func TestAddOns_RejectsFractionalQty(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": bacon.String(), "qty": 0.5}}).
		expectErr(http.StatusBadRequest, "invalid_qty")
}

// The server prices add-ons from the catalog and ignores anything the client
// claims, so a tampered payload can't discount a bill.
func TestAddOns_IgnoresClientSuppliedPrice(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, item, 1, []map[string]any{
		{"modifier_id": bacon.String(), "qty": 1, "price_cents": 1, "name": "Free bacon"},
	}).expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)

	if got := resp.Items[0].UnitPriceCents; got != 34000 {
		t.Errorf("unit_price_cents = %d, want 34000 — the client's price was trusted", got)
	}
	if got := resp.Items[0].AddOns[0].Name; got != "Bacon" {
		t.Errorf("add-on name = %q, want %q — the client's name was trusted", got, "Bacon")
	}
}

// =========================================================================
// Snapshot semantics
// =========================================================================

// Repricing a modifier must not rewrite an already-sold line.
func TestAddOns_RepricingDoesNotRewriteHistory(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": bacon.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	lineID := resp.Items[0].ID

	// Double the price, and rename it.
	callHandler(t, fx, UpdateModifier, http.MethodPatch, "/",
		map[string]any{"price_cents": 8000, "name": "Streaky bacon"},
		withParams(map[string]string{"id": grp.String(), "modifierId": bacon.String()})).
		expectStatus(http.StatusOK)

	unit, base, _, _ := lineFold(fx, lineID)
	if unit != 34000 || base != 30000 {
		t.Errorf("after reprice: unit=%d base=%d, want 34000/30000 — history was rewritten", unit, base)
	}
	var name string
	var price int64
	fx.adminScan([]any{&name, &price},
		`SELECT name, price_cents FROM order_item_modifiers WHERE order_item_id = $1`, lineID)
	if name != "Bacon" || price != 4000 {
		t.Errorf("snapshot = %q/%d, want Bacon/4000 — the sold row followed the catalog", name, price)
	}
	if v := addonViolations(fx); v != 0 {
		t.Errorf("fold invariant violations = %d, want 0", v)
	}
}

// =========================================================================
// Editing a line's add-ons
// =========================================================================

// Changing a pending line's add-ons re-folds its price. Without the re-fold the
// line would keep charging for the old add-ons.
func TestAddOns_UpdateLineRefoldsPrice(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	cheese := fx.seedModifier(grp, "Cheese", 5000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": bacon.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	lineID := resp.Items[0].ID

	// Swap bacon for cheese.
	callHandler(t, fx, UpdateOrderItem, http.MethodPatch, "/",
		map[string]any{"add_ons": []map[string]any{{"modifier_id": cheese.String(), "qty": 1}}},
		withParams(map[string]string{"id": orderID.String(), "itemId": lineID.String()})).
		expectStatus(http.StatusNoContent)

	unit, base, _, _ := lineFold(fx, lineID)
	if unit != 35000 {
		t.Errorf("unit_price_cents = %d, want 35000 (300 + 50 cheese)", unit)
	}
	if base != 30000 {
		t.Errorf("base_price_cents = %d, want 30000 — the base must not move", base)
	}
	var rows int
	fx.adminScan([]any{&rows},
		`SELECT count(*)::int FROM order_item_modifiers WHERE order_item_id = $1`, lineID)
	if rows != 1 {
		t.Errorf("add-on rows = %d, want 1 — the old add-on was not replaced", rows)
	}
	if v := addonViolations(fx); v != 0 {
		t.Errorf("fold invariant violations = %d, want 0", v)
	}
}

// Sending an empty array clears the add-ons and returns the line to its own
// price; omitting the key leaves them alone.
func TestAddOns_UpdateEmptyClearsButOmittedKeeps(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	r := addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": bacon.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
	var resp struct{ Items []OrderItem }
	r.decode(&resp)
	lineID := resp.Items[0].ID

	// Omitted → untouched.
	callHandler(t, fx, UpdateOrderItem, http.MethodPatch, "/",
		map[string]any{"qty": 2},
		withParams(map[string]string{"id": orderID.String(), "itemId": lineID.String()})).
		expectStatus(http.StatusNoContent)
	if unit, _, _, _ := lineFold(fx, lineID); unit != 34000 {
		t.Errorf("after omitting add_ons: unit = %d, want 34000 (unchanged)", unit)
	}

	// Explicit [] → cleared.
	callHandler(t, fx, UpdateOrderItem, http.MethodPatch, "/",
		map[string]any{"add_ons": []map[string]any{}},
		withParams(map[string]string{"id": orderID.String(), "itemId": lineID.String()})).
		expectStatus(http.StatusNoContent)
	if unit, _, _, _ := lineFold(fx, lineID); unit != 30000 {
		t.Errorf("after clearing add_ons: unit = %d, want 30000", unit)
	}
	if v := addonViolations(fx); v != 0 {
		t.Errorf("fold invariant violations = %d, want 0", v)
	}
}

// =========================================================================
// Offline replay
// =========================================================================

// Replaying the same batch (flaky wifi, offline queue retry) must not double the
// add-ons or the folded price.
func TestAddOns_ReplayIsExactlyOnce(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	bacon := fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	lineID := uuid.NewString()
	addOnID := uuid.NewString()
	payload := map[string]any{"items": []map[string]any{{
		"id":           lineID,
		"menu_item_id": item.String(),
		"qty":          1,
		"add_ons":      []map[string]any{{"id": addOnID, "modifier_id": bacon.String(), "qty": 1}},
	}}}

	for i := 0; i < 3; i++ {
		callHandler(t, fx, AddOrderItems(testHub()), http.MethodPost, "/", payload,
			withParam("id", orderID.String())).
			expectStatus(http.StatusCreated)
	}

	var lines, addOns int
	fx.adminScan([]any{&lines},
		`SELECT count(*)::int FROM order_items WHERE order_id = $1`, orderID)
	fx.adminScan([]any{&addOns},
		`SELECT count(*)::int FROM order_item_modifiers WHERE order_item_id = $1`, lineID)
	if lines != 1 {
		t.Errorf("order_items rows = %d after 3 replays, want 1", lines)
	}
	if addOns != 1 {
		t.Errorf("order_item_modifiers rows = %d after 3 replays, want 1", addOns)
	}
	if unit, _, _, _ := lineFold(fx, uuid.MustParse(lineID)); unit != 34000 {
		t.Errorf("unit_price_cents = %d after 3 replays, want 34000", unit)
	}
	if v := addonViolations(fx); v != 0 {
		t.Errorf("fold invariant violations = %d, want 0", v)
	}
}

// =========================================================================
// Catalog CRUD
// =========================================================================

// A group still attached to an item can't be deleted — silently stripping
// add-ons off a live menu is worse than making the operator detach first.
func TestModifierGroup_DeleteRefusedWhileAttached(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	fx.seedModifier(grp, "Bacon", 4000, nil)
	fx.attachGroupToItem(item, grp)

	callHandler(t, fx, DeleteModifierGroup, http.MethodDelete, "/", nil,
		withParam("id", grp.String())).
		expectErr(http.StatusConflict, "group_in_use")

	// Detach, then it deletes — and its modifiers go with it.
	callHandler(t, fx, PutMenuItemModifierGroups, http.MethodPut, "/",
		map[string]any{"group_ids": []string{}},
		withParam("id", item.String())).
		expectStatus(http.StatusOK)
	callHandler(t, fx, DeleteModifierGroup, http.MethodDelete, "/", nil,
		withParam("id", grp.String())).
		expectStatus(http.StatusOK)

	var liveMods int
	fx.adminScan([]any{&liveMods}, `
		SELECT count(*)::int FROM menu_modifiers WHERE group_id = $1 AND deleted_at IS NULL
	`, grp)
	if liveMods != 0 {
		t.Errorf("live modifiers after group delete = %d, want 0", liveMods)
	}
}

// Bounds that describe an unsatisfiable group are refused with a 400, not a 500
// from the DB constraint.
func TestModifierGroup_RejectsImpossibleBounds(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateModifierGroup, http.MethodPost, "/",
		map[string]any{"name": "Broken", "min_select": 3, "max_select": 1}).
		expectErr(http.StatusBadRequest, "bad_request")

	// And a PATCH is validated against the resulting PAIR, not just what was
	// sent: raising min alone can invalidate an existing max.
	grp := fx.seedModifierGroup("Sizes", 0, ptrInt(2))
	callHandler(t, fx, UpdateModifierGroup, http.MethodPatch, "/",
		map[string]any{"min_select": 5},
		withParam("id", grp.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func ptrInt(v int) *int { return &v }

// Duplicate group names collide per tenant, and the same name is fine in a
// different tenant.
func TestModifierGroup_DuplicateNamePerTenant(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateModifierGroup, http.MethodPost, "/",
		map[string]any{"name": "Extras"}).
		expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateModifierGroup, http.MethodPost, "/",
		map[string]any{"name": "extras"}).
		expectErr(http.StatusConflict, "duplicate_name")

	other := newTenant(t)
	callHandler(t, other, CreateModifierGroup, http.MethodPost, "/",
		map[string]any{"name": "Extras"}).
		expectStatus(http.StatusCreated)
}

// Attaching a group that doesn't exist is a 400, and nothing is written — the
// tx commits on 4xx, so a partial attach would persist.
func TestModifierGroup_AttachRejectsUnknownGroupAtomically(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Burger", 30000)
	good := fx.seedModifierGroup("Extras", 0, nil)

	callHandler(t, fx, PutMenuItemModifierGroups, http.MethodPut, "/",
		map[string]any{"group_ids": []string{good.String(), uuid.NewString()}},
		withParam("id", item.String())).
		expectErr(http.StatusBadRequest, "group_not_found")

	var attached int
	fx.adminScan([]any{&attached},
		`SELECT count(*)::int FROM menu_item_modifier_groups WHERE menu_item_id = $1`, item)
	if attached != 0 {
		t.Errorf("attachments = %d, want 0 — a rejected PUT wrote a partial set", attached)
	}
}

// Groups from another tenant are invisible: RLS must keep the add-on catalog
// tenant-scoped like everything else.
func TestModifierGroup_TenantIsolation(t *testing.T) {
	a := newTenant(t)
	b := newTenant(t)
	a.seedModifierGroup("A extras", 0, nil)
	b.seedModifierGroup("B extras", 0, nil)

	r := callHandler(t, b, ListModifierGroups, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK)
	var resp struct {
		Groups []ModifierGroup `json:"groups"`
	}
	r.decode(&resp)
	for _, g := range resp.Groups {
		if g.Name == "A extras" {
			t.Fatal("tenant B can see tenant A's add-on group — RLS is not applied")
		}
	}
	if len(resp.Groups) != 1 || resp.Groups[0].Name != "B extras" {
		t.Fatalf("groups = %+v, want only B extras", resp.Groups)
	}
}

// The menu list exposes each item's own attached groups and each category's, so
// the client can compute the effective union without an extra round trip.
func TestMenu_ExposesAttachedGroupIDs(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Drinks")
	latte := fx.seedMenuItem(cat, "Latte", 15000)
	catGrp := fx.seedModifierGroup("Drink extras", 0, nil)
	itemGrp := fx.seedModifierGroup("Syrups", 0, nil)
	fx.attachGroupToCategory(cat, catGrp)
	fx.attachGroupToItem(latte, itemGrp)

	ri := callHandler(t, fx, ListMenuItems, http.MethodGet, "/", nil).expectStatus(http.StatusOK)
	var items struct {
		Items []MenuItem `json:"items"`
	}
	ri.decode(&items)
	if len(items.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(items.Items))
	}
	if got := items.Items[0].ModifierGroupIDs; len(got) != 1 || got[0] != itemGrp {
		t.Errorf("item modifier_group_ids = %v, want [%v]", got, itemGrp)
	}

	rc := callHandler(t, fx, ListMenuCategories, http.MethodGet, "/", nil).expectStatus(http.StatusOK)
	var cats struct {
		Categories []MenuCategory `json:"categories"`
	}
	rc.decode(&cats)
	if got := cats.Categories[0].ModifierGroupIDs; len(got) != 1 || got[0] != catGrp {
		t.Errorf("category modifier_group_ids = %v, want [%v]", got, catGrp)
	}
}

// =========================================================================
// The KDS
// =========================================================================

// An add-on rides on its parent's ticket. One dish with an add-on is ONE card,
// which is the whole point of the feature.
func TestAddOns_KitchenTicketCarriesAddOnsNotExtraCards(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Sandwich", 20000)
	grp := fx.seedModifierGroup("Extras", 0, nil)
	cheese := fx.seedModifier(grp, "Extra cheese", 5000, nil)
	fx.attachGroupToItem(item, grp)

	orderID := fx.seedOpenOrder(nil)
	addLineWithAddOns(fx, orderID, item, 1,
		[]map[string]any{{"modifier_id": cheese.String(), "qty": 1}}).
		expectStatus(http.StatusCreated)
	callHandler(t, fx, SendOrderToKitchen(testHub()), http.MethodPost, "/", nil,
		withParam("id", orderID.String())).
		expectStatus(http.StatusOK)

	r := callHandler(t, fx, ListKitchenTickets, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK)
	var resp struct {
		Tickets []KitchenTicket `json:"tickets"`
	}
	r.decode(&resp)
	if len(resp.Tickets) != 1 {
		t.Fatalf("tickets = %d, want 1 — the add-on must not get its own KDS card", len(resp.Tickets))
	}
	if len(resp.Tickets[0].AddOns) != 1 || resp.Tickets[0].AddOns[0].Name != "Extra cheese" {
		t.Errorf("ticket add_ons = %+v, want one Extra cheese", resp.Tickets[0].AddOns)
	}
}
