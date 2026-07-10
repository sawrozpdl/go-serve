package super

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// ListTenants
// =========================================================================

func TestListTenants_Empty(t *testing.T) {
	sf := newSuperFixture(t)
	resp := callSuper(t, sf, ListTenants, http.MethodGet, "/v1/super/tenants", nil)
	resp.expectStatus(http.StatusOK)
	body := resp.json()
	if _, ok := body["tenants"]; !ok {
		t.Fatal("expected 'tenants' key in response")
	}
	if _, ok := body["summary"]; !ok {
		t.Fatal("expected 'summary' key in response")
	}
}

func TestListTenants_IncludesSeedTenant(t *testing.T) {
	sf := newSuperFixture(t)
	_, slug := sf.seedTenant("List Tenant Test")

	resp := callSuper(t, sf, ListTenants, http.MethodGet, "/v1/super/tenants", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	tenants, _ := body["tenants"].([]any)
	found := false
	for _, item := range tenants {
		if m, ok := item.(map[string]any); ok {
			if m["slug"] == slug {
				found = true
				// Verify required fields are present.
				if m["status"] == nil {
					t.Error("tenant summary missing 'status'")
				}
				if m["billing_state"] == nil {
					t.Error("tenant summary missing 'billing_state'")
				}
				if m["plan_key"] == nil {
					t.Error("tenant summary missing 'plan_key'")
				}
			}
		}
	}
	if !found {
		t.Fatalf("seeded tenant slug %q not found in ListTenants response", slug)
	}
}

func TestListTenants_SummaryCounters(t *testing.T) {
	sf := newSuperFixture(t)
	// Seed one active tenant.
	sf.seedTenant("Counter Test Cafe")

	resp := callSuper(t, sf, ListTenants, http.MethodGet, "/v1/super/tenants", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	summary, ok := body["summary"].(map[string]any)
	if !ok {
		t.Fatal("summary missing or wrong type")
	}
	total, _ := summary["total"].(float64)
	if total < 1 {
		t.Errorf("summary.total = %v, want >= 1", total)
	}
}

// =========================================================================
// GetTenantDetail
// =========================================================================

func TestGetTenantDetail_Success(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, slug := sf.seedTenant("Detail Test Cafe")

	resp := callSuper(t, sf, GetTenantDetail, http.MethodGet, "/v1/super/tenants/"+tenantID.String(), nil,
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	if body["slug"] != slug {
		t.Errorf("detail slug = %q, want %q", body["slug"], slug)
	}
	if _, ok := body["feature_overrides"]; !ok {
		t.Error("detail missing 'feature_overrides'")
	}
	if _, ok := body["billing_note"]; !ok {
		t.Error("detail missing 'billing_note'")
	}
	if _, ok := body["timezone"]; !ok {
		t.Error("detail missing 'timezone'")
	}
}

func TestGetTenantDetail_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, GetTenantDetail, http.MethodGet, "/v1/super/tenants/not-a-uuid", nil,
		superParam("id", "not-a-uuid")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestGetTenantDetail_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, GetTenantDetail, http.MethodGet, "/v1/super/tenants/"+id.String(), nil,
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// =========================================================================
// ChangePlan
// =========================================================================

func TestChangePlan_Success(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("ChangePlan Test")

	resp := callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		map[string]any{"plan_key": "standard"},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	// Verify DB side-effect: plan_id points to "standard".
	var planKey string
	sf.adminScan([]any{&planKey},
		`SELECT p.key FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
		tenantID)
	if planKey != "standard" {
		t.Errorf("plan_key = %q, want 'standard'", planKey)
	}
	// Audit row written.
	if n := sf.countPlatformAudit("tenant.change_plan", &tenantID); n == 0 {
		t.Error("expected platform_audit row for tenant.change_plan")
	}
}

func TestChangePlan_TrialResetsTrial(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Trial Test")

	resp := callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		map[string]any{"plan_key": "trial"},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt},
		`SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt == nil {
		t.Fatal("trial_ends_at should be set when plan_key=trial")
	}
	// The trial plan's default window is 30 days (migration 0046).
	if time.Until(*trialEndsAt) < 28*24*time.Hour {
		t.Errorf("trial_ends_at too soon: %v", trialEndsAt)
	}
}

func TestChangePlan_NonTrialClearsTrial(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Clear Trial Test")
	// Pre-set a trial_ends_at.
	sf.adminExec(`UPDATE tenants SET trial_ends_at = now() + interval '30 days' WHERE id = $1`, tenantID)

	resp := callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		map[string]any{"plan_key": "growth"},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt},
		`SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt != nil {
		t.Error("trial_ends_at should be NULL after switching to non-trial plan")
	}
}

func TestChangePlan_UnknownPlan(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad Plan Test")
	callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		map[string]any{"plan_key": "does-not-exist"},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_plan")
}

func TestChangePlan_MissingPlanKey(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Missing Plan Key Test")
	callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		map[string]any{},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestChangePlan_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/bad-id/plan",
		map[string]any{"plan_key": "standard"},
		superParam("id", "bad-id")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestChangePlan_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad JSON Test")
	callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		"{not-json}",
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// SetMemberLimitOverride
// =========================================================================

func TestSetMemberLimitOverride_Set(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("MemberLimit Test")
	limit := 5

	resp := callSuper(t, sf, SetMemberLimitOverride, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/member-limit",
		map[string]any{"member_limit": limit},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var got *int
	sf.adminScan([]any{&got}, `SELECT member_limit_override FROM tenants WHERE id = $1`, tenantID)
	if got == nil || *got != limit {
		t.Errorf("member_limit_override = %v, want %d", got, limit)
	}
	if n := sf.countPlatformAudit("tenant.set_seat_override", &tenantID); n == 0 {
		t.Error("expected platform_audit row for tenant.set_seat_override")
	}
}

func TestSetMemberLimitOverride_ClearsToNull(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("MemberLimit Null Test")
	sf.adminExec(`UPDATE tenants SET member_limit_override = 10 WHERE id = $1`, tenantID)

	resp := callSuper(t, sf, SetMemberLimitOverride, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/member-limit",
		map[string]any{"member_limit": nil},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var got *int
	sf.adminScan([]any{&got}, `SELECT member_limit_override FROM tenants WHERE id = $1`, tenantID)
	if got != nil {
		t.Errorf("member_limit_override = %v, want nil", *got)
	}
}

func TestSetMemberLimitOverride_ZeroRejected(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("MemberLimit Zero Test")
	callSuper(t, sf, SetMemberLimitOverride, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/member-limit",
		map[string]any{"member_limit": 0},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestSetMemberLimitOverride_NegativeRejected(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("MemberLimit Neg Test")
	callSuper(t, sf, SetMemberLimitOverride, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/member-limit",
		map[string]any{"member_limit": -1},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestSetMemberLimitOverride_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, SetMemberLimitOverride, http.MethodPatch,
		"/v1/super/tenants/bad/member-limit",
		map[string]any{"member_limit": 5},
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestSetMemberLimitOverride_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad JSON Limit Test")
	callSuper(t, sf, SetMemberLimitOverride, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/member-limit",
		"not-json",
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// ExtendTrial
// =========================================================================

func TestExtendTrial_Success(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("ExtendTrial Test")

	resp := callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/extend-trial",
		map[string]any{"days": 30},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt}, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt == nil {
		t.Fatal("trial_ends_at should be set after ExtendTrial")
	}
	if time.Until(*trialEndsAt) < 25*24*time.Hour {
		t.Errorf("trial_ends_at too soon after extend: %v", trialEndsAt)
	}
	if n := sf.countPlatformAudit("tenant.extend_trial", &tenantID); n == 0 {
		t.Error("expected platform_audit row for tenant.extend_trial")
	}
}

func TestExtendTrial_ExtendsFromExistingEnd(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("ExtendFrom Test")
	future := time.Now().Add(60 * 24 * time.Hour)
	sf.adminExec(`UPDATE tenants SET trial_ends_at = $2 WHERE id = $1`, tenantID, future)

	callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/extend-trial",
		map[string]any{"days": 30},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)

	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt}, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt == nil || trialEndsAt.Before(future.Add(25*24*time.Hour)) {
		t.Errorf("expected trial_ends_at to be ~90 days from now, got %v", trialEndsAt)
	}
}

func TestExtendTrial_ZeroDaysRejected(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("ZeroDays Test")
	callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/extend-trial",
		map[string]any{"days": 0},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestExtendTrial_NegativeDaysRejected(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("NegDays Test")
	callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/extend-trial",
		map[string]any{"days": -10},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestExtendTrial_TooManyDaysRejected(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("TooManyDays Test")
	callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/extend-trial",
		map[string]any{"days": 3651},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestExtendTrial_MaxDaysAllowed(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("MaxDays Test")
	callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/extend-trial",
		map[string]any{"days": 3650},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)
}

func TestExtendTrial_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, ExtendTrial, http.MethodPost,
		"/v1/super/tenants/bad/extend-trial",
		map[string]any{"days": 30},
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// ToggleWriteLock
// =========================================================================

func TestToggleWriteLock_Lock(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("WriteLock Test")

	resp := callSuper(t, sf, ToggleWriteLock, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/write-lock",
		map[string]any{"locked": true, "note": "non-payment"},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var billingState, billingNote string
	sf.adminScan([]any{&billingState, &billingNote},
		`SELECT billing_state, billing_note FROM tenants WHERE id = $1`, tenantID)
	if billingState != "write_locked" {
		t.Errorf("billing_state = %q, want 'write_locked'", billingState)
	}
	if billingNote != "non-payment" {
		t.Errorf("billing_note = %q, want 'non-payment'", billingNote)
	}
	if n := sf.countPlatformAudit("tenant.write_lock", &tenantID); n == 0 {
		t.Error("expected platform_audit row for tenant.write_lock")
	}
}

func TestToggleWriteLock_Unlock(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("WriteUnlock Test")
	sf.adminExec(`UPDATE tenants SET billing_state = 'write_locked', billing_note = 'test' WHERE id = $1`, tenantID)

	resp := callSuper(t, sf, ToggleWriteLock, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/write-lock",
		map[string]any{"locked": false},
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var billingState string
	sf.adminScan([]any{&billingState}, `SELECT billing_state FROM tenants WHERE id = $1`, tenantID)
	if billingState != "ok" {
		t.Errorf("billing_state = %q, want 'ok'", billingState)
	}
}

func TestToggleWriteLock_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, ToggleWriteLock, http.MethodPost,
		"/v1/super/tenants/bad/write-lock",
		map[string]any{"locked": true},
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestToggleWriteLock_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("BadJSON WriteLock Test")
	callSuper(t, sf, ToggleWriteLock, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/write-lock",
		"bad json",
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// SuspendTenant / ReactivateTenant
// =========================================================================

func TestSuspendTenant_Success(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Suspend Test")

	resp := callSuper(t, sf, SuspendTenant, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/suspend", nil,
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var status string
	sf.adminScan([]any{&status}, `SELECT status FROM tenants WHERE id = $1`, tenantID)
	if status != "suspended" {
		t.Errorf("status = %q, want 'suspended'", status)
	}
	if n := sf.countPlatformAudit("tenant.set_status", &tenantID); n == 0 {
		t.Error("expected platform_audit row for tenant.set_status")
	}
}

func TestSuspendTenant_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, SuspendTenant, http.MethodPost,
		"/v1/super/tenants/"+id.String()+"/suspend", nil,
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestSuspendTenant_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, SuspendTenant, http.MethodPost,
		"/v1/super/tenants/bad/suspend", nil,
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestReactivateTenant_Success(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Reactivate Test")
	sf.adminExec(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, tenantID)

	resp := callSuper(t, sf, ReactivateTenant, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/reactivate", nil,
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)

	var status string
	sf.adminScan([]any{&status}, `SELECT status FROM tenants WHERE id = $1`, tenantID)
	if status != "active" {
		t.Errorf("status = %q, want 'active'", status)
	}
}

func TestReactivateTenant_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, ReactivateTenant, http.MethodPost,
		"/v1/super/tenants/"+id.String()+"/reactivate", nil,
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestReactivateTenant_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, ReactivateTenant, http.MethodPost,
		"/v1/super/tenants/bad/reactivate", nil,
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// CreateTenant
// =========================================================================

func TestCreateTenant_Success(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	ownerEmail := "ct-owner-" + suffix + "@test.local"

	resp := callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Create Tenant Test " + suffix,
			"owner_email": ownerEmail,
			"phone":       "+9779800000000",
		})
	resp.expectStatus(http.StatusCreated)

	body := resp.json()
	idStr, _ := body["id"].(string)
	slugStr, _ := body["slug"].(string)
	if idStr == "" {
		t.Fatal("response missing 'id'")
	}
	if slugStr == "" {
		t.Fatal("response missing 'slug'")
	}

	tenantID, err := uuid.Parse(idStr)
	if err != nil {
		t.Fatalf("response id is not a valid UUID: %v", err)
	}
	// Cleanup.
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})

	// Verify tenant exists in DB.
	var dbSlug string
	sf.adminScan([]any{&dbSlug}, `SELECT slug FROM tenants WHERE id = $1`, tenantID)
	if dbSlug != slugStr {
		t.Errorf("slug in DB = %q, want %q", dbSlug, slugStr)
	}
	// Verify owner invite was created.
	var inviteCount int
	sf.adminScan([]any{&inviteCount},
		`SELECT count(*) FROM tenant_invites WHERE tenant_id = $1 AND email = $2`,
		tenantID, ownerEmail)
	if inviteCount != 1 {
		t.Errorf("owner invite count = %d, want 1", inviteCount)
	}
	// Verify system roles were seeded.
	var roleCount int
	sf.adminScan([]any{&roleCount},
		`SELECT count(*) FROM roles WHERE tenant_id = $1 AND is_system = true`, tenantID)
	if roleCount == 0 {
		t.Error("no system roles seeded for new tenant")
	}
	// Verify audit log entry was written for the tenant's own activity.
	var auditCount int
	sf.adminScan([]any{&auditCount},
		`SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action = 'create'`, tenantID)
	if auditCount == 0 {
		t.Error("expected audit_log row for tenant creation")
	}
}

func TestCreateTenant_ExplicitSlug(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	slug := "explicit-" + suffix[:6]

	resp := callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Explicit Slug Cafe",
			"slug":        slug,
			"owner_email": "owner-" + suffix + "@test.local",
			"phone":       "+9779800000000",
		})
	resp.expectStatus(http.StatusCreated)

	body := resp.json()
	if body["slug"] != slug {
		t.Errorf("response slug = %q, want %q", body["slug"], slug)
	}
	tenantID, _ := uuid.Parse(body["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
}

func TestCreateTenant_SlugDerivedFromName(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]

	resp := callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "My Great Cafe " + suffix,
			"owner_email": "owner-" + suffix + "@test.local",
			"phone":       "+9779800000000",
		})
	resp.expectStatus(http.StatusCreated)

	body := resp.json()
	slug, _ := body["slug"].(string)
	if !strings.HasPrefix(slug, "my-great-cafe") {
		t.Errorf("derived slug %q doesn't match expected pattern", slug)
	}
	tenantID, _ := uuid.Parse(body["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
}

func TestCreateTenant_SlugCollision(t *testing.T) {
	sf := newSuperFixture(t)
	_, slug := sf.seedTenant("Collision Cafe")

	// Try to create with the same slug.
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Another Cafe",
			"slug":        slug,
			"owner_email": "owner2-" + uuid.NewString()[:8] + "@test.local",
			"phone":       "+9779800000000",
		}).
		expectErr(http.StatusConflict, "slug_taken")
}

func TestCreateTenant_WithExplicitPlan(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]

	resp := callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Plan Test Cafe " + suffix,
			"owner_email": "owner-" + suffix + "@test.local",
			"plan_key":    "standard",
			"phone":       "+9779800000000",
		})
	resp.expectStatus(http.StatusCreated)

	tenantID, _ := uuid.Parse(resp.json()["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})

	var planKey string
	sf.adminScan([]any{&planKey},
		`SELECT p.key FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
		tenantID)
	if planKey != "standard" {
		t.Errorf("plan_key = %q, want 'standard'", planKey)
	}
	// Non-trial plan should not set trial_ends_at.
	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt}, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt != nil {
		t.Error("trial_ends_at should be NULL for standard plan")
	}
}

func TestCreateTenant_DefaultPlanIsTrial(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]

	resp := callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Default Plan Cafe " + suffix,
			"owner_email": "owner-" + suffix + "@test.local",
			"phone":       "+9779800000000",
		})
	resp.expectStatus(http.StatusCreated)

	tenantID, _ := uuid.Parse(resp.json()["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})

	var planKey string
	sf.adminScan([]any{&planKey},
		`SELECT p.key FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
		tenantID)
	if planKey != "trial" {
		t.Errorf("default plan = %q, want 'trial'", planKey)
	}
	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt}, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt == nil {
		t.Error("trial_ends_at should be set for default trial plan")
	}
}

func TestCreateTenant_MissingName(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"owner_email": "owner@test.local",
		}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreateTenant_MissingOwnerEmail(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name": "No Owner Cafe",
		}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreateTenant_MissingPhone(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "No Phone Cafe",
			"owner_email": "owner-" + uuid.NewString()[:8] + "@test.local",
		}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreateTenant_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants", "{bad").
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreateTenant_UnknownPlanKey(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Unknown Plan Cafe",
			"owner_email": "owner-" + suffix + "@test.local",
			"plan_key":    "no-such-plan",
			"phone":       "+9779800000000",
		}).
		expectStatus(http.StatusInternalServerError) // provision returns error, not slug_taken
}

func TestCreateTenant_PlatformAuditRow(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]

	before := time.Now()
	resp := callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost,
		"/v1/super/tenants",
		map[string]any{
			"name":        "Audit Create Cafe " + suffix,
			"owner_email": "owner-" + suffix + "@test.local",
			"phone":       "+9779800000000",
		})
	resp.expectStatus(http.StatusCreated)

	tenantID, _ := uuid.Parse(resp.json()["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})

	var count int
	sf.adminScan([]any{&count},
		`SELECT count(*) FROM platform_audit WHERE action = 'tenant.create' AND target_tenant_id = $1 AND created_at >= $2`,
		tenantID, before)
	if count == 0 {
		t.Error("expected platform_audit row for tenant.create")
	}
}

// =========================================================================
// ListFeatureRegistry
// =========================================================================

func TestListFeatureRegistry(t *testing.T) {
	sf := newSuperFixture(t)
	resp := callSuper(t, sf, ListFeatureRegistry, http.MethodGet, "/v1/super/features", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	features, ok := body["features"].([]any)
	if !ok {
		t.Fatal("expected 'features' array")
	}
	if len(features) == 0 {
		t.Fatal("features registry is empty")
	}
	// Each entry must have "key" and "label".
	for i, f := range features {
		m, ok := f.(map[string]any)
		if !ok {
			t.Fatalf("features[%d] is not an object", i)
		}
		if m["key"] == "" || m["key"] == nil {
			t.Errorf("features[%d] missing 'key'", i)
		}
		if m["label"] == "" || m["label"] == nil {
			t.Errorf("features[%d] missing 'label'", i)
		}
	}
}

// =========================================================================
// ListPlans
// =========================================================================

func TestListPlans(t *testing.T) {
	sf := newSuperFixture(t)
	resp := callSuper(t, sf, ListPlans, http.MethodGet, "/v1/super/plans", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	plans, ok := body["plans"].([]any)
	if !ok {
		t.Fatal("expected 'plans' array")
	}
	// The fixture DB has at least the 4 seed plans.
	if len(plans) < 1 {
		t.Fatal("plans list is empty")
	}
	// Verify schema: each plan must have id, key, name, features.
	for i, p := range plans {
		m, ok := p.(map[string]any)
		if !ok {
			t.Fatalf("plans[%d] is not an object", i)
		}
		for _, field := range []string{"id", "key", "name", "features"} {
			if m[field] == nil {
				t.Errorf("plans[%d] missing %q", i, field)
			}
		}
	}
}

// =========================================================================
// CreatePlan
// =========================================================================

func TestCreatePlan_Success(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	key := "tp-" + suffix[:6]

	resp := callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{
			"key":       key,
			"name":      "Test Plan",
			"sort_order": 99,
		})
	resp.expectStatus(http.StatusCreated)

	body := resp.json()
	planIDStr, _ := body["id"].(string)
	if planIDStr == "" {
		t.Fatal("response missing 'id'")
	}
	planID, _ := uuid.Parse(planIDStr)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE id = $1`, planID)
	})

	var dbKey string
	sf.adminScan([]any{&dbKey}, `SELECT key FROM plans WHERE id = $1`, planID)
	if dbKey != key {
		t.Errorf("plan key in DB = %q, want %q", dbKey, key)
	}
	if n := sf.countPlatformAudit("plan.create", nil); n == 0 {
		t.Error("expected platform_audit row for plan.create")
	}
}

