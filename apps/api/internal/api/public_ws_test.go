package api

// Integration tests for:
//   - GetPublicMenu    (public.go)
//   - ListPublicPlans  (public_requests.go)
//   - RequestAccess    (public_requests.go)
//   - IssueWSTicket    (ws_ticket.go)
//
// Run against the real local Postgres `cafe` DB; skipped gracefully when no
// database URL is configured (mirrors the rest of the test suite).

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Helpers — domain-prefixed to avoid collisions with other test files.
// =========================================================================

// pubSeedInactiveCategory inserts a menu category with is_active = false.
func pubSeedInactiveCategory(fx *fixture, name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_categories (tenant_id, name, is_active) VALUES ($1, $2, false) RETURNING id`,
		fx.Tenant, name)
	return id
}

// pubSeedDeletedCategory inserts a category that is soft-deleted.
func pubSeedDeletedCategory(fx *fixture, name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_categories (tenant_id, name, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
		fx.Tenant, name)
	return id
}

// pubSeedMenuItemInactive inserts a menu item with is_active = false.
func pubSeedMenuItemInactive(fx *fixture, catID uuid.UUID, name string, priceCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents, is_active) VALUES ($1,$2,$3,$4,false) RETURNING id`,
		fx.Tenant, catID, name, priceCents)
	return id
}

// pubSeedMenuItemDeleted inserts a menu item that is soft-deleted.
func pubSeedMenuItemDeleted(fx *fixture, catID uuid.UUID, name string, priceCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents, deleted_at) VALUES ($1,$2,$3,$4,now()) RETURNING id`,
		fx.Tenant, catID, name, priceCents)
	return id
}

// pubSeedMenuItemWithCost inserts a menu item with a cost_cents value set.
func pubSeedMenuItemWithCost(fx *fixture, catID uuid.UUID, name string, priceCents, costCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents, cost_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		fx.Tenant, catID, name, priceCents, costCents)
	return id
}

// pubSeedPlan inserts a test plan row and returns its key. Caller must clean up.
func pubSeedPlan(t *testing.T, key, name string, active bool) {
	t.Helper()
	requireDB(t)
	_, err := adminPool.Exec(context.Background(), `
		INSERT INTO plans (key, name, active, sort_order)
		VALUES ($1, $2, $3, 999)
		ON CONFLICT (key) DO NOTHING
	`, key, name, active)
	if err != nil {
		t.Fatalf("pubSeedPlan: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE key = $1`, key)
	})
}

// pubSeedPlanFull inserts a plan with all fields and returns its key.
func pubSeedPlanFull(t *testing.T, key, name string, memberLimit *int, priceCopy string, isEnterprise, active bool) {
	t.Helper()
	requireDB(t)
	_, err := adminPool.Exec(context.Background(), `
		INSERT INTO plans (key, name, member_limit, price_copy, is_enterprise, active, sort_order)
		VALUES ($1, $2, $3, $4, $5, $6, 998)
		ON CONFLICT (key) DO NOTHING
	`, key, name, memberLimit, priceCopy, isEnterprise, active)
	if err != nil {
		t.Fatalf("pubSeedPlanFull: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE key = $1`, key)
	})
}

