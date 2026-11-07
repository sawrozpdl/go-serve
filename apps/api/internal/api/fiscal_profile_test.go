package api

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// fiscalPAN returns a random 9-digit PAN so parallel/repeated runs never trip
// the global (pan, outlet_code) unique index on each other's leftovers.
func fiscalPAN() string { return fmt.Sprintf("%09d", 100000000+rand.Intn(899999999)) }

// setupFiscalProfile writes a complete profile as the owner and makes the
// tenant's tax settings fiscal-legal for reg (vat → inclusive 13%, pan → none).
func setupFiscalProfile(t *testing.T, fx *fixture, reg string) string {
	t.Helper()
	fx.cleanupFiscal()
	pan := fiscalPAN()
	if reg == "vat" {
		fx.setTenantVat("inclusive", "13")
	} else {
		fx.setTenantVat("none", "13")
	}
	fx.adminExec(`UPDATE tenants SET service_charge_pct = 0 WHERE id = $1`, fx.Tenant)
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{
		"registration_type": reg,
		"pan":               pan,
		"legal_name":        "Test Cafe Pvt. Ltd.",
		"address":           "Thamel, Kathmandu",
	}).expectStatus(200)
	return pan
}

// cleanupFiscal registers removal of the tenant's fiscal rows. A fiscal-mode
// profile (and, later, issued invoices) refuse DELETE even from the superuser,
// which would make newTenant's cascade silently fail and leak tenants; test
// teardown is the one place allowed to switch triggers off (replica role).
// Cleanups run LIFO, so this runs before newTenant's tenant delete.
func (fx *fixture) cleanupFiscal() {
	fx.t.Cleanup(func() {
		ctx := context.Background()
		tx, err := adminPool.Begin(ctx)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `SET LOCAL session_replication_role = replica`)
		_, _ = tx.Exec(ctx, `DELETE FROM fiscal_profiles WHERE tenant_id = $1`, fx.Tenant)
		_ = tx.Commit(ctx)
	})
}

func enableFiscal(t *testing.T, fx *fixture, pan string) *apiResp {
	t.Helper()
	return callHandler(t, fx, EnableFiscalMode, "POST", "/", map[string]any{"confirm_pan": pan})
}

func TestFiscalProfile_DefaultIsNone(t *testing.T) {
	fx := newTenant(t)
	var out FiscalProfileDTO
	callHandler(t, fx, GetFiscalProfile, "GET", "/", nil).expectStatus(200).decode(&out)
	if out.RegistrationType != "none" || out.FiscalMode {
		t.Fatalf("default profile = %+v", out)
	}
	if len(out.Readiness) == 0 {
		t.Fatal("an empty profile must report readiness problems")
	}
}

func TestFiscalProfile_ValidatesPANAndOutlet(t *testing.T) {
	fx := newTenant(t)
	fx.cleanupFiscal()
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{"registration_type": "vat", "pan": "12345"}).
		expectErr(400, "invalid_pan")
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{"registration_type": "vat"}).
		expectErr(400, "pan_required")
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{"outlet_code": "TOO-LONG-CODE"}).
		expectErr(400, "invalid_outlet_code")

	// Spaces/dashes are normalised away; lower-case outlet codes upper-cased.
	var out FiscalProfileDTO
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{
		"registration_type": "pan", "pan": "6 0 1-2 3 4-5 6 7", "outlet_code": "ktm",
	}).expectStatus(200).decode(&out)
	if out.PAN != "601234567" || out.OutletCode != "KTM" {
		t.Fatalf("normalised = %q / %q", out.PAN, out.OutletCode)
	}
}

func TestFiscalProfile_EnableRequiresReadinessAndConfirmation(t *testing.T) {
	fx := newTenant(t)

	// Nothing set → not ready.
	r := enableFiscal(t, fx, "")
	r.expectErr(409, "not_ready")

	pan := setupFiscalProfile(t, fx, "vat")

	// Service charge is barred in fiscal mode.
	fx.adminExec(`UPDATE tenants SET service_charge_pct = 10 WHERE id = $1`, fx.Tenant)
	if msg := enableFiscal(t, fx, pan).expectErr(409, "not_ready").errMsg(); !strings.Contains(msg, "service charge") {
		t.Fatalf("not_ready message = %q", msg)
	}
	fx.adminExec(`UPDATE tenants SET service_charge_pct = 0 WHERE id = $1`, fx.Tenant)

	// VAT café must be VAT-inclusive.
	fx.setTenantVat("exclusive", "13")
	enableFiscal(t, fx, pan).expectErr(409, "not_ready")
	fx.setTenantVat("inclusive", "13")

	// Wrong confirmation.
	enableFiscal(t, fx, "999999999").expectErr(400, "confirm_mismatch")

	var out FiscalProfileDTO
	enableFiscal(t, fx, pan).expectStatus(200).decode(&out)
	if !out.FiscalMode || out.FiscalModeAt == nil {
		t.Fatalf("after enable = %+v", out)
	}
	enableFiscal(t, fx, pan).expectErr(409, "already_enabled")

	// The switch is on record even though the plan has no audit-log feature.
	var n int
	fx.adminScan([]any{&n}, `SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND entity = 'fiscal_profile' AND action = 'enable'`, fx.Tenant)
	if n != 1 {
		t.Fatalf("enable audit rows = %d, want 1", n)
	}
}