func TestCreatePlan_WithFeatures(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	key := "tp-feat-" + suffix[:4]

	resp := callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{
			"key":      key,
			"name":     "Feature Plan",
			"features": []string{"advanced_analytics"},
		})
	resp.expectStatus(http.StatusCreated)

	planID, _ := uuid.Parse(resp.json()["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE id = $1`, planID)
	})

	var featureCount int
	sf.adminScan([]any{&featureCount},
		`SELECT count(*) FROM plan_features WHERE plan_id = $1`, planID)
	if featureCount != 1 {
		t.Errorf("plan_features count = %d, want 1", featureCount)
	}
}

func TestCreatePlan_DuplicateKey(t *testing.T) {
	sf := newSuperFixture(t)
	key := "trial" // already exists in the seed data
	callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{
			"key":  key,
			"name": "Dup Plan",
		}).
		expectErr(http.StatusConflict, "key_taken")
}

func TestCreatePlan_MissingKey(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{
			"name": "No Key Plan",
		}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreatePlan_MissingName(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{
			"key": "noname-" + suffix[:6],
		}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreatePlan_UnknownFeature(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{
			"key":      "feat-" + suffix[:6],
			"name":     "Bad Feature Plan",
			"features": []string{"no_such_feature"},
		}).
		expectErr(http.StatusBadRequest, "bad_feature")
}

func TestCreatePlan_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans", "{bad").
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreatePlan_ActiveDefaultsTrue(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	key := "active-" + suffix[:5]

	resp := callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{"key": key, "name": "Active Default Plan"})
	resp.expectStatus(http.StatusCreated)

	planID, _ := uuid.Parse(resp.json()["id"].(string))
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE id = $1`, planID)
	})

	var active bool
	sf.adminScan([]any{&active}, `SELECT active FROM plans WHERE id = $1`, planID)
	if !active {
		t.Error("new plan should default to active=true")
	}
}

// =========================================================================
// UpdatePlan
// =========================================================================

func TestUpdatePlan_Success(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	planID := sf.seedPlan("up-"+suffix[:6], "Update Plan")

	resp := callSuper(t, sf, UpdatePlan, http.MethodPatch,
		"/v1/super/plans/"+planID.String(),
		map[string]any{
			"name":       "Updated Name",
			"sort_order": 42,
			"features":   []string{"email_shift_summaries"},
		},
		superParam("id", planID.String()))
	resp.expectStatus(http.StatusOK)

	var dbName string
	sf.adminScan([]any{&dbName}, `SELECT name FROM plans WHERE id = $1`, planID)
	if dbName != "Updated Name" {
		t.Errorf("plan name = %q, want 'Updated Name'", dbName)
	}
	var featureCount int
	sf.adminScan([]any{&featureCount},
		`SELECT count(*) FROM plan_features WHERE plan_id = $1`, planID)
	if featureCount != 1 {
		t.Errorf("plan_features count = %d, want 1", featureCount)
	}
	if n := sf.countPlatformAudit("plan.update", nil); n == 0 {
		t.Error("expected platform_audit row for plan.update")
	}
}

func TestUpdatePlan_ReplacesFeatures(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	planID := sf.seedPlan("rf-"+suffix[:6], "Replace Features")
	// Seed 2 features.
	sf.adminExec(`INSERT INTO plan_features VALUES ($1,'advanced_analytics'),($1,'email_shift_summaries')`, planID)

	// Update with only 1 feature.
	callSuper(t, sf, UpdatePlan, http.MethodPatch,
		"/v1/super/plans/"+planID.String(),
		map[string]any{
			"name":     "Replace Features",
			"features": []string{"advanced_analytics"},
		},
		superParam("id", planID.String())).
		expectStatus(http.StatusOK)

	var count int
	sf.adminScan([]any{&count}, `SELECT count(*) FROM plan_features WHERE plan_id = $1`, planID)
	if count != 1 {
		t.Errorf("after replace: plan_features count = %d, want 1", count)
	}
}

func TestUpdatePlan_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, UpdatePlan, http.MethodPatch,
		"/v1/super/plans/"+id.String(),
		map[string]any{"name": "Ghost Plan"},
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestUpdatePlan_UnknownFeature(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	planID := sf.seedPlan("uf-"+suffix[:6], "Unknown Feature Plan")

	callSuper(t, sf, UpdatePlan, http.MethodPatch,
		"/v1/super/plans/"+planID.String(),
		map[string]any{
			"name":     "Unknown Feature Plan",
			"features": []string{"bad_feature_key"},
		},
		superParam("id", planID.String())).
		expectErr(http.StatusBadRequest, "bad_feature")
}

func TestUpdatePlan_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, UpdatePlan, http.MethodPatch,
		"/v1/super/plans/bad",
		map[string]any{"name": "x"},
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestUpdatePlan_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	planID := sf.seedPlan("bj-"+suffix[:6], "Bad JSON Plan")
	callSuper(t, sf, UpdatePlan, http.MethodPatch,
		"/v1/super/plans/"+planID.String(),
		"{bad",
		superParam("id", planID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// DeletePlan
// =========================================================================

func TestDeletePlan_Success(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	planID := sf.seedPlan("dp-"+suffix[:6], "Delete Me Plan")

	resp := callSuper(t, sf, DeletePlan, http.MethodDelete,
		"/v1/super/plans/"+planID.String(), nil,
		superParam("id", planID.String()))
	resp.expectStatus(http.StatusNoContent)

	// Verify deleted from DB.
	var count int
	sf.adminScan([]any{&count}, `SELECT count(*) FROM plans WHERE id = $1`, planID)
	if count != 0 {
		t.Error("plan was not deleted")
	}
}

func TestDeletePlan_InUseBlocked(t *testing.T) {
	sf := newSuperFixture(t)
	// "trial" plan is used by existing tenants in the seed DB — or seed one explicitly.
	suffix := uuid.NewString()[:8]
	planID := sf.seedPlan("inuse-"+suffix[:4], "In Use Plan")
	// Seed a tenant pointing to this plan.
	tenantSuffix := uuid.NewString()[:8]
	slug := "inuse-t-" + tenantSuffix[:6]
	sf.adminExec(
		`INSERT INTO tenants (slug, name, plan_id) VALUES ($1, $2, $3)`,
		slug, "In Use Tenant", planID,
	)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE slug = $1`, slug)
	})

	callSuper(t, sf, DeletePlan, http.MethodDelete,
		"/v1/super/plans/"+planID.String(), nil,
		superParam("id", planID.String())).
		expectErr(http.StatusConflict, "plan_in_use")
}

