package api

// Integration tests for identity handlers: Me, SelectTenant, ExportMyData,
// DeleteMyAccount.
//
// Handlers live in:
//   - internal/api/me.go          (Me)
//   - internal/api/select_tenant.go (SelectTenant)
//   - internal/api/gdpr.go        (ExportMyData, DeleteMyAccount)
//
// All four handlers sit under the OptionalMiddleware group in the router,
// meaning tenant context is never required.  The realistic call path for
// SelectTenant, ExportMyData, and DeleteMyAccount uses withoutTenant().
// Me is tested both ways because the router can reach it with or without a
// resolved X-Tenant-ID header.
//
// ExportMyData and DeleteMyAccount resolve role keys cross-tenant via the
// SECURITY DEFINER functions added in migration 0030 (my_memberships,
// my_sole_owner_workspaces), which replaced stale references to the dropped
// tenant_members.role column.

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Me
// =========================================================================

// TestMe_WithTenant exercises the common SPA path: a tenant is already
// resolved so Me includes active_tenant_slug, active_roles, permissions, and
// a billing snapshot for the active workspace.
func TestMe_WithTenant(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)

	r := callHandler(t, fx, Me(rbacNewRepo()), "GET", "/v1/me", nil).
		expectStatus(200)

	var resp MeResponse
	r.decode(&resp)

	if resp.UserID != fx.User {
		t.Fatalf("user_id = %v, want %v", resp.UserID, fx.User)
	}
	if resp.Email == "" {
		t.Fatal("email should be non-empty")
	}
	if resp.Name == "" {
		t.Fatal("name should be non-empty")
	}
	if resp.ActiveTenant == nil || *resp.ActiveTenant != fx.Slug {
		t.Fatalf("active_tenant_slug = %v, want %q", resp.ActiveTenant, fx.Slug)
	}
	// Memberships list should contain at least the fixture tenant.
	found := false
	for _, m := range resp.Memberships {
		if m.TenantID == fx.Tenant {
			found = true
			if m.TenantSlug != fx.Slug {
				t.Errorf("membership tenant_slug = %q, want %q", m.TenantSlug, fx.Slug)
			}
			if m.Status != "active" {
				t.Errorf("membership status = %q, want active", m.Status)
			}
		}
	}
	if !found {
		t.Fatal("fixture tenant not in memberships list")
	}
	// With RBAC roles seeded the owner role key should appear.
	if len(resp.ActiveRoleKeys) == 0 {
		t.Fatal("active_role_keys should be non-empty after seeding system roles")
	}
	// Permissions should be non-empty for owner (owner holds *:* wildcard).
	if len(resp.ActivePermissions) == 0 {
		t.Fatal("active_permissions should be non-empty for an owner-role member")
	}
	// Billing snapshot must be present when a tenant is active.
	if resp.Billing == nil {
		t.Fatal("billing should be present when tenant is resolved")
	}
	if resp.IsPlatformAdmin {
		t.Fatal("regular user should not be a platform admin")
	}
}

// TestMe_WithoutTenant exercises the pre-tenant-pick path: no X-Tenant-ID
// header, so the SPA can enumerate the user's workspaces on first load.
// The user-scoped RLS branch on tenant_members returns all memberships.
func TestMe_WithoutTenant(t *testing.T) {
	fx := newTenant(t)

	r := callHandler(t, fx, Me(rbacNewRepo()), "GET", "/v1/me", nil,
		withoutTenant()).
		expectStatus(200)

	var resp MeResponse
	r.decode(&resp)

	if resp.UserID != fx.User {
		t.Fatalf("user_id = %v, want %v", resp.UserID, fx.User)
	}
	// Without tenant context there is no active workspace.
	if resp.ActiveTenant != nil {
		t.Fatalf("active_tenant_slug should be nil without tenant context, got %q", *resp.ActiveTenant)
	}
	// active_roles and active_permissions should be absent.
	if len(resp.ActiveRoleKeys) != 0 {
		t.Fatalf("active_role_keys should be empty without tenant context, got %v", resp.ActiveRoleKeys)
	}
	if len(resp.ActivePermissions) != 0 {
		t.Fatalf("active_permissions should be empty without tenant context, got %v", resp.ActivePermissions)
	}
	// Billing requires an active tenant.
	if resp.Billing != nil {
		t.Fatal("billing should be nil without tenant context")
	}
	// Fixture tenant membership should appear under user-scoped RLS.
	found := false
	for _, m := range resp.Memberships {
		if m.TenantID == fx.Tenant {
			found = true
		}
	}
	if !found {
		t.Fatal("fixture tenant membership not visible with user-scoped RLS")
	}
}