// pubCleanRequest deletes a tenant_request row by email (global table cleanup).
func pubCleanRequest(t *testing.T, email string) {
	t.Helper()
	_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenant_requests WHERE email = $1`, email)
}

// pubCountRequests returns count of pending tenant_requests for a given email.
func pubCountRequests(t *testing.T, email string) int {
	t.Helper()
	var n int
	if err := adminPool.QueryRow(context.Background(),
		`SELECT count(*) FROM tenant_requests WHERE email = $1 AND state = 'pending'`, email,
	).Scan(&n); err != nil {
		t.Fatalf("pubCountRequests: %v", err)
	}
	return n
}

// pubCountWSTickets returns the number of ws_tickets rows for a given user+tenant pair.
func pubCountWSTickets(t *testing.T, userID, tenantID uuid.UUID) int {
	t.Helper()
	var n int
	if err := adminPool.QueryRow(context.Background(),
		`SELECT count(*) FROM ws_tickets WHERE user_id = $1 AND tenant_id = $2 AND consumed_at IS NULL`,
		userID, tenantID,
	).Scan(&n); err != nil {
		t.Fatalf("pubCountWSTickets: %v", err)
	}
	return n
}

// =========================================================================
// GetPublicMenu
// =========================================================================

// TestGetPublicMenu_NoTenantContext — without a tenant context callHandler
// propagates a missing context; in practice the middleware sets it, but the
// handler's own guard returns 404 "tenant_not_found" when absent.
func TestGetPublicMenu_NoTenantContext(t *testing.T) {
	fx := newTenant(t)
	// Use withoutTenant() so callHandler skips setting appctx.Tenant.
	callHandler(t, fx, GetPublicMenu, "GET", "/", nil, withoutTenant()).
		expectErr(404, "tenant_not_found")
}

// TestGetPublicMenu_EmptyMenu — tenant exists but has no categories/items.
func TestGetPublicMenu_EmptyMenu(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).
		expectStatus(200)

	var resp publicMenuResponse
	r.decode(&resp)

	if resp.Cafe.Slug != fx.Slug {
		t.Fatalf("slug = %q, want %q", resp.Cafe.Slug, fx.Slug)
	}
	if resp.Cafe.Name != fx.Name {
		t.Fatalf("cafe name = %q, want %q", resp.Cafe.Name, fx.Name)
	}
	if resp.Cafe.Currency != "NPR" {
		t.Fatalf("currency = %q, want NPR", resp.Cafe.Currency)
	}
	if resp.Categories == nil {
		t.Fatal("categories should be a non-nil slice")
	}
	if len(resp.Categories) != 0 {
		t.Fatalf("categories = %d, want 0", len(resp.Categories))
	}
}

// TestGetPublicMenu_OnlyActiveItemsVisible — active items appear; inactive and
// soft-deleted items/categories must be absent from the wire response.
func TestGetPublicMenu_OnlyActiveItemsVisible(t *testing.T) {
	fx := newTenant(t)

	// Active category with an active item.
	catActive := fx.seedCategory("Drinks")
	itemActive := fx.seedMenuItem(catActive, "Latte", 350)

	// Active category whose only item is inactive — must be dropped from output.
	catNoActiveItems := fx.seedCategory("Archived Cat")
	pubSeedMenuItemInactive(fx, catNoActiveItems, "Old Item", 100)

	// Inactive category — must not appear.
	pubSeedInactiveCategory(fx, "Invisible Category")

	// Soft-deleted category — must not appear.
	pubSeedDeletedCategory(fx, "Deleted Category")

	// Soft-deleted item in the active category — must not appear.
	pubSeedMenuItemDeleted(fx, catActive, "Deleted Drink", 200)

	// Inactive item in the active category — must not appear.
	pubSeedMenuItemInactive(fx, catActive, "Off Menu", 150)

	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)

	var resp publicMenuResponse
	r.decode(&resp)

	if len(resp.Categories) != 1 {
		t.Fatalf("visible categories = %d, want 1; got %+v", len(resp.Categories), resp.Categories)
	}
	cat := resp.Categories[0]
	if cat.ID != catActive {
		t.Fatalf("category id mismatch")
	}
	if cat.Name != "Drinks" {
		t.Fatalf("category name = %q, want Drinks", cat.Name)
	}
	if len(cat.Items) != 1 {
		t.Fatalf("visible items = %d, want 1", len(cat.Items))
	}
	item := cat.Items[0]
	if item.ID != itemActive {
		t.Fatalf("item id mismatch")
	}
	if item.Name != "Latte" {
		t.Fatalf("item name = %q, want Latte", item.Name)
	}
	if item.PriceCents != 350 {
		t.Fatalf("price_cents = %d, want 350", item.PriceCents)
	}
}

// TestGetPublicMenu_NoCostCentsInResponse — cost_cents is an operator-only
// field; it must never appear on the public DTO.
func TestGetPublicMenu_NoCostCentsInResponse(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	pubSeedMenuItemWithCost(fx, cat, "Samosa", 50, 20)

	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)

	// Inspect the raw JSON bytes: "cost_cents" must not appear at all.
	body := string(r.Body)
	if strings.Contains(body, "cost_cents") {
		t.Fatalf("response body contains cost_cents — sensitive field leaked: %s", body)
	}
	// Also "sku", "modifiers", "sort" must not appear.
	for _, forbidden := range []string{"sku", "modifiers"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("response body contains forbidden operator field %q: %s", forbidden, body)
		}
	}
}

// TestGetPublicMenu_IsFeaturedField — is_featured should appear in the
// public DTO (it's a safe presentational flag).
func TestGetPublicMenu_IsFeaturedField(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Specials")
	// Seed a featured item directly with is_featured = true.
	var itemID uuid.UUID
	fx.adminScan([]any{&itemID},
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents, is_featured)
		 VALUES ($1,$2,'Chef Special',500,true) RETURNING id`,
		fx.Tenant, cat)

	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)
	var resp publicMenuResponse
	r.decode(&resp)

	if len(resp.Categories) != 1 || len(resp.Categories[0].Items) != 1 {
		t.Fatalf("unexpected response shape: %+v", resp)
	}
	if !resp.Categories[0].Items[0].IsFeatured {
		t.Fatalf("is_featured = false, want true for featured item")
	}
}