func TestDeletePlan_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, DeletePlan, http.MethodDelete,
		"/v1/super/plans/"+id.String(), nil,
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestDeletePlan_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, DeletePlan, http.MethodDelete,
		"/v1/super/plans/bad", nil,
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// ListRequests
// =========================================================================

func TestListRequests_ReturnsAll(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	sf.seedRequest("Req Cafe "+suffix, "req-"+suffix+"@test.local")

	resp := callSuper(t, sf, ListRequests, http.MethodGet, "/v1/super/requests", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	reqs, ok := body["requests"].([]any)
	if !ok {
		t.Fatal("expected 'requests' array")
	}
	if len(reqs) == 0 {
		t.Fatal("expected at least one request")
	}
}

func TestListRequests_FilterByState(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	// Seed one pending request.
	sf.seedRequest("Filter Cafe "+suffix, "filter-"+suffix+"@test.local")

	// Filter for pending: should include our row.
	resp := callSuper(t, sf, ListRequests, http.MethodGet, "/v1/super/requests", nil,
		superQuery("state=pending"))
	resp.expectStatus(http.StatusOK)
	body := resp.json()
	reqs := body["requests"].([]any)
	for _, item := range reqs {
		m := item.(map[string]any)
		if m["state"] != "pending" {
			t.Errorf("ListRequests?state=pending returned request with state=%q", m["state"])
		}
	}

	// Filter for approved: should not include our row.
	resp2 := callSuper(t, sf, ListRequests, http.MethodGet, "/v1/super/requests", nil,
		superQuery("state=approved"))
	resp2.expectStatus(http.StatusOK)
	body2 := resp2.json()
	for _, item := range body2["requests"].([]any) {
		m := item.(map[string]any)
		if m["state"] != "approved" {
			t.Errorf("ListRequests?state=approved returned request with state=%q", m["state"])
		}
	}
}

// =========================================================================
// ApproveRequest
// =========================================================================

func TestApproveRequest_Success(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	cafeName := "Approve Cafe " + suffix
	email := "approve-" + suffix + "@test.local"
	reqID := sf.seedRequest(cafeName, email)

	resp := callSuper(t, sf, ApproveRequest(sf.rbacRepo), http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/approve",
		map[string]any{},
		superParam("id", reqID.String()))
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	tenantIDStr, _ := body["tenant_id"].(string)
	if tenantIDStr == "" {
		t.Fatal("response missing 'tenant_id'")
	}
	tenantID, _ := uuid.Parse(tenantIDStr)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})

	// Request state updated.
	var state string
	var provisionedID *uuid.UUID
	sf.adminScan([]any{&state, &provisionedID},
		`SELECT state, provisioned_tenant_id FROM tenant_requests WHERE id = $1`, reqID)
	if state != "approved" {
		t.Errorf("request state = %q, want 'approved'", state)
	}
	if provisionedID == nil || *provisionedID != tenantID {
		t.Errorf("provisioned_tenant_id = %v, want %v", provisionedID, tenantID)
	}
	// Audit row.
	if n := sf.countPlatformAudit("request.approve", &tenantID); n == 0 {
		t.Error("expected platform_audit row for request.approve")
	}
}