// TestMe_MultiTenant verifies that withoutTenant() shows ALL workspaces the
// user belongs to.  We create a second tenant and manually add the fixture
// user to it, then confirm both appear in memberships.
func TestMe_MultiTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	// Add fx1.User to fx2's tenant so they belong to two workspaces.
	fx2.adminExec(
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')
		 ON CONFLICT DO NOTHING`,
		fx2.Tenant, fx1.User,
	)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(),
			`DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
			fx2.Tenant, fx1.User)
	})

	r := callHandler(t, fx1, Me(rbacNewRepo()), "GET", "/v1/me", nil,
		withoutTenant(), actingAs(fx1.User)).
		expectStatus(200)

	var resp MeResponse
	r.decode(&resp)

	tenantIDs := make(map[uuid.UUID]bool)
	for _, m := range resp.Memberships {
		tenantIDs[m.TenantID] = true
	}
	if !tenantIDs[fx1.Tenant] {
		t.Errorf("fx1 tenant %v not in memberships", fx1.Tenant)
	}
	if !tenantIDs[fx2.Tenant] {
		t.Errorf("fx2 tenant %v not in memberships", fx2.Tenant)
	}
}

// TestMe_MembershipsEmptyList confirms the memberships field is always an
// array (never JSON null) even for a user with no memberships.  We create an
// isolated user (via a second fixture) and strip their membership before
// calling Me.
func TestMe_MembershipsEmptyList(t *testing.T) {
	fx := newTenant(t)
	// Create a standalone user with no tenant membership.
	suffix := uuid.NewString()[:8]
	var loneUserID uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"lone-"+suffix+"@test.local", "Lone "+suffix,
	).Scan(&loneUserID); err != nil {
		t.Fatalf("seed lone user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, loneUserID)
	})

	r := callHandler(t, fx, Me(rbacNewRepo()), "GET", "/v1/me", nil,
		withoutTenant(), actingAs(loneUserID)).
		expectStatus(200)

	var resp MeResponse
	r.decode(&resp)

	if resp.Memberships == nil {
		t.Fatal("memberships should be a non-nil empty array, got null")
	}
	if len(resp.Memberships) != 0 {
		t.Fatalf("memberships count = %d, want 0 for a user with no tenants", len(resp.Memberships))
	}
}

// TestMe_RoleKeysPopulated verifies that when the user has named RBAC roles
// seeded (via rbacSeedSystemRoles), those keys propagate into active_role_keys.
func TestMe_RoleKeysPopulated(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)

	r := callHandler(t, fx, Me(rbacNewRepo()), "GET", "/v1/me", nil).
		expectStatus(200)

	var resp MeResponse
	r.decode(&resp)

	found := false
	for _, k := range resp.ActiveRoleKeys {
		if k == "owner" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("active_role_keys = %v, expected to contain 'owner'", resp.ActiveRoleKeys)
	}
}

// TestMe_MembershipsAreIdentityScoped ensures /me returns the caller's OWN
// full membership list regardless of which tenant context is active, and only
// ever the caller's own memberships.
//
// The membership list powers the workspace picker and post-login routing, so
// it MUST be identity-scoped, not tenant-scoped: while a user sits in tenant A
// they still need to see (and switch to) tenant B. The old behavior — a plain
// tenant_members query under tenant-scoped RLS — hid the user's real
// workspaces whenever the active X-Tenant-ID pointed at a tenant they didn't
// belong to (e.g. a stale slug), which broke login. /me now uses the
// identity-scoped my_memberships() helper (filters on current_user_id()), so
// it returns the caller's own list only — never another user's, and never a
// tenant the caller isn't a member of.
func TestMe_MembershipsAreIdentityScoped(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	// Call Me as fx2's owner while the tenant context is set to fx1 (a tenant
	// fx2's owner is NOT a member of) — the stale/foreign-slug situation.
	r := callHandler(t, fx1, Me(rbacNewRepo()), "GET", "/v1/me", nil,
		actingAs(fx2.User)).
		expectStatus(200)

	var resp MeResponse
	r.decode(&resp)

	var sawOwn, sawForeign bool
	for _, m := range resp.Memberships {
		if m.TenantID == fx2.Tenant {
			sawOwn = true
		}
		if m.TenantID == fx1.Tenant {
			sawForeign = true
		}
	}
	// The caller's own membership must be present even though the active tenant
	// context is a different (foreign) tenant.
	if !sawOwn {
		t.Errorf("caller's own tenant (fx2) missing from memberships while fx1 context is active — membership list is wrongly tenant-scoped")
	}
	// The caller is NOT a member of fx1, so it must never appear.
	if sawForeign {
		t.Errorf("fx1 (a tenant the caller is not a member of) appeared in memberships — must only return the caller's own memberships")
	}
}

