package api

import (
	"testing"
)

// =========================================================================
// BulkImportMenu
// =========================================================================

// importPayload builds a minimal {categories:[{name, items:[{name, price_cents}]}]}
// body for the common case.
func importCat(name string, items ...map[string]any) map[string]any {
	return map[string]any{"name": name, "items": items}
}
func importItem(name string, priceCents int64) map[string]any {
	return map[string]any{"name": name, "price_cents": priceCents}
}

func TestBulkImport_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, BulkImportMenu, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestBulkImport_EmptyCategoriesRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, BulkImportMenu, "POST", "/",
		map[string]any{"categories": []any{}}).
		expectErr(400, "bad_request")
}

func TestBulkImport_FreshCreatesCategoriesAndItems(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 12000), importItem("Latte", 18000)),
			importCat("Snacks", importItem("Cookie", 5000)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)

	if resp.Categories.Created != 2 || resp.Categories.Updated != 0 {
		t.Fatalf("categories = %+v, want created 2 updated 0", resp.Categories)
	}
	if resp.Items.Created != 3 || resp.Items.Updated != 0 {
		t.Fatalf("items = %+v, want created 3 updated 0", resp.Items)
	}
	if n := fx.countRows("menu_categories"); n != 2 {
		t.Fatalf("menu_categories rows = %d, want 2", n)
	}
	if n := fx.countRows("menu_items"); n != 3 {
		t.Fatalf("menu_items rows = %d, want 3", n)
	}
}

func TestBulkImport_ReImportOverwriteUpdates(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 12000), importItem("Latte", 18000)),
		},
	}
	callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)

	// Re-import with Espresso re-priced; overwrite defaults to true.
	body2 := map[string]any{
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 13000), importItem("Latte", 18000)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body2).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	if resp.Categories.Updated != 1 || resp.Categories.Created != 0 {
		t.Fatalf("categories = %+v, want updated 1 created 0", resp.Categories)
	}
	if resp.Items.Updated != 2 || resp.Items.Created != 0 {
		t.Fatalf("items = %+v, want updated 2 created 0", resp.Items)
	}
	// No duplicate rows.
	if n := fx.countRows("menu_items"); n != 2 {
		t.Fatalf("menu_items rows = %d, want 2 (no duplicates)", n)
	}
	// Price actually changed.
	var price int64
	fx.adminScan([]any{&price},
		`SELECT price_cents FROM menu_items WHERE tenant_id = $1 AND lower(name) = 'espresso' AND deleted_at IS NULL`, fx.Tenant)
	if price != 13000 {
		t.Fatalf("espresso price = %d, want 13000 (overwritten)", price)
	}
}

func TestBulkImport_ReImportNoOverwriteSkips(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 12000)),
		},
	}
	callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)

	// Re-import: re-priced Espresso (should be ignored) + a brand-new Mocha.
	overwrite := false
	body2 := map[string]any{
		"overwrite_existing": overwrite,
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 13000), importItem("Mocha", 20000)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body2).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	if resp.Categories.Skipped != 1 {
		t.Fatalf("categories = %+v, want skipped 1", resp.Categories)
	}
	if resp.Items.Skipped != 1 || resp.Items.Created != 1 {
		t.Fatalf("items = %+v, want skipped 1 created 1", resp.Items)
	}
	// Espresso price unchanged; Mocha now exists.
	var price int64
	fx.adminScan([]any{&price},
		`SELECT price_cents FROM menu_items WHERE tenant_id = $1 AND lower(name) = 'espresso' AND deleted_at IS NULL`, fx.Tenant)
	if price != 12000 {
		t.Fatalf("espresso price = %d, want 12000 (not overwritten)", price)
	}
	if n := fx.countRows("menu_items"); n != 2 {
		t.Fatalf("menu_items rows = %d, want 2 (espresso + mocha)", n)
	}
}

func TestBulkImport_DryRunWritesNothing(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"dry_run": true,
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 12000), importItem("Latte", 18000)),
			importCat("Snacks", importItem("Cookie", 5000)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	if !resp.DryRun {
		t.Fatal("response dry_run should be true")
	}
	// Classification still computed.
	if resp.Categories.Created != 2 || resp.Items.Created != 3 {
		t.Fatalf("dry-run classification = cats %+v items %+v, want 2 / 3 created", resp.Categories, resp.Items)
	}
	// But nothing was written.
	if n := fx.countRows("menu_categories"); n != 0 {
		t.Fatalf("menu_categories rows = %d after dry-run, want 0", n)
	}
	if n := fx.countRows("menu_items"); n != 0 {
		t.Fatalf("menu_items rows = %d after dry-run, want 0", n)
	}
}