func TestApproveRequest_AlreadyApproved(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	reqID := sf.seedRequest("Already Approved Cafe "+suffix, "already-"+suffix+"@test.local")
	// Mark as already approved.
	sf.adminExec(`UPDATE tenant_requests SET state = 'approved' WHERE id = $1`, reqID)

	callSuper(t, sf, ApproveRequest(sf.rbacRepo), http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/approve",
		map[string]any{},
		superParam("id", reqID.String())).
		expectErr(http.StatusConflict, "already_reviewed")
}

func TestApproveRequest_AlreadyRejected(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	reqID := sf.seedRequest("Already Rejected Cafe "+suffix, "rejd-"+suffix+"@test.local")
	sf.adminExec(`UPDATE tenant_requests SET state = 'rejected' WHERE id = $1`, reqID)

	callSuper(t, sf, ApproveRequest(sf.rbacRepo), http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/approve",
		map[string]any{},
		superParam("id", reqID.String())).
		expectErr(http.StatusConflict, "already_reviewed")
}

func TestApproveRequest_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, ApproveRequest(sf.rbacRepo), http.MethodPost,
		"/v1/super/requests/"+id.String()+"/approve",
		map[string]any{},
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestApproveRequest_SlugTakenConflict(t *testing.T) {
	sf := newSuperFixture(t)
	// Seed a tenant with a known slug.
	_, existingSlug := sf.seedTenant("SlugConflict Tenant")
	suffix := uuid.NewString()[:8]
	// Seed request for same-named cafe (slugify would collide).
	reqID := sf.seedRequest(existingSlug, "slugconflict-"+suffix+"@test.local") // cafe_name == slug

	// The derived slug from existingSlug IS existingSlug (it's already slug-like).
	callSuper(t, sf, ApproveRequest(sf.rbacRepo), http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/approve",
		map[string]any{"slug": existingSlug},
		superParam("id", reqID.String())).
		expectErr(http.StatusConflict, "slug_taken")
}