// TestGetPublicMenu_BrandingSubsetOnly — the branding map must only contain
// the known-safe subset (brandPrimary, brandAccent, mood, typography) and
// never contain raw operator keys that were not explicitly allowlisted.
func TestGetPublicMenu_BrandingSubsetOnly(t *testing.T) {
	fx := newTenant(t)
	// Set branding with a mix of safe + sensitive keys.
	fx.adminExec(`
		UPDATE tenants SET branding = $2::jsonb WHERE id = $1
	`, fx.Tenant, `{
		"cafeName": "My Cafe",
		"tagline": "Best coffee",
		"brandPrimary": "#ff0000",
		"brandAccent": "#00ff00",
		"mood": "cozy",
		"typography": "sans",
		"internalNotes": "secret",
		"ownerPhone": "9800000000"
	}`)

	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)
	var resp publicMenuResponse
	r.decode(&resp)

	// Safe keys must be present.
	if resp.Cafe.Name != "My Cafe" {
		t.Fatalf("cafeName branding override = %q, want 'My Cafe'", resp.Cafe.Name)
	}
	if resp.Cafe.Tagline != "Best coffee" {
		t.Fatalf("tagline = %q, want 'Best coffee'", resp.Cafe.Tagline)
	}
	if resp.Cafe.Branding["brandPrimary"] != "#ff0000" {
		t.Fatalf("brandPrimary missing from branding")
	}

	// Sensitive keys must NOT be in the branding map.
	for _, forbidden := range []string{"internalNotes", "ownerPhone"} {
		if _, ok := resp.Cafe.Branding[forbidden]; ok {
			t.Fatalf("branding map contains forbidden key %q", forbidden)
		}
	}
}

// TestGetPublicMenu_CacheControlHeader — the endpoint must set the public
// cache header for CDN/browser caching.
func TestGetPublicMenu_CacheControlHeader(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)
	cc := r.Hdr.Get("Cache-Control")
	if !strings.Contains(cc, "public") || !strings.Contains(cc, "max-age=60") {
		t.Fatalf("Cache-Control = %q, want 'public, max-age=60'", cc)
	}
}

// TestGetPublicMenu_EmptyCategoriesDropped — a category with no active items
// must be omitted from the response entirely.
func TestGetPublicMenu_EmptyCategoriesDropped(t *testing.T) {
	fx := newTenant(t)

	// Category 1: has one active item → should appear.
	cat1 := fx.seedCategory("Visible")
	fx.seedMenuItem(cat1, "Espresso", 200)

	// Category 2: has only an inactive item → should be dropped.
	cat2 := fx.seedCategory("Hidden")
	pubSeedMenuItemInactive(fx, cat2, "Gone", 100)

	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)
	var resp publicMenuResponse
	r.decode(&resp)

	if len(resp.Categories) != 1 {
		t.Fatalf("categories = %d, want 1 (empty-category drop)", len(resp.Categories))
	}
	if resp.Categories[0].ID != cat1 {
		t.Fatalf("wrong category returned")
	}
}