// =========================================================================
// SelectTenant
// =========================================================================

// TestSelectTenant_BadJSON covers the decode-error branch (missing / malformed body).
func TestSelectTenant_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		"{not json", withoutTenant()).
		expectErr(400, "bad_request")
}

// TestSelectTenant_EmptySlug covers the empty tenant_slug validation branch.
func TestSelectTenant_EmptySlug(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": ""}, withoutTenant()).
		expectErr(400, "bad_request")
}

// TestSelectTenant_MissingSlugField covers missing key (JSON decodes but slug is zero).
func TestSelectTenant_MissingSlugField(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"other_key": "value"}, withoutTenant()).
		expectErr(400, "bad_request")
}

// TestSelectTenant_TenantNotFound covers a slug that does not exist in the DB.
func TestSelectTenant_TenantNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": "no-such-tenant-xyzzy"}, withoutTenant()).
		expectErr(404, "tenant_not_found")
}

// TestSelectTenant_SuspendedTenant verifies that a suspended (status != 'active') tenant
// is treated as not found (the query filters status = 'active').
func TestSelectTenant_SuspendedTenant(t *testing.T) {
	fx := newTenant(t)
	fx.adminExec(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, fx.Tenant)
	// Restore so cleanup can cascade-delete later.
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(),
			`UPDATE tenants SET status = 'active' WHERE id = $1`, fx.Tenant)
	})

	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx.Slug}, withoutTenant()).
		expectErr(404, "tenant_not_found")
}

// TestSelectTenant_DeletedTenant verifies soft-deleted tenants are not selectable.
func TestSelectTenant_DeletedTenant(t *testing.T) {
	fx := newTenant(t)
	fx.adminExec(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, fx.Tenant)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(),
			`UPDATE tenants SET deleted_at = NULL WHERE id = $1`, fx.Tenant)
	})

	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx.Slug}, withoutTenant()).
		expectErr(404, "tenant_not_found")
}

// TestSelectTenant_NotAMember verifies that a user who has no row in tenant_members
// for the target tenant gets a 403.
func TestSelectTenant_NotAMember(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	// fx2.User is only a member of fx2.Tenant, not fx1.Tenant.
	callHandler(t, fx1, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx1.Slug}, withoutTenant(),
		actingAs(fx2.User)).
		expectErr(403, "not_a_member")
}