func TestApproveRequest_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, ApproveRequest(sf.rbacRepo), http.MethodPost,
		"/v1/super/requests/bad/approve",
		map[string]any{},
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// RejectRequest
// =========================================================================

func TestRejectRequest_Success(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	reqID := sf.seedRequest("Reject Cafe "+suffix, "reject-"+suffix+"@test.local")

	resp := callSuper(t, sf, RejectRequest, http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/reject",
		map[string]any{"note": "spam"},
		superParam("id", reqID.String()))
	resp.expectStatus(http.StatusOK)

	var state, reviewNote string
	sf.adminScan([]any{&state, &reviewNote},
		`SELECT state, review_note FROM tenant_requests WHERE id = $1`, reqID)
	if state != "rejected" {
		t.Errorf("state = %q, want 'rejected'", state)
	}
	if reviewNote != "spam" {
		t.Errorf("review_note = %q, want 'spam'", reviewNote)
	}
	if n := sf.countPlatformAudit("request.reject", nil); n == 0 {
		t.Error("expected platform_audit row for request.reject")
	}
}

func TestRejectRequest_NoNote(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	reqID := sf.seedRequest("Reject NoNote "+suffix, "rej2-"+suffix+"@test.local")

	callSuper(t, sf, RejectRequest, http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/reject",
		nil,
		superParam("id", reqID.String())).
		expectStatus(http.StatusOK)
}

func TestRejectRequest_AlreadyApproved(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:8]
	reqID := sf.seedRequest("AlreadyApproved "+suffix, "reja-"+suffix+"@test.local")
	sf.adminExec(`UPDATE tenant_requests SET state = 'approved' WHERE id = $1`, reqID)

	callSuper(t, sf, RejectRequest, http.MethodPost,
		"/v1/super/requests/"+reqID.String()+"/reject",
		nil,
		superParam("id", reqID.String())).
		expectErr(http.StatusNotFound, "not_found") // WHERE state='pending' matches 0 rows
}