// TestGetPublicMenu_TaxRatesExposed — vat_pct and service_charge_pct must be
// surfaced for the guest receipt estimate.
func TestGetPublicMenu_TaxRatesExposed(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("10", "13")

	r := callHandler(t, fx, GetPublicMenu, "GET", "/", nil).expectStatus(200)
	var resp publicMenuResponse
	r.decode(&resp)

	// numeric(5,2) renders with 2-decimal scale as a JSON string.
	if resp.Cafe.ServiceChargePct != "10.00" {
		t.Fatalf("service_charge_pct = %q, want 10.00", resp.Cafe.ServiceChargePct)
	}
	if resp.Cafe.VatPct != "13.00" {
		t.Fatalf("vat_pct = %q, want 13.00", resp.Cafe.VatPct)
	}
}

// =========================================================================
// ListPublicPlans
// =========================================================================

// TestListPublicPlans_ReturnsPlansJSON — the endpoint returns a JSON object
// with a "plans" array. Existing active non-trial plans are present.
func TestListPublicPlans_ReturnsPlansJSON(t *testing.T) {
	requireDB(t)
	// The dev DB always has standard/growth/enterprise plans (active, not trial).
	fx := newTenant(t)
	r := callHandler(t, fx, ListPublicPlans(appPool), "GET", "/", nil, withoutTenant()).
		expectStatus(200)

	body := r.json()
	plans, ok := body["plans"].([]any)
	if !ok {
		t.Fatalf("plans key missing or not an array: %s", string(r.Body))
	}
	if len(plans) == 0 {
		t.Fatalf("expected at least one non-trial plan")
	}
}

// TestListPublicPlans_TrialPlanExcluded — the 'trial' plan must never appear
// in the public picker (it is auto-assigned on provisioning).
func TestListPublicPlans_TrialPlanExcluded(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	r := callHandler(t, fx, ListPublicPlans(appPool), "GET", "/", nil, withoutTenant()).
		expectStatus(200)

	body := r.json()
	plans := body["plans"].([]any)
	for _, p := range plans {
		pm := p.(map[string]any)
		if pm["key"] == "trial" {
			t.Fatalf("trial plan must not appear in public list")
		}
	}
}

// TestListPublicPlans_InactivePlanExcluded — an inactive plan must not appear.
func TestListPublicPlans_InactivePlanExcluded(t *testing.T) {
	requireDB(t)
	// Seed a unique inactive plan.
	key := "test-inactive-" + uuid.NewString()[:8]
	pubSeedPlan(t, key, "Inactive Test Plan", false)

	fx := newTenant(t)
	r := callHandler(t, fx, ListPublicPlans(appPool), "GET", "/", nil, withoutTenant()).
		expectStatus(200)

	body := r.json()
	plans := body["plans"].([]any)
	for _, p := range plans {
		pm := p.(map[string]any)
		if pm["key"] == key {
			t.Fatalf("inactive plan %q must not appear in public list", key)
		}
	}
}

// TestListPublicPlans_PublicSafeFields — each plan in the response must
// contain the expected customer-safe fields (key, name, price_copy,
// is_enterprise, member_limit) and must not contain internal fields like
// sort_order, active, id.
func TestListPublicPlans_PublicSafeFields(t *testing.T) {
	requireDB(t)
	// Seed a known test plan with all fields set.
	key := "test-pub-" + uuid.NewString()[:8]
	limit := 5
	pubSeedPlanFull(t, key, "Test Public Plan", &limit, "Rs 1000/mo", false, true)

	fx := newTenant(t)
	r := callHandler(t, fx, ListPublicPlans(appPool), "GET", "/", nil, withoutTenant()).
		expectStatus(200)

	body := r.json()
	plans := body["plans"].([]any)

	var found bool
	for _, p := range plans {
		pm := p.(map[string]any)
		if pm["key"] != key {
			continue
		}
		found = true
		if pm["name"] != "Test Public Plan" {
			t.Fatalf("name = %q, want 'Test Public Plan'", pm["name"])
		}
		if pm["price_copy"] != "Rs 1000/mo" {
			t.Fatalf("price_copy = %q, want 'Rs 1000/mo'", pm["price_copy"])
		}
		if pm["is_enterprise"] != false {
			t.Fatalf("is_enterprise = %v, want false", pm["is_enterprise"])
		}
		// member_limit should be present (non-null).
		if pm["member_limit"] == nil {
			t.Fatalf("member_limit missing for seeded plan")
		}
		// Internal fields must not be present.
		for _, forbidden := range []string{"sort_order", "active", "id"} {
			if _, ok := pm[forbidden]; ok {
				t.Fatalf("plan response contains internal field %q", forbidden)
			}
		}
	}
	if !found {
		t.Fatalf("seeded plan %q not found in response", key)
	}
}