// TestSelectTenant_InactiveMember covers the status != 'active' branch: the user
// is a member but their status is 'pending', so they should be rejected (403).
func TestSelectTenant_InactiveMember(t *testing.T) {
	fx := newTenant(t)
	suffix := uuid.NewString()[:8]
	var pendingUserID uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"pending-"+suffix+"@test.local", "Pending "+suffix,
	).Scan(&pendingUserID); err != nil {
		t.Fatalf("seed pending user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, pendingUserID)
	})
	// Insert with status = 'pending' (not active).
	fx.adminExec(
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'pending')`,
		fx.Tenant, pendingUserID,
	)

	callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx.Slug}, withoutTenant(),
		actingAs(pendingUserID)).
		expectErr(403, "not_a_member")
}

// TestSelectTenant_Success covers the happy path: active member selects their
// workspace and gets back the tenant slug and (possibly empty) role list.
func TestSelectTenant_Success(t *testing.T) {
	fx := newTenant(t)

	r := callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx.Slug}, withoutTenant()).
		expectStatus(200)

	body := r.json()
	if slug, ok := body["tenant_slug"].(string); !ok || slug != fx.Slug {
		t.Fatalf("tenant_slug = %v, want %q", body["tenant_slug"], fx.Slug)
	}
	if _, ok := body["roles"].([]any); !ok {
		t.Fatalf("roles field should be an array, got %T: %v", body["roles"], body["roles"])
	}
}

// TestSelectTenant_SuccessWithRoles confirms that when the user has RBAC roles,
// those keys are returned in the response roles array.
func TestSelectTenant_SuccessWithRoles(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)

	r := callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx.Slug}, withoutTenant()).
		expectStatus(200)

	body := r.json()
	roles, _ := body["roles"].([]any)
	found := false
	for _, v := range roles {
		if s, ok := v.(string); ok && s == "owner" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("roles = %v, expected to contain 'owner' after rbacSeedSystemRoles", roles)
	}
}

// TestSelectTenant_WithExistingTenantContext verifies that SelectTenant still
// works when a tenant context is already set on the request (the optional
// middleware may resolve a tenant if X-Tenant-ID is present).  With RLS
// scoped to the fixture tenant, the membership lookup for that same tenant
// should succeed.
func TestSelectTenant_WithExistingTenantContext(t *testing.T) {
	fx := newTenant(t)

	// callHandler default sets tenant context to fx.Tenant.
	r := callHandler(t, fx, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx.Slug}).
		expectStatus(200)

	body := r.json()
	if slug, ok := body["tenant_slug"].(string); !ok || slug != fx.Slug {
		t.Fatalf("tenant_slug = %v, want %q", body["tenant_slug"], fx.Slug)
	}
}

// TestSelectTenant_CrossTenantIsolation verifies that a user cannot select a
// tenant they are not a member of, even when a different tenant context is
// already active on the request.  The membership check uses the user-scoped
// RLS branch once the handler promotes the tx to the target tenant_id, but
// since the user has no row for the requested tenant it returns 403.
func TestSelectTenant_CrossTenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	// fx2.User is NOT a member of fx1.Tenant.
	callHandler(t, fx1, SelectTenant(appPool), "POST", "/v1/sessions/select-tenant",
		map[string]any{"tenant_slug": fx1.Slug},
		withoutTenant(), actingAs(fx2.User)).
		expectErr(403, "not_a_member")
}

// =========================================================================
// ExportMyData
// =========================================================================

// exportMembership mirrors one element of the memberships array in the export
// document. Used to assert role keys are resolved across tenants with NO
// tenant context (the cross-tenant case my_memberships() exists to serve).
type exportMembership struct {
	TenantID   uuid.UUID `json:"tenant_id"`
	TenantSlug string    `json:"tenant_slug"`
	TenantName string    `json:"tenant_name"`
	Roles      []string  `json:"roles"`
	Status     string    `json:"status"`
}

type exportDoc struct {
	User struct {
		ID    uuid.UUID `json:"id"`
		Email string    `json:"email"`
	} `json:"user"`
	Memberships []exportMembership `json:"memberships"`
}

// TestExportMyData_ResolvesRolesWithoutTenant is the regression for the
// gdpr.go schema bug: the handler ran cross-tenant (no tenant context) but
// joined the tenant-scoped `roles` table, which returned nothing — and earlier
// referenced the dropped tenant_members.role column entirely, 500-ing every
// call. my_memberships() (migration 0030) resolves role keys via SECURITY
// DEFINER. This is the exact OptionalMiddleware mounting (withoutTenant).
func TestExportMyData_ResolvesRolesWithoutTenant(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx) // grants the owner role to fx.User

	var doc exportDoc
	callHandler(t, fx, ExportMyData, "GET", "/v1/me/export", nil,
		withoutTenant()).
		expectStatus(200).
		decode(&doc)

	if doc.User.ID != fx.User {
		t.Fatalf("export user id = %s, want %s", doc.User.ID, fx.User)
	}
	var found *exportMembership
	for i := range doc.Memberships {
		if doc.Memberships[i].TenantID == fx.Tenant {
			found = &doc.Memberships[i]
		}
	}
	if found == nil {
		t.Fatalf("fixture tenant %s not in memberships %+v", fx.Tenant, doc.Memberships)
	}
	if found.Status != "active" {
		t.Errorf("membership status = %q, want active", found.Status)
	}
	if len(found.Roles) != 1 || found.Roles[0] != "owner" {
		t.Errorf("membership roles = %v, want [owner]", found.Roles)
	}
}

// TestExportMyData_MembershipWithNoRoles proves a membership with no role
// grant serializes roles as an empty array (not null, not 500). newTenant
// creates the member but seeds no tenant_member_roles row.
func TestExportMyData_MembershipWithNoRoles(t *testing.T) {
	fx := newTenant(t)

	var doc exportDoc
	callHandler(t, fx, ExportMyData, "GET", "/v1/me/export", nil,
		withoutTenant()).
		expectStatus(200).
		decode(&doc)

	for _, m := range doc.Memberships {
		if m.TenantID == fx.Tenant {
			if m.Roles == nil {
				t.Error("roles should be [] not null for a membership with no grants")
			}
			if len(m.Roles) != 0 {
				t.Errorf("roles = %v, want empty", m.Roles)
			}
			return
		}
	}
	t.Fatalf("fixture tenant not in memberships %+v", doc.Memberships)
}

// TestExportMyData_SetsAttachmentHeader confirms the download disposition.
func TestExportMyData_SetsAttachmentHeader(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, ExportMyData, "GET", "/v1/me/export", nil,
		withoutTenant()).
		expectStatus(200)
	if cd := resp.Hdr.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Errorf("Content-Disposition = %q, want attachment", cd)
	}
}

// =========================================================================
// DeleteMyAccount
// =========================================================================

// TestDeleteMyAccount_SoleOwnerBlocked is the regression for the dropped
// tenant_members.role reference in the sole-owner guard. The guard now uses
// my_sole_owner_workspaces() (migration 0030). A user who is the only active
// owner of a workspace must be refused with 409 sole_owner and the slug.
func TestDeleteMyAccount_SoleOwnerBlocked(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx) // fx.User becomes the sole active owner

	resp := callHandler(t, fx, DeleteMyAccount(appPool), "DELETE", "/v1/me", nil,
		withoutTenant()).
		expectStatus(http.StatusConflict)
	if resp.errKind() != "sole_owner" {
		t.Fatalf("error kind = %q, want sole_owner; body: %s", resp.errKind(), resp.Body)
	}
	var body struct {
		Workspaces []string `json:"workspaces"`
	}
	resp.decode(&body)
	found := false
	for _, s := range body.Workspaces {
		if s == fx.Slug {
			found = true
		}
	}
	if !found {
		t.Errorf("workspaces = %v, want to include %q", body.Workspaces, fx.Slug)
	}

	// Nothing was deleted: the user row is untouched.
	var deletedAt *time.Time
	fx.adminScan([]any{&deletedAt}, `SELECT deleted_at FROM users WHERE id = $1`, fx.User)
	if deletedAt != nil {
		t.Error("sole-owner block must not delete the account")
	}
}

// TestDeleteMyAccount_NotSoleOwnerSucceeds verifies a co-owner can delete:
// when a second active owner exists, the guard passes and the account is
// anonymized.
func TestDeleteMyAccount_NotSoleOwnerSucceeds(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx) // fx.User is owner #1
	coOwner := fx.addUser("Co Owner")
	rbacGrantRole(t, fx, coOwner, ids["owner"]) // owner #2 → fx.User no longer sole

	callHandler(t, fx, DeleteMyAccount(appPool), "DELETE", "/v1/me", nil,
		withoutTenant()).
		expectStatus(http.StatusOK)

	// fx.User is anonymized + soft-deleted, membership dropped.
	var deletedAt, anonAt *time.Time
	var email string
	fx.adminScan([]any{&deletedAt, &anonAt, &email},
		`SELECT deleted_at, anonymized_at, email::text FROM users WHERE id = $1`, fx.User)
	if deletedAt == nil || anonAt == nil {
		t.Error("account should be soft-deleted and anonymized")
	}
	if !strings.HasPrefix(email, "anonymized-") {
		t.Errorf("email = %q, want anonymized- prefix", email)
	}
	var memberships int
	fx.adminScan([]any{&memberships},
		`SELECT count(*) FROM tenant_members WHERE user_id = $1`, fx.User)
	if memberships != 0 {
		t.Errorf("memberships remaining = %d, want 0", memberships)
	}
}

// TestDeleteMyAccount_NoMembershipsSucceeds confirms a user with no
// memberships at all (guard returns no rows) is anonymized cleanly.
func TestDeleteMyAccount_NoMembershipsSucceeds(t *testing.T) {
	fx := newTenant(t)
	suffix := uuid.NewString()[:8]
	var noMemberUserID uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"nomember-"+suffix+"@test.local", "NoMember "+suffix,
	).Scan(&noMemberUserID); err != nil {
		t.Fatalf("seed no-member user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, noMemberUserID)
	})

	callHandler(t, fx, DeleteMyAccount(appPool), "DELETE", "/v1/me", nil,
		withoutTenant(), actingAs(noMemberUserID)).
		expectStatus(http.StatusOK)

	var deletedAt *time.Time
	fx.adminScan([]any{&deletedAt}, `SELECT deleted_at FROM users WHERE id = $1`, noMemberUserID)
	if deletedAt == nil {
		t.Error("no-membership account should be soft-deleted")
	}
}