func TestRejectRequest_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, RejectRequest, http.MethodPost,
		"/v1/super/requests/"+id.String()+"/reject",
		nil,
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestRejectRequest_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, RejectRequest, http.MethodPost,
		"/v1/super/requests/bad/reject",
		nil,
		superParam("id", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// ListPlatformAdmins
// =========================================================================

func TestListPlatformAdmins_ReturnsSelf(t *testing.T) {
	sf := newSuperFixture(t)
	resp := callSuper(t, sf, ListPlatformAdmins, http.MethodGet, "/v1/super/admins", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	admins, ok := body["admins"].([]any)
	if !ok {
		t.Fatal("expected 'admins' array")
	}
	found := false
	for _, item := range admins {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if m["email"] == sf.AdminEmail {
			found = true
			// Verify required fields.
			for _, field := range []string{"user_id", "email", "name", "source", "created_at"} {
				if m[field] == nil {
					t.Errorf("admin entry missing %q", field)
				}
			}
		}
	}
	if !found {
		t.Errorf("admin email %q not found in ListPlatformAdmins response", sf.AdminEmail)
	}
}

func TestListPlatformAdmins_MultipleAdmins(t *testing.T) {
	sf := newSuperFixture(t)
	_, email2 := sf.seedPlatformAdmin("second-admin")

	resp := callSuper(t, sf, ListPlatformAdmins, http.MethodGet, "/v1/super/admins", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	admins := body["admins"].([]any)
	found := false
	for _, item := range admins {
		m := item.(map[string]any)
		if m["email"] == email2 {
			found = true
		}
	}
	if !found {
		t.Errorf("second admin %q not found in listing", email2)
	}
}

// =========================================================================
// AddPlatformAdmin
// =========================================================================

func TestAddPlatformAdmin_Success(t *testing.T) {
	sf := newSuperFixture(t)
	// Seed a user who has logged in (exists in users table but NOT in platform_admins).
	_, email := sf.seedUser("new-admin")

	resp := callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins",
		map[string]any{"email": email})
	resp.expectStatus(http.StatusCreated)

	body := resp.json()
	if body["email"] != email {
		t.Errorf("response email = %q, want %q", body["email"], email)
	}
	if body["user_id"] == nil {
		t.Error("response missing 'user_id'")
	}

	// Verify in DB.
	newUserID, _ := uuid.Parse(body["user_id"].(string))
	var count int
	sf.adminScan([]any{&count},
		`SELECT count(*) FROM platform_admins WHERE user_id = $1`, newUserID)
	if count != 1 {
		t.Errorf("platform_admins count = %d, want 1", count)
	}
	if n := sf.countPlatformAudit("admin.add", nil); n == 0 {
		t.Error("expected platform_audit row for admin.add")
	}
}

func TestAddPlatformAdmin_Idempotent(t *testing.T) {
	sf := newSuperFixture(t)
	_, email := sf.seedUser("idem-admin")

	// Add twice — ON CONFLICT DO NOTHING means no error.
	callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins",
		map[string]any{"email": email}).
		expectStatus(http.StatusCreated)
	callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins",
		map[string]any{"email": email}).
		expectStatus(http.StatusCreated)
}

func TestAddPlatformAdmin_UserNotFound(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins",
		map[string]any{"email": "ghost-" + uuid.NewString()[:8] + "@test.local"}).
		expectErr(http.StatusNotFound, "user_not_found")
}