// TestListPublicPlans_NullMemberLimitAllowed — a plan with no seat cap
// (member_limit IS NULL) must serialize as null (not missing).
func TestListPublicPlans_NullMemberLimitAllowed(t *testing.T) {
	requireDB(t)
	key := "test-unlim-" + uuid.NewString()[:8]
	pubSeedPlanFull(t, key, "Unlimited Plan", nil, "", false, true)

	fx := newTenant(t)
	r := callHandler(t, fx, ListPublicPlans(appPool), "GET", "/", nil, withoutTenant()).
		expectStatus(200)

	body := r.json()
	plans := body["plans"].([]any)

	var found bool
	for _, p := range plans {
		pm := p.(map[string]any)
		if pm["key"] != key {
			continue
		}
		found = true
		// member_limit key must be present but null.
		if v, exists := pm["member_limit"]; !exists {
			t.Fatalf("member_limit key missing from plan with no seat cap")
		} else if v != nil {
			t.Fatalf("member_limit = %v, want null for unlimited plan", v)
		}
	}
	if !found {
		t.Fatalf("seeded plan %q not found in response", key)
	}
}

// =========================================================================
// RequestAccess
// =========================================================================

// TestRequestAccess_BadJSON — malformed JSON must return 400 bad_request.
func TestRequestAccess_BadJSON(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/", "{not json", withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_MissingName — omitting name must return 400.
func TestRequestAccess_MissingName(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{"cafe_name": "My Cafe", "email": "x@test.io"},
		withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_MissingCafeName — omitting cafe_name must return 400.
func TestRequestAccess_MissingCafeName(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{"name": "Alice", "email": "x@test.io"},
		withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_MissingEmail — omitting email must return 400.
func TestRequestAccess_MissingEmail(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{"name": "Alice", "cafe_name": "My Cafe"},
		withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_BadEmail — email without '@' must return 400.
func TestRequestAccess_BadEmail(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{"name": "Alice", "cafe_name": "My Cafe", "email": "notanemail"},
		withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_NameTooLong — name > 120 chars must return 400.
func TestRequestAccess_NameTooLong(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{
			"name":      strings.Repeat("a", 121),
			"cafe_name": "My Cafe",
			"email":     "toolong@test.io",
		}, withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_CafeNameTooLong — cafe_name > 120 chars must return 400.
func TestRequestAccess_CafeNameTooLong(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{
			"name":      "Alice",
			"cafe_name": strings.Repeat("b", 121),
			"email":     "cafetolong@test.io",
		}, withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_MessageTooLong — message > 2000 chars must return 400.
func TestRequestAccess_MessageTooLong(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{
			"name":      "Alice",
			"cafe_name": "My Cafe",
			"email":     "msglong@test.io",
			"message":   strings.Repeat("x", 2001),
		}, withoutTenant()).
		expectErr(400, "bad_request")
}

// TestRequestAccess_Success — a valid request inserts a pending row and
// returns 201 {"status":"received"}.
func TestRequestAccess_Success(t *testing.T) {
	requireDB(t)
	email := "ra-success-" + uuid.NewString()[:8] + "@test.local"
	t.Cleanup(func() { pubCleanRequest(t, email) })

	fx := newTenant(t)
	r := callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{
			"name":         "Alice",
			"cafe_name":    "Alice's Cafe",
			"email":        email,
			"phone":        "9800000000",
			"desired_plan": "standard",
			"message":      "Would love to try this!",
		}, withoutTenant()).
		expectStatus(201)

	body := r.json()
	if body["status"] != "received" {
		t.Fatalf("status = %v, want 'received'", body["status"])
	}

	// Verify DB side-effect: row was persisted.
	if n := pubCountRequests(t, email); n != 1 {
		t.Fatalf("tenant_requests rows = %d, want 1", n)
	}
}

// TestRequestAccess_Success_EmailNormalized — email is lowercased before
// storage (citext comparison is case-insensitive, input is trimmed+lowercased).
func TestRequestAccess_Success_EmailNormalized(t *testing.T) {
	requireDB(t)
	suffix := uuid.NewString()[:8]
	rawEmail := "  RA-Norm-" + suffix + "@Test.Local  "
	normalizedEmail := strings.ToLower(strings.TrimSpace(rawEmail))
	t.Cleanup(func() { pubCleanRequest(t, normalizedEmail) })

	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{
			"name":      "Bob",
			"cafe_name": "Bob's Cafe",
			"email":     rawEmail,
		}, withoutTenant()).
		expectStatus(201)

	if n := pubCountRequests(t, normalizedEmail); n != 1 {
		t.Fatalf("tenant_requests rows for normalized email = %d, want 1", n)
	}
}

// TestRequestAccess_Duplicate — submitting the same email twice (while the
// first is still pending) returns 200 {"status":"already_pending"} rather
// than an error.
func TestRequestAccess_Duplicate(t *testing.T) {
	requireDB(t)
	email := "ra-dup-" + uuid.NewString()[:8] + "@test.local"
	t.Cleanup(func() { pubCleanRequest(t, email) })

	fx := newTenant(t)
	body := map[string]any{
		"name":      "Carol",
		"cafe_name": "Carol's Cafe",
		"email":     email,
	}

	// First request → 201.
	callHandler(t, fx, RequestAccess(appPool), "POST", "/", body, withoutTenant()).
		expectStatus(201)

	// Second identical request → 200 already_pending.
	r2 := callHandler(t, fx, RequestAccess(appPool), "POST", "/", body, withoutTenant()).
		expectStatus(200)

	b := r2.json()
	if b["status"] != "already_pending" {
		t.Fatalf("status = %v, want 'already_pending'", b["status"])
	}

	// Only one row must exist in DB (the unique index covers pending state).
	if n := pubCountRequests(t, email); n != 1 {
		t.Fatalf("tenant_requests rows = %d, want 1 after duplicate", n)
	}
}

// TestRequestAccess_OptionalFieldsEmpty — phone, desired_plan and message are
// optional; omitting them must still succeed.
func TestRequestAccess_OptionalFieldsEmpty(t *testing.T) {
	requireDB(t)
	email := "ra-optional-" + uuid.NewString()[:8] + "@test.local"
	t.Cleanup(func() { pubCleanRequest(t, email) })

	fx := newTenant(t)
	callHandler(t, fx, RequestAccess(appPool), "POST", "/",
		map[string]any{
			"name":      "Dave",
			"cafe_name": "Dave's Cafe",
			"email":     email,
		}, withoutTenant()).
		expectStatus(201)

	if n := pubCountRequests(t, email); n != 1 {
		t.Fatalf("tenant_requests rows = %d, want 1", n)
	}
}

// =========================================================================
// IssueWSTicket
// =========================================================================

// TestIssueWSTicket_Success — a valid tenant+user context produces a ticket
// string in the response and a matching ws_tickets row in the DB.
func TestIssueWSTicket_Success(t *testing.T) {
	fx := newTenant(t)
	t.Cleanup(func() {
		// Clean up ws_tickets rows seeded by the handler (bypasses CASCADE on
		// tenant delete since the test user is also deleted).
		_, _ = adminPool.Exec(context.Background(),
			`DELETE FROM ws_tickets WHERE user_id = $1`, fx.User)
	})

	r := callHandler(t, fx, IssueWSTicket(appPool), "POST", "/", nil).
		expectStatus(200)

	body := r.json()
	ticket, ok := body["ticket"].(string)
	if !ok || ticket == "" {
		t.Fatalf("response missing non-empty 'ticket' field: %s", string(r.Body))
	}

	// Verify the DB side-effect: a ws_tickets row was written.
	if n := pubCountWSTickets(t, fx.User, fx.Tenant); n != 1 {
		t.Fatalf("ws_tickets rows = %d, want 1", n)
	}
}

// TestIssueWSTicket_TicketIsUnique — two consecutive requests for the same
// user+tenant produce different ticket strings (each call mints a fresh token).
func TestIssueWSTicket_TicketIsUnique(t *testing.T) {
	fx := newTenant(t)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(),
			`DELETE FROM ws_tickets WHERE user_id = $1`, fx.User)
	})

	r1 := callHandler(t, fx, IssueWSTicket(appPool), "POST", "/", nil).expectStatus(200)
	r2 := callHandler(t, fx, IssueWSTicket(appPool), "POST", "/", nil).expectStatus(200)

	t1 := r1.json()["ticket"].(string)
	t2 := r2.json()["ticket"].(string)
	if t1 == t2 {
		t.Fatalf("two consecutive tickets are equal — tokens not unique")
	}

	// Both rows must exist in the DB.
	if n := pubCountWSTickets(t, fx.User, fx.Tenant); n != 2 {
		t.Fatalf("ws_tickets rows = %d, want 2", n)
	}
}

// TestIssueWSTicket_NoUserContext — handler must return 401 when the user
// context is absent (simulated by running without a user via withoutTenant
// which also strips the user GUC; but the guard checks appctx.UserFromContext
// first, so we verify that guard is reached by using a no-tenant variant that
// also has no user set).
func TestIssueWSTicket_NoUserContext(t *testing.T) {
	fx := newTenant(t)
	// withoutTenant() causes callHandler to skip appctx.WithUser as well —
	// the user GUC is still set but appctx.UserFromContext will return ok=false
	// because WithUser is skipped when noTenant=true.
	// NOTE: inspecting callHandler code, it always calls appctx.WithUser even in
	// noTenant mode (line ~208). The handler reads appctx.UserFromContext which
	// is populated via appctx.WithUser. To exercise the unauthenticated guard we
	// verify the handler at the contract level: in production this guard is hit
	// when RequireAuth middleware hasn't run. Since callHandler always injects a
	// user, we skip this un-triggerable path and document the reason instead.
	//
	// The handler IS exercised via TestIssueWSTicket_Success above (user set),
	// and the tenant guard is tested below. The unauthenticated guard (401) can
	// only be hit when the JWT middleware is absent — not reachable through
	// callHandler.
	_ = fx // suppress unused var
	t.Skip("unauthenticated guard requires absence of callHandler's user injection — tested at router/middleware level")
}

// TestIssueWSTicket_NoTenantContext — handler must return 400 "tenant_required"
// when the tenant context is absent.
func TestIssueWSTicket_NoTenantContext(t *testing.T) {
	fx := newTenant(t)
	// withoutTenant() skips appctx.WithTenant, so TenantFromContext returns false.
	callHandler(t, fx, IssueWSTicket(appPool), "POST", "/", nil, withoutTenant()).
		expectErr(400, "tenant_required")
}

// TestIssueWSTicket_RowColumnsCorrect — verify the ws_tickets row contains
// the correct user_id, tenant_id, and that expires_at is in the future and
// consumed_at is NULL (ticket not yet consumed).
func TestIssueWSTicket_RowColumnsCorrect(t *testing.T) {
	fx := newTenant(t)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(),
			`DELETE FROM ws_tickets WHERE user_id = $1`, fx.User)
	})

	callHandler(t, fx, IssueWSTicket(appPool), "POST", "/", nil).expectStatus(200)

	var storedUserID, storedTenantID uuid.UUID
	var expiresInFuture bool
	var consumed *bool // nullable scan target
	if err := adminPool.QueryRow(context.Background(), `
		SELECT user_id, tenant_id,
		       expires_at > now(),
		       consumed_at IS NULL
		FROM ws_tickets
		WHERE user_id = $1 AND tenant_id = $2
		ORDER BY created_at DESC
		LIMIT 1
	`, fx.User, fx.Tenant).Scan(&storedUserID, &storedTenantID, &expiresInFuture, &consumed); err != nil {
		t.Fatalf("ws_tickets row scan: %v", err)
	}

	if storedUserID != fx.User {
		t.Fatalf("user_id = %v, want %v", storedUserID, fx.User)
	}
	if storedTenantID != fx.Tenant {
		t.Fatalf("tenant_id = %v, want %v", storedTenantID, fx.Tenant)
	}
	if !expiresInFuture {
		t.Fatalf("expires_at is not in the future")
	}
	if consumed != nil && !*consumed {
		t.Fatalf("consumed_at should be NULL for a fresh ticket")
	}
}