func TestFiscalProfile_OneWayAndFrozenIdentity(t *testing.T) {
	fx := newTenant(t)
	pan := setupFiscalProfile(t, fx, "vat")
	enableFiscal(t, fx, pan).expectStatus(200)

	// API refuses identity changes in words…
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{"pan": fiscalPAN()}).
		expectErr(409, "fiscal_identity_frozen")
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{"outlet_code": "B2"}).
		expectErr(409, "fiscal_identity_frozen")
	// …but the seller block may still change.
	callHandler(t, fx, UpdateFiscalProfile, "PATCH", "/", map[string]any{"address": "Lazimpat, Kathmandu"}).
		expectStatus(200)

	// The database refuses even the app role going around the handler.
	for _, sql := range []string{
		`UPDATE fiscal_profiles SET fiscal_mode_enabled_at = NULL WHERE tenant_id = current_tenant_id()`,
		`UPDATE fiscal_profiles SET pan = '111111111' WHERE tenant_id = current_tenant_id()`,
		`UPDATE fiscal_profiles SET registration_type = 'pan' WHERE tenant_id = current_tenant_id()`,
	} {
		if err := fx.appExecErr(sql); err == nil {
			t.Errorf("app role was allowed: %s", sql)
		}
	}
	// No DELETE grant, and the trigger refuses even the superuser.
	if err := fx.appExecErr(`DELETE FROM fiscal_profiles WHERE tenant_id = current_tenant_id()`); err == nil {
		t.Error("app role deleted a fiscal profile")
	}
	if _, err := adminPool.Exec(context.Background(), `DELETE FROM fiscal_profiles WHERE tenant_id = $1`, fx.Tenant); err == nil {
		t.Error("superuser deleted a fiscal-mode profile")
	}
}

func TestFiscalProfile_TenantTaxSettingsGuarded(t *testing.T) {
	fx := newTenant(t)
	pan := setupFiscalProfile(t, fx, "vat")
	enableFiscal(t, fx, pan).expectStatus(200)

	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{"service_charge_pct": "10"}).
		expectErr(409, "fiscal_tax_settings")
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{"vat_mode": "exclusive"}).
		expectErr(409, "fiscal_tax_settings")
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{"vat_pct": "12"}).
		expectErr(409, "fiscal_tax_settings")
	// Unrelated settings still save.
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{"name": "Renamed Cafe"}).
		expectStatus(200)
}

func TestFiscalProfile_PANOutletUniqueAcrossTenants(t *testing.T) {
	a := newTenant(t)
	b := newTenant(t)
	a.cleanupFiscal()
	b.cleanupFiscal()
	pan := fiscalPAN()
	body := map[string]any{"registration_type": "pan", "pan": pan, "legal_name": "X", "address": "Y"}
	callHandler(t, a, UpdateFiscalProfile, "PATCH", "/", body).expectStatus(200)
	// Second branch on the same PAN without its own outlet code → refused.
	callHandler(t, b, UpdateFiscalProfile, "PATCH", "/", body).expectErr(409, "pan_outlet_taken")
	body["outlet_code"] = "B2"
	callHandler(t, b, UpdateFiscalProfile, "PATCH", "/", body).expectStatus(200)
}

func TestFiscalProfile_ForcesAuditLogFeature(t *testing.T) {
	fx := newTenant(t)
	var before, after bool
	fx.adminScan([]any{&before}, `SELECT tenant_fiscal_mode($1)`, fx.Tenant)
	pan := setupFiscalProfile(t, fx, "pan")
	enableFiscal(t, fx, pan).expectStatus(200)
	fx.adminScan([]any{&after}, `SELECT tenant_fiscal_mode($1)`, fx.Tenant)
	if before || !after {
		t.Fatalf("tenant_fiscal_mode before=%v after=%v", before, after)
	}
}

// Regression (all tenants, not just fiscal): a line never sent to the kitchen
// stays "pending" after the order closes, and UpdateOrderItem used to edit it,
// silently diverging from the stamped totals.
func TestUpdateOrderItem_ClosedOrder_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	menuItem := ordSeedActiveItem(fx, "Momo", 300)
	item := fx.seedOrderItem(order, menuItem, 1, 300)
	fx.closeOrderPaidInFull(order)

	callHandler(t, fx, UpdateOrderItem, "PATCH", "/",
		map[string]any{"qty": 3},
		withParam("itemId", item.String())).
		expectErr(409, "order_not_open")

	if q := ordItemQty(fx, item); q != 1 {
		t.Fatalf("qty changed on a closed order: %d", q)
	}
}