func TestAddPlatformAdmin_EmptyEmail(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins",
		map[string]any{"email": ""}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestAddPlatformAdmin_InvalidEmail(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins",
		map[string]any{"email": "notanemail"}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestAddPlatformAdmin_BadJSON(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, AddPlatformAdmin, http.MethodPost, "/v1/super/admins", "{bad").
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// RemovePlatformAdmin
// =========================================================================

func TestRemovePlatformAdmin_Success(t *testing.T) {
	sf := newSuperFixture(t)
	// Seed a second admin so there are 2 total.
	secondID, _ := sf.seedPlatformAdmin("to-remove")

	resp := callSuper(t, sf, RemovePlatformAdmin, http.MethodDelete,
		"/v1/super/admins/"+secondID.String(), nil,
		superParam("userId", secondID.String()))
	resp.expectStatus(http.StatusNoContent)

	var count int
	sf.adminScan([]any{&count},
		`SELECT count(*) FROM platform_admins WHERE user_id = $1`, secondID)
	if count != 0 {
		t.Error("platform_admin row was not deleted")
	}
	if n := sf.countPlatformAudit("admin.remove", nil); n == 0 {
		t.Error("expected platform_audit row for admin.remove")
	}
}

func TestRemovePlatformAdmin_SelfRemovalBlocked(t *testing.T) {
	sf := newSuperFixture(t)
	// Must have at least 2 admins to reach the self-check (otherwise
	// last_admin fires first).
	sf.seedPlatformAdmin("other-admin")

	callSuper(t, sf, RemovePlatformAdmin, http.MethodDelete,
		"/v1/super/admins/"+sf.AdminUser.String(), nil,
		superParam("userId", sf.AdminUser.String())).
		expectErr(http.StatusBadRequest, "self_removal")
}

func TestRemovePlatformAdmin_LastAdminBlocked(t *testing.T) {
	sf := newSuperFixture(t)

	// To reliably trigger last_admin, we need exactly 1 admin in the DB.
	// Temporarily remove all OTHER platform_admin rows (not the fixture admin),
	// restore them in cleanup, so the count is 1 when the handler runs.
	ctx := context.Background()
	type savedAdmin struct {
		userID  uuid.UUID
		addedBy *uuid.UUID
		source  string
	}
	rows, err := adminPool.Query(ctx,
		`DELETE FROM platform_admins WHERE user_id != $1 RETURNING user_id, added_by, source`,
		sf.AdminUser)
	if err != nil {
		t.Fatalf("purge other admins: %v", err)
	}
	var saved []savedAdmin
	for rows.Next() {
		var sa savedAdmin
		if err := rows.Scan(&sa.userID, &sa.addedBy, &sa.source); err != nil {
			rows.Close()
			t.Fatalf("scan admin: %v", err)
		}
		saved = append(saved, sa)
	}
	rows.Close()
	t.Cleanup(func() {
		for _, sa := range saved {
			_, _ = adminPool.Exec(context.Background(),
				`INSERT INTO platform_admins (user_id, added_by, source) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
				sa.userID, sa.addedBy, sa.source)
		}
	})

	// Now there is exactly 1 admin (the fixture admin). Trying to remove any
	// non-self UUID should hit the last_admin guard.
	someOtherID := uuid.New()
	callSuper(t, sf, RemovePlatformAdmin, http.MethodDelete,
		"/v1/super/admins/"+someOtherID.String(), nil,
		superParam("userId", someOtherID.String())).
		expectErr(http.StatusConflict, "last_admin")
}

func TestRemovePlatformAdmin_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	// Add a second admin so count=2, bypassing last_admin guard.
	sf.seedPlatformAdmin("filler-admin")

	nonAdmin, _ := sf.seedUser("non-admin")
	callSuper(t, sf, RemovePlatformAdmin, http.MethodDelete,
		"/v1/super/admins/"+nonAdmin.String(), nil,
		superParam("userId", nonAdmin.String())).
		expectErr(http.StatusNotFound, "not_found")
}

func TestRemovePlatformAdmin_BadUUID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, RemovePlatformAdmin, http.MethodDelete,
		"/v1/super/admins/bad", nil,
		superParam("userId", "bad")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// ListPlatformAudit
// =========================================================================

func TestListPlatformAudit_Default(t *testing.T) {
	sf := newSuperFixture(t)

	// Generate an audit entry by performing a real action.
	tenantID, _ := sf.seedTenant("Audit List Test")
	callSuper(t, sf, SuspendTenant, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/suspend", nil,
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)

	resp := callSuper(t, sf, ListPlatformAudit, http.MethodGet, "/v1/super/audit", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	events, ok := body["events"].([]any)
	if !ok {
		t.Fatal("expected 'events' array")
	}
	found := false
	for _, item := range events {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if m["action"] == "tenant.set_status" {
			tid, _ := m["tenant_id"].(string)
			if tid == tenantID.String() {
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("expected tenant.set_status audit event to appear in ListPlatformAudit")
	}
}

func TestListPlatformAudit_EventSchema(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Schema Check Tenant")
	callSuper(t, sf, SuspendTenant, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/suspend", nil,
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)

	resp := callSuper(t, sf, ListPlatformAudit, http.MethodGet, "/v1/super/audit", nil)
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	events := body["events"].([]any)
	if len(events) == 0 {
		t.Skip("no audit events to check schema on")
	}
	m := events[0].(map[string]any)
	for _, field := range []string{"actor_email", "action", "target_id", "summary", "created_at"} {
		if m[field] == nil {
			t.Errorf("audit event missing field %q", field)
		}
	}
}

func TestListPlatformAudit_LimitParam(t *testing.T) {
	sf := newSuperFixture(t)

	resp := callSuper(t, sf, ListPlatformAudit, http.MethodGet, "/v1/super/audit", nil,
		superQuery("limit=5"))
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	events, _ := body["events"].([]any)
	if len(events) > 5 {
		t.Errorf("with limit=5, got %d events", len(events))
	}
}

func TestListPlatformAudit_LimitCappedAt200(t *testing.T) {
	sf := newSuperFixture(t)
	// Just verify it doesn't error; we can't easily seed 201 rows in a test.
	resp := callSuper(t, sf, ListPlatformAudit, http.MethodGet, "/v1/super/audit", nil,
		superQuery("limit=999"))
	resp.expectStatus(http.StatusOK)
}

func TestListPlatformAudit_BeforeParam(t *testing.T) {
	sf := newSuperFixture(t)

	// Seed an action then query with a before= in the past → should return nothing recent.
	tenantID, _ := sf.seedTenant("Before Param Tenant")
	callSuper(t, sf, SuspendTenant, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/suspend", nil,
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)

	past := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano)
	resp := callSuper(t, sf, ListPlatformAudit, http.MethodGet, "/v1/super/audit", nil,
		superQuery("before="+past))
	resp.expectStatus(http.StatusOK)

	body := resp.json()
	events, _ := body["events"].([]any)
	for _, item := range events {
		m := item.(map[string]any)
		if m["action"] == "tenant.set_status" {
			tid, _ := m["tenant_id"].(string)
			if tid == tenantID.String() {
				t.Error("audit event from the future appeared with before= in the past")
			}
		}
	}
}

// =========================================================================
// slugify helper (unit — no DB required)
// =========================================================================

func TestSlugify(t *testing.T) {
	// nonSlugRe = [^a-z0-9]+ — the + means consecutive non-slug chars collapse
	// to a single dash. É is multi-byte; after toLower → "é" which is not
	// [a-z0-9], collapses with adjacent space/& into one dash.
	cases := []struct {
		in   string
		want string
	}{
		{"My Cafe", "my-cafe"},
		{"  Trim Me  ", "trim-me"},
		{"Café & Bistro!", "caf-bistro"}, // "é" + " & " all collapse to one "-"
		{"ALL CAPS", "all-caps"},
		{"Already-Slug", "already-slug"},
		{strings.Repeat("a", 70), strings.Repeat("a", 63)},
		{"---leading", "leading"},       // Trim leading dashes.
		{"trailing---", "trailing"},     // Trim trailing dashes.
	}
	for _, tc := range cases {
		got := slugify(tc.in)
		if got != tc.want {
			t.Errorf("slugify(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// =========================================================================
// provisionTenant (DB — integration)
// =========================================================================

func TestProvisionTenant_TrialWindow(t *testing.T) {
	requireDB(t)
	sf := newSuperFixture(t)

	suffix := uuid.NewString()[:8]
	email := "prov-" + suffix + "@test.local"

	ctx := context.Background()
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Set app.user_id so provision's audit_log INSERT works.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", sf.AdminUser.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	actorCtx := appctx.WithUser(ctx, appctx.User{ID: sf.AdminUser, Email: sf.AdminEmail})
	actorCtx = appctx.WithRequestID(actorCtx, "test-provision")
	actorCtx = appctx.WithIP(actorCtx, "127.0.0.1")

	tenantID, slug, err := provisionTenant(actorCtx, tx, sf.rbacRepo, sf.AdminUser, ProvisionParams{
		Name:       "Prov Trial Cafe",
		OwnerEmail: email,
	})
	if err != nil {
		t.Fatalf("provisionTenant: %v", err)
	}
	if slug == "" {
		t.Fatal("empty slug returned")
	}
	if tenantID == uuid.Nil {
		t.Fatal("nil tenantID returned")
	}

	// Check trial_ends_at.
	var trialEndsAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID).
		Scan(&trialEndsAt); err != nil {
		t.Fatalf("query trial_ends_at: %v", err)
	}
	if trialEndsAt == nil {
		t.Fatal("trial_ends_at should be set for trial plan")
	}
	// Trial plan default window is 30 days (migration 0046).
	if diff := time.Until(*trialEndsAt); diff < 29*24*time.Hour || diff > 31*24*time.Hour {
		t.Errorf("trial_ends_at not approximately 30 days out: %v", diff)
	}

	_ = tx.Rollback(ctx) // don't persist
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
}

func TestProvisionTenant_SlugTakenError(t *testing.T) {
	requireDB(t)
	sf := newSuperFixture(t)
	_, existingSlug := sf.seedTenant("Slug Taken Tenant")

	ctx := context.Background()
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", sf.AdminUser.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	actorCtx := appctx.WithUser(ctx, appctx.User{ID: sf.AdminUser, Email: sf.AdminEmail})
	actorCtx = appctx.WithRequestID(actorCtx, "test-slug-taken")
	actorCtx = appctx.WithIP(actorCtx, "127.0.0.1")

	_, _, err = provisionTenant(actorCtx, tx, sf.rbacRepo, sf.AdminUser, ProvisionParams{
		Name:       "Whatever",
		Slug:       existingSlug,
		OwnerEmail: "someone@test.local",
	})
	if err == nil {
		t.Fatal("expected errSlugTaken, got nil")
	}
	if err != errSlugTaken {
		t.Errorf("expected errSlugTaken, got %v", err)
	}
}

// =========================================================================
// Subscriptions — per-plan trial_days, manual payments, paid-through.
// =========================================================================

// seedTrialPlan inserts a plan with an explicit trial_days and cleans it up.
func (sf *superFixture) seedTrialPlan(trialDays int) (uuid.UUID, string) {
	sf.t.Helper()
	suffix := uuid.NewString()[:6]
	key := "trialp-" + suffix
	id := sf.seedPlan(key, "Trial Plan "+suffix)
	sf.adminExec(`UPDATE plans SET trial_days = $1 WHERE id = $2`, trialDays, id)
	return id, key
}

func TestCreateTenant_TrialDaysFromPlan(t *testing.T) {
	requireDB(t)
	sf := newSuperFixture(t)
	_, planKey := sf.seedTrialPlan(14)

	// Provision inside a tx we roll back: a provisioned tenant has
	// roles/invites/audit children that a raw DELETE cleanup can't remove (it
	// would leak the tenant and pin the plan). Rolling back leaves zero residue,
	// and we still assert trial_ends_at within the same tx.
	ctx := context.Background()
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", sf.AdminUser.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	actorCtx := appctx.WithUser(ctx, appctx.User{ID: sf.AdminUser, Email: sf.AdminEmail})
	actorCtx = appctx.WithRequestID(actorCtx, "test-trial-days")
	actorCtx = appctx.WithIP(actorCtx, "127.0.0.1")

	tenantID, _, err := provisionTenant(actorCtx, tx, sf.rbacRepo, sf.AdminUser, ProvisionParams{
		Name:       "Trial Days Cafe",
		OwnerEmail: "owner@test.local",
		PlanKey:    planKey,
	})
	if err != nil {
		t.Fatalf("provisionTenant: %v", err)
	}

	var trialEndsAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID).Scan(&trialEndsAt); err != nil {
		t.Fatalf("scan trial_ends_at: %v", err)
	}
	if trialEndsAt == nil {
		t.Fatal("trial_ends_at should be set from the plan's trial_days")
	}
	// ~14 days out (allow a day of slack).
	if d := time.Until(*trialEndsAt); d < 13*24*time.Hour || d > 15*24*time.Hour {
		t.Errorf("trial window = %v, want ~14 days (plan trial_days)", d)
	}
}

func TestChangePlan_TrialDaysFromPlan(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Change To Trial", "standard")
	_, planKey := sf.seedTrialPlan(30)
	// Cleanup is LIFO: seedTrialPlan's plan-delete runs before the tenant-delete,
	// and would fail (FK) because we point the tenant AT that plan below. Repoint
	// the tenant off it first (this cleanup runs before both) so the plan deletes.
	t.Cleanup(func() {
		sf.adminExec(`UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE key = 'standard') WHERE id = $1`, tenantID)
	})

	callSuper(t, sf, ChangePlan, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/plan",
		map[string]any{"plan_key": planKey},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)

	var trialEndsAt *time.Time
	sf.adminScan([]any{&trialEndsAt}, `SELECT trial_ends_at FROM tenants WHERE id = $1`, tenantID)
	if trialEndsAt == nil {
		t.Fatal("trial_ends_at should be set from the plan's trial_days")
	}
	if d := time.Until(*trialEndsAt); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Errorf("trial window = %v, want ~30 days", d)
	}
}

func TestRecordPayment_AdvancesPaidThrough(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Pay Cafe", "standard")

	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 200000, "method": "cash", "period_end": "2030-01-31", "note": "Jan"},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusCreated)

	// paid_through_at = day AFTER period_end (whole period_end day covered).
	var dateOK bool
	sf.adminScan([]any{&dateOK},
		`SELECT paid_through_at IS NOT NULL AND paid_through_at::date = '2030-02-01'::date FROM tenants WHERE id = $1`, tenantID)
	if !dateOK {
		t.Error("paid_through_at should be the day after period_end (2030-02-01)")
	}

	var n int
	sf.adminScan([]any{&n}, `SELECT count(*) FROM tenant_payments WHERE tenant_id = $1`, tenantID)
	if n != 1 {
		t.Errorf("tenant_payments rows = %d, want 1", n)
	}
	if a := sf.countPlatformAudit("tenant.record_payment", &tenantID); a == 0 {
		t.Error("expected platform_audit row for tenant.record_payment")
	}
}

func TestRecordPayment_NeverMovesBackward(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Backdate Cafe", "standard")

	// Pay through mid-year, then record an EARLIER period — paid_through must hold.
	for _, end := range []string{"2030-06-30", "2030-01-31"} {
		callSuper(t, sf, RecordPayment, http.MethodPost,
			"/v1/super/tenants/"+tenantID.String()+"/payments",
			map[string]any{"amount_cents": 100000, "method": "bank", "period_end": end},
			superParam("id", tenantID.String())).
			expectStatus(http.StatusCreated)
	}
	var dateOK bool
	sf.adminScan([]any{&dateOK},
		`SELECT paid_through_at::date = '2030-07-01'::date FROM tenants WHERE id = $1`, tenantID)
	if !dateOK {
		t.Error("a backdated payment must not pull paid_through_at backward")
	}
}

func TestRecordPayment_BadMethod(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Bad Method", "standard")
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 100, "method": "crypto", "period_end": "2030-01-01"},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestRecordPayment_BadDate(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Bad Date", "standard")
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 100, "method": "cash", "period_end": "31-01-2030"},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestListPayments_NewestFirst(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("History Cafe", "standard")
	for _, end := range []string{"2030-01-31", "2030-02-28"} {
		callSuper(t, sf, RecordPayment, http.MethodPost,
			"/v1/super/tenants/"+tenantID.String()+"/payments",
			map[string]any{"amount_cents": 100000, "method": "online", "period_end": end},
			superParam("id", tenantID.String())).
			expectStatus(http.StatusCreated)
	}
	resp := callSuper(t, sf, ListPayments, http.MethodGet,
		"/v1/super/tenants/"+tenantID.String()+"/payments", nil,
		superParam("id", tenantID.String()))
	resp.expectStatus(http.StatusOK)
	payments, ok := resp.json()["payments"].([]any)
	if !ok || len(payments) != 2 {
		t.Fatalf("expected 2 payments, got %v", resp.json()["payments"])
	}
}

func TestSetSubscription_SetAndComp(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Comp Cafe", "standard")

	// Set a paid-through date directly.
	callSuper(t, sf, SetSubscription, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/subscription",
		map[string]any{"paid_through_at": "2030-03-15"},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)
	var dateOK bool
	sf.adminScan([]any{&dateOK},
		`SELECT paid_through_at::date = '2030-03-16'::date FROM tenants WHERE id = $1`, tenantID)
	if !dateOK {
		t.Error("paid_through_at should be the day after the set date")
	}

	// Comp: null clears it (perpetual).
	callSuper(t, sf, SetSubscription, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/subscription",
		map[string]any{"paid_through_at": nil},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK)
	var paidThrough *time.Time
	sf.adminScan([]any{&paidThrough}, `SELECT paid_through_at FROM tenants WHERE id = $1`, tenantID)
	if paidThrough != nil {
		t.Error("paid_through_at should be NULL after comp")
	}
}

func TestCreatePlan_WithTrialDays(t *testing.T) {
	sf := newSuperFixture(t)
	suffix := uuid.NewString()[:6]
	key := "tdp-" + suffix
	resp := callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{"key": key, "name": "Trial Days Plan", "trial_days": 21})
	resp.expectStatus(http.StatusCreated)
	planID, _ := uuid.Parse(resp.json()["id"].(string))
	t.Cleanup(func() { _, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE id = $1`, planID) })

	var td int
	sf.adminScan([]any{&td}, `SELECT trial_days FROM plans WHERE id = $1`, planID)
	if td != 21 {
		t.Errorf("trial_days = %d, want 21", td)
	}
}

func TestUpdatePlan_TrialDays(t *testing.T) {
	sf := newSuperFixture(t)
	planID, _ := sf.seedTrialPlan(7)
	callSuper(t, sf, UpdatePlan, http.MethodPatch, "/v1/super/plans/"+planID.String(),
		map[string]any{"name": "Updated", "trial_days": 45},
		superParam("id", planID.String())).
		expectStatus(http.StatusOK)
	var td int
	sf.adminScan([]any{&td}, `SELECT trial_days FROM plans WHERE id = $1`, planID)
	if td != 45 {
		t.Errorf("trial_days = %d, want 45", td)
	}
}

func TestCreatePlan_TrialDaysTooBig(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreatePlan, http.MethodPost, "/v1/super/plans",
		map[string]any{"key": "toobig-" + uuid.NewString()[:6], "name": "Too Big", "trial_days": 99999}).
		expectErr(http.StatusBadRequest, "bad_request")
}