func TestBulkImport_DryRunClassifiesExisting(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Hot Coffee")
	fx.seedMenuItem(catID, "Espresso", 12000)

	body := map[string]any{
		"dry_run": true,
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 13000), importItem("Latte", 18000)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	// Existing category + existing item update; new item creates.
	if resp.Categories.Updated != 1 || resp.Categories.Created != 0 {
		t.Fatalf("categories = %+v, want updated 1", resp.Categories)
	}
	if resp.Items.Updated != 1 || resp.Items.Created != 1 {
		t.Fatalf("items = %+v, want updated 1 created 1", resp.Items)
	}
	// Still no writes.
	if n := fx.countRows("menu_items"); n != 1 {
		t.Fatalf("menu_items rows = %d after dry-run, want 1 (unchanged)", n)
	}
}

func TestBulkImport_ZeroPriceRejected(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Cat", importItem("Free Water", 0)),
		},
	}
	callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectErr(400, "bad_request")
	if n := fx.countRows("menu_categories"); n != 0 {
		t.Fatalf("menu_categories rows = %d, want 0 (rejected)", n)
	}
}

func TestBulkImport_BlankItemNameRejected(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Cat", importItem("", 500)),
		},
	}
	callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectErr(400, "bad_request")
}

func TestBulkImport_BadKitchenBehaviorRejected(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			map[string]any{
				"name":             "Cat",
				"kitchen_behavior": "explode",
				"items":            []any{importItem("X", 500)},
			},
		},
	}
	callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectErr(400, "bad_request")
}

// A bad row deep in the payload must abort the whole import with NO partial
// write — the handler validates everything before writing because the tx
// commits even on a 4xx.
func TestBulkImport_AtomicNoPartialWriteOnInvalid(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Good", importItem("OK", 500)),
			importCat("Bad", importItem("NoPrice", 0)),
		},
	}
	callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectErr(400, "bad_request")
	if n := fx.countRows("menu_categories"); n != 0 {
		t.Fatalf("menu_categories rows = %d, want 0 (atomic abort)", n)
	}
	if n := fx.countRows("menu_items"); n != 0 {
		t.Fatalf("menu_items rows = %d, want 0 (atomic abort)", n)
	}
}

func TestBulkImport_MatchesExistingCategoryCaseInsensitive(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("Coffee")

	// Import with different casing — should attach to the existing category,
	// not create a second one (which would violate the unique index → 500).
	body := map[string]any{
		"categories": []any{
			importCat("coffee", importItem("Flat White", 600)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	if resp.Categories.Created != 0 || resp.Categories.Updated != 1 {
		t.Fatalf("categories = %+v, want created 0 updated 1", resp.Categories)
	}
	if resp.Items.Created != 1 {
		t.Fatalf("items = %+v, want created 1", resp.Items)
	}
	if n := fx.countRows("menu_categories"); n != 1 {
		t.Fatalf("menu_categories rows = %d, want 1 (matched, not duplicated)", n)
	}
	// The new item belongs to the seeded category.
	var gotCat string
	fx.adminScan([]any{&gotCat},
		`SELECT category_id::text FROM menu_items WHERE tenant_id = $1 AND lower(name) = 'flat white'`, fx.Tenant)
	if gotCat != catID.String() {
		t.Fatalf("flat white category = %s, want %s", gotCat, catID)
	}
}

func TestBulkImport_DuplicateCategoryNamesMerged(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Tea", importItem("Green", 300)),
			importCat("tea", importItem("Black", 350)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	if resp.Categories.Created != 1 {
		t.Fatalf("categories = %+v, want created 1 (merged)", resp.Categories)
	}
	if resp.Items.Created != 2 {
		t.Fatalf("items = %+v, want created 2", resp.Items)
	}
	if n := fx.countRows("menu_categories"); n != 1 {
		t.Fatalf("menu_categories rows = %d, want 1", n)
	}
	if n := fx.countRows("menu_items"); n != 2 {
		t.Fatalf("menu_items rows = %d, want 2", n)
	}
}

func TestBulkImport_DuplicateItemNamesDeduped(t *testing.T) {
	fx := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Tea", importItem("Green", 300), importItem("green", 400)),
		},
	}
	r := callHandler(t, fx, BulkImportMenu, "POST", "/", body).expectStatus(200)
	var resp bulkImportResp
	r.decode(&resp)
	if resp.Items.Created != 1 {
		t.Fatalf("items = %+v, want created 1 (first occurrence wins)", resp.Items)
	}
	if n := fx.countRows("menu_items"); n != 1 {
		t.Fatalf("menu_items rows = %d, want 1", n)
	}
}

func TestBulkImport_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	body := map[string]any{
		"categories": []any{
			importCat("Hot Coffee", importItem("Espresso", 12000)),
		},
	}
	callHandler(t, fx1, BulkImportMenu, "POST", "/", body).expectStatus(200)

	// fx2 saw none of fx1's rows.
	if n := fx2.countRows("menu_categories"); n != 0 {
		t.Fatalf("tenant isolation violated: fx2 has %d categories", n)
	}
	if n := fx2.countRows("menu_items"); n != 0 {
		t.Fatalf("tenant isolation violated: fx2 has %d items", n)
	}
}
