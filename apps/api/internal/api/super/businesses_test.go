package super

// Businesses and branches (0088). The properties that matter:
//   - a new branch starts with the source branch's SETUP and none of its BOOKS,
//     at zero stock, every table free, and no printer addresses;
//   - the people who own the business can open the new branch immediately;
//   - a QA clone can never be put into a business (its numbers would land in
//     the owner's consolidated view).

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

type addBranchResp struct {
	ID         uuid.UUID        `json:"id"`
	Slug       string           `json:"slug"`
	BusinessID uuid.UUID        `json:"business_id"`
	Copied     map[string]int64 `json:"copied"`
}

// bizSeedOwner gives tenantID a system owner role held by a fresh user.
func bizSeedOwner(sf *superFixture, tenantID uuid.UUID) (uuid.UUID, string) {
	sf.t.Helper()
	userID, email := sf.seedUser("biz-owner")
	var roleID uuid.UUID
	sf.adminScan([]any{&roleID}, `
		INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'owner', 'Owner', true)
		ON CONFLICT (tenant_id, key) DO UPDATE SET name = roles.name RETURNING id`, tenantID)
	sf.adminExec(`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`, tenantID, userID)
	sf.adminExec(`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, tenantID, userID, roleID)
	return userID, email
}

func createBusiness(sf *superFixture, name string, tenantID *uuid.UUID) Business {
	sf.t.Helper()
	body := map[string]any{"name": name}
	if tenantID != nil {
		body["tenant_id"] = *tenantID
	}
	var out Business
	callSuper(sf.t, sf, CreateBusiness, http.MethodPost, "/super/businesses", body).
		expectStatus(http.StatusCreated).decode(&out)
	sf.t.Cleanup(func() { _, _ = adminPool.Exec(context.Background(), `DELETE FROM businesses WHERE id = $1`, out.ID) })
	return out
}

func addBranch(sf *superFixture, businessID uuid.UUID, body map[string]any) addBranchResp {
	sf.t.Helper()
	var out addBranchResp
	callSuper(sf.t, sf, AddBranch(sf.rbacRepo), http.MethodPost, "/super/businesses/x/branches", body,
		superParam("id", businessID.String())).
		expectStatus(http.StatusCreated).decode(&out)
	sf.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `SELECT purge_tenant_data($1, ARRAY['everything'])`, out.ID)
	})
	return out
}

func (sf *superFixture) count(sql string, args ...any) int {
	sf.t.Helper()
	var n int
	sf.adminScan([]any{&n}, sql, args...)
	return n
}

func TestCreateBusiness_AttachesTheFirstBranch(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Sahan")
	biz := createBusiness(sf, "Sahan Group", &srcID)
	if len(biz.Branches) != 1 || biz.Branches[0].TenantID != srcID {
		t.Fatalf("branches = %+v, want just the source café", biz.Branches)
	}
	if biz.Branches[0].BillingState == "" {
		t.Fatal("branch billing state missing from the business panel")
	}
	if sf.countPlatformAudit("business.create", &srcID) != 1 {
		t.Fatal("creating a business must leave a platform audit row")
	}
}

func TestAddBranch_CopiesSetupNotBooks(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Sahan Sorakhutte")
	ownerID, ownerEmail := bizSeedOwner(sf, srcID)

	// Setup worth copying, carrying LIVE state the copy must not inherit.
	accSeedClosedOrder(sf, srcID, 5000) // a menu item + a closed, paid order
	sf.adminExec(`INSERT INTO outlets (tenant_id, name, is_default, printer_ip) VALUES ($1, 'Kitchen', true, '10.0.0.9')`, srcID)
	sf.adminExec(`INSERT INTO service_tables (tenant_id, name, status) VALUES ($1, 'T1', 'occupied')`, srcID)
	sf.adminExec(`INSERT INTO inventory_items (tenant_id, name, qty_on_hand_units, last_purchase_unit_cost_cents)
	              VALUES ($1, 'Milk', 40, 120)`, srcID)
	sf.adminExec(`UPDATE tenants SET vat_mode = 'inclusive', vat_pct = 13, service_charge_pct = 10,
	              preferences = '{"autoCleanTables": true, "kitchenPrinters": [{"ip":"10.0.0.9"}]}'::jsonb
	              WHERE id = $1`, srcID)

	biz := createBusiness(sf, "Sahan Group", &srcID)
	got := addBranch(sf, biz.ID, map[string]any{
		"name": "Sahan Thamel", "phone": "9800000000", "seed_from_tenant_id": srcID,
	})

	// Belongs to the business.
	var bizID uuid.UUID
	sf.adminScan([]any{&bizID}, `SELECT business_id FROM tenants WHERE id = $1`, got.ID)
	if bizID != biz.ID {
		t.Fatalf("new branch business_id = %s, want %s", bizID, biz.ID)
	}

	// Setup copied.
	if n := sf.count(`SELECT count(*) FROM menu_items WHERE tenant_id = $1`, got.ID); n != 1 {
		t.Fatalf("menu items copied = %d, want 1", n)
	}
	if n := sf.count(`SELECT count(*) FROM outlets WHERE tenant_id = $1 AND is_default`, got.ID); n != 1 {
		t.Fatalf("default stations = %d, want exactly 1 (seeded one replaced, not duplicated)", n)
	}

	// Books NOT copied.
	for _, tbl := range []string{"orders", "payments", "shifts"} {
		if n := sf.count(`SELECT count(*) FROM `+tbl+` WHERE tenant_id = $1`, got.ID); n != 0 {
			t.Fatalf("%s copied into the new branch: %d rows", tbl, n)
		}
	}

	// Live state reset.
	var qty int64
	var cost *int64
	sf.adminScan([]any{&qty, &cost}, `SELECT qty_on_hand_units, last_purchase_unit_cost_cents FROM inventory_items WHERE tenant_id = $1`, got.ID)
	if qty != 0 || cost != nil {
		t.Fatalf("inventory carried over: qty=%d cost=%v, want 0 / NULL", qty, cost)
	}
	var tableStatus string
	sf.adminScan([]any{&tableStatus}, `SELECT status::text FROM service_tables WHERE tenant_id = $1`, got.ID)
	if tableStatus != "free" {
		t.Fatalf("table status = %q, want free", tableStatus)
	}
	if n := sf.count(`SELECT count(*) FROM outlets WHERE tenant_id = $1 AND printer_ip IS NOT NULL`, got.ID); n != 0 {
		t.Fatal("a printer address was copied to another building")
	}

	// Settings copied, printer addresses dropped.
	var vatMode string
	var hasAutoClean, hasPrinters bool
	sf.adminScan([]any{&vatMode, &hasAutoClean, &hasPrinters}, `
		SELECT vat_mode::text, preferences ? 'autoCleanTables', preferences ? 'kitchenPrinters'
		FROM tenants WHERE id = $1`, got.ID)
	if vatMode != "inclusive" || !hasAutoClean || hasPrinters {
		t.Fatalf("settings: vat_mode=%s autoClean=%v printers=%v; want inclusive/true/false", vatMode, hasAutoClean, hasPrinters)
	}

	// The business owner can walk straight in, and their invite isn't pending.
	if n := sf.count(`
		SELECT count(*) FROM tenant_members tm
		JOIN tenant_member_roles tmr ON tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id
		JOIN roles r ON r.id = tmr.role_id AND r.key = 'owner'
		WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.status = 'active'`, got.ID, ownerID); n != 1 {
		t.Fatal("business owner is not an active owner of the new branch")
	}
	if n := sf.count(`SELECT count(*) FROM tenant_invites WHERE tenant_id = $1 AND lower(email::text) = lower($2)
	                  AND accepted_at IS NULL AND revoked_at IS NULL`, got.ID, ownerEmail); n != 0 {
		t.Fatal("the owner's invite is still pending though they are already a member")
	}

	// The new branch is a real café, not a QA clone.
	if n := sf.count(`SELECT count(*) FROM tenants WHERE id = $1 AND cloned_from_tenant_id IS NOT NULL`, got.ID); n != 0 {
		t.Fatal("a branch must not be stamped as a QA clone")
	}
}

func TestAddBranch_SeedMustBeInTheBusiness(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Mine")
	otherID, _ := sf.seedTenant("Not mine")
	bizSeedOwner(sf, srcID)
	biz := createBusiness(sf, "Mine Group", &srcID)
	callSuper(t, sf, AddBranch(sf.rbacRepo), http.MethodPost, "/super/businesses/x/branches",
		map[string]any{"name": "Leak", "phone": "9800000000", "seed_from_tenant_id": otherID},
		superParam("id", biz.ID.String())).
		expectErr(http.StatusBadRequest, "bad_seed")
}

func TestAddBranch_WithoutSeedStartsEmpty(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Plain")
	bizSeedOwner(sf, srcID)
	accSeedClosedOrder(sf, srcID, 1000)
	biz := createBusiness(sf, "Plain Group", &srcID)
	got := addBranch(sf, biz.ID, map[string]any{"name": "Plain Two", "phone": "9800000000"})
	if n := sf.count(`SELECT count(*) FROM menu_items WHERE tenant_id = $1`, got.ID); n != 0 {
		t.Fatalf("unseeded branch has %d menu items", n)
	}
	if n := sf.count(`SELECT count(*) FROM outlets WHERE tenant_id = $1 AND is_default`, got.ID); n != 1 {
		t.Fatal("an unseeded branch still gets its default station")
	}
}

func TestSetTenantBusiness_RefusesQAClones(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Real")
	cloneID, _ := sf.seedTenant("Clone")
	sf.adminExec(`UPDATE tenants SET cloned_from_tenant_id = $2 WHERE id = $1`, cloneID, srcID)
	biz := createBusiness(sf, "Real Group", &srcID)
	callSuper(t, sf, SetTenantBusiness, http.MethodPatch, "/super/tenants/x/business",
		map[string]any{"business_id": biz.ID}, superParam("id", cloneID.String())).
		expectErr(http.StatusConflict, "tenant_is_clone")
}

func TestSetTenantBusiness_DetachKeepsData(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Detach")
	accSeedClosedOrder(sf, srcID, 1000)
	createBusiness(sf, "Detach Group", &srcID)
	callSuper(t, sf, SetTenantBusiness, http.MethodPatch, "/super/tenants/x/business",
		map[string]any{"business_id": nil}, superParam("id", srcID.String())).
		expectStatus(http.StatusOK)
	if n := sf.count(`SELECT count(*) FROM tenants WHERE id = $1 AND business_id IS NULL`, srcID); n != 1 {
		t.Fatal("tenant still attached after detach")
	}
	if n := sf.count(`SELECT count(*) FROM orders WHERE tenant_id = $1`, srcID); n != 1 {
		t.Fatal("detaching touched the café's data")
	}
}

// The catalog clone and the owner lookup are platform-admin only even though
// they are granted to the app role: a café-side caller gets nothing.
func TestBusinessFunctions_RefuseNonAdmins(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("Guarded")
	dstID, _ := sf.seedTenant("Guarded Two")
	userID, _ := sf.seedUser("not-admin")
	ctx := context.Background()
	tx, err := appPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, userID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SAVEPOINT a`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT clone_tenant_catalog($1, $2)`, srcID, dstID); err == nil {
		t.Fatal("a non-admin ran clone_tenant_catalog")
	}
	if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT a`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT * FROM business_owner_ids(gen_random_uuid())`); err == nil {
		t.Fatal("a non-admin ran business_owner_ids")
	}
}

// A new branch of a paying business inherits the source's plan and phone
// rather than silently starting a trial clock.
func TestAddBranch_DefaultsPlanAndPhoneFromSource(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenantWithPlan("Paying", "enterprise")
	sf.adminExec(`UPDATE tenants SET contact_phone = '9811111111' WHERE id = $1`, srcID)
	bizSeedOwner(sf, srcID)
	biz := createBusiness(sf, "Paying Group", &srcID)
	got := addBranch(sf, biz.ID, map[string]any{"name": "Paying Two", "seed_from_tenant_id": srcID})

	var plan, phone string
	sf.adminScan([]any{&plan, &phone}, `
		SELECT p.key, t.contact_phone FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, got.ID)
	if plan != "enterprise" || phone != "9811111111" {
		t.Fatalf("plan=%s phone=%s; want enterprise / 9811111111", plan, phone)
	}
}

func TestAddBranch_PhoneRequiredWhenSourceHasNone(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := sf.seedTenant("No Phone")
	bizSeedOwner(sf, srcID)
	biz := createBusiness(sf, "No Phone Group", &srcID)
	callSuper(t, sf, AddBranch(sf.rbacRepo), http.MethodPost, "/super/businesses/x/branches",
		map[string]any{"name": "No Phone Two", "seed_from_tenant_id": srcID},
		superParam("id", biz.ID.String())).
		expectErr(http.StatusBadRequest, "phone_required")
}
