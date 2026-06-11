package api

// Integration tests for members.go, invites.go, and roles.go.
//
// Handlers covered:
//   - ListMembers
//   - UpdateMemberRoles
//   - RemoveMember
//   - ListInvites
//   - CreateInvite
//   - RevokeInvite
//   - ListPermissionManifest
//   - ListRoles
//   - GetRole
//   - CreateRole
//   - UpdateRole
//   - DeleteRole
//
// A fresh tenant has NO roles. All tests that interact with
// role-aware handlers call rbacSeedSystemRoles first to populate
// the system roles (owner / manager / waiter / kitchen) and grant
// the owner role to the fixture user.

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// =========================================================================
// RBAC fixture helpers (domain-prefixed: rbac*)
// =========================================================================

// rbacNewRepo returns a Repo backed by the admin pool with a small cache.
// Using the admin pool here mirrors how provision.go seeds roles in a
// superuser context; the handlers receive the app pool tx, which is correct.
func rbacNewRepo() *rbac.Repo {
	return rbac.NewRepo(adminPool, rbac.NewCache(16))
}

// rbacSeedSystemRoles seeds the four system roles for fx.Tenant via the
// admin pool (RLS bypassed) and grants the 'owner' role to fx.User.
// Returns the key→id map for the seeded roles so tests can reference
// specific role IDs without an extra lookup.
func rbacSeedSystemRoles(t *testing.T, fx *fixture) map[string]uuid.UUID {
	t.Helper()
	requireDB(t)
	ctx := context.Background()

	tx, err := adminPool.Begin(ctx)
	if err != nil {
		t.Fatalf("rbacSeedSystemRoles begin tx: %v", err)
	}
	// Scope the tx to this tenant so the FORCE-RLS roles insert succeeds.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("rbacSeedSystemRoles set tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", fx.User.String()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("rbacSeedSystemRoles set user: %v", err)
	}

	repo := rbacNewRepo()
	ids, err := repo.SeedSystemRoles(ctx, tx, fx.Tenant)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("rbacSeedSystemRoles seed: %v", err)
	}

	// Grant the owner role to the fixture user (mirrors provision.go).
	ownerID := ids["owner"]
	if _, err := tx.Exec(ctx,
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.Tenant, fx.User, ownerID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("rbacSeedSystemRoles grant owner: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("rbacSeedSystemRoles commit: %v", err)
	}
	return ids
}

// rbacSeedCustomRole inserts a non-system role via the admin pool and
// returns its id. The role has no permissions by default.
func rbacSeedCustomRole(t *testing.T, fx *fixture, key, name string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, $2, $3, false) RETURNING id`,
		fx.Tenant, key, name)
	return id
}

// rbacGrantRole assigns an additional role to a member via the admin pool.
func rbacGrantRole(t *testing.T, fx *fixture, userID, roleID uuid.UUID) {
	t.Helper()
	fx.adminExec(
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		fx.Tenant, userID, roleID)
}

// =========================================================================
// ListMembers
// =========================================================================

func TestListMembers_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListMembers, "GET", "/", nil).
		expectStatus(200).json()
	ms, _ := r["members"].([]any)
	// newTenant seeds one member (the owner).
	if len(ms) != 1 {
		t.Fatalf("members = %d, want 1", len(ms))
	}
}

func TestListMembers_MultipleMembers(t *testing.T) {
	fx := newTenant(t)
	fx.addUser("Alice")
	fx.addUser("Bob")
	r := callHandler(t, fx, ListMembers, "GET", "/", nil).
		expectStatus(200).json()
	ms, _ := r["members"].([]any)
	if len(ms) != 3 {
		t.Fatalf("members = %d, want 3", len(ms))
	}
}

func TestListMembers_RolesPopulated(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	r := callHandler(t, fx, ListMembers, "GET", "/", nil).
		expectStatus(200).json()
	ms, _ := r["members"].([]any)
	if len(ms) == 0 {
		t.Fatal("no members returned")
	}
	// The owner member should have the "owner" role key in their roles list.
	first := ms[0].(map[string]any)
	roles, _ := first["roles"].([]any)
	found := false
	for _, rk := range roles {
		if rk.(string) == "owner" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("owner role not in member roles: %v", roles)
	}
}

func TestListMembers_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx2.addUser("OtherTenantUser")

	// fx1 should still see only its own member.
	r := callHandler(t, fx1, ListMembers, "GET", "/", nil).
		expectStatus(200).json()
	ms, _ := r["members"].([]any)
	if len(ms) != 1 {
		t.Fatalf("tenant isolation broken: members = %d, want 1", len(ms))
	}
}

// =========================================================================
// UpdateMemberRoles
// =========================================================================

func TestUpdateMemberRoles_BadUserID(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{"owner"}},
		withParam("userId", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateMemberRoles_BadJSON(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/", "{bad json",
		withParam("userId", other.String())).
		expectErr(400, "bad_request")
}

func TestUpdateMemberRoles_EmptyRoles(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{}},
		withParam("userId", other.String())).
		expectErr(400, "roles_required")
}

func TestUpdateMemberRoles_UnknownRoleKey(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{"does_not_exist"}},
		withParam("userId", other.String())).
		expectErr(400, "bad_role")
}

func TestUpdateMemberRoles_MemberNotFound(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{"owner"}},
		withParam("userId", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateMemberRoles_LastOwnerProtected(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	// fx.User is the sole owner. Trying to replace their roles with "waiter"
	// should be rejected as last_owner.
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{"waiter"}},
		withParam("userId", fx.User.String())).
		expectErr(409, "last_owner")
}

func TestUpdateMemberRoles_LastOwnerProtectedByRoleIDs(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	waiterID := ids["waiter"]
	// Sending via role_ids path, stripping owner from sole owner.
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_ids": []string{waiterID.String()}},
		withParam("userId", fx.User.String())).
		expectErr(409, "last_owner")
}

func TestUpdateMemberRoles_SuccessViaRoleKeys(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{"waiter"}},
		withParam("userId", other.String())).
		expectStatus(204)
	// Verify DB state: Bob should have exactly the waiter role.
	var n int
	fx.adminScan([]any{&n}, `
		SELECT count(*) FROM tenant_member_roles tmr
		JOIN roles r ON r.id = tmr.role_id
		WHERE tmr.tenant_id = $1 AND tmr.user_id = $2 AND r.key = 'waiter'`,
		fx.Tenant, other)
	if n != 1 {
		t.Fatalf("waiter role rows = %d, want 1", n)
	}
}

func TestUpdateMemberRoles_SuccessViaRoleIDs(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	managerID := ids["manager"]
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_ids": []string{managerID.String()}},
		withParam("userId", other.String())).
		expectStatus(204)
	var n int
	fx.adminScan([]any{&n}, `
		SELECT count(*) FROM tenant_member_roles tmr
		WHERE tmr.tenant_id = $1 AND tmr.user_id = $2 AND tmr.role_id = $3`,
		fx.Tenant, other, managerID)
	if n != 1 {
		t.Fatalf("manager role rows = %d, want 1", n)
	}
}

func TestUpdateMemberRoles_SuccessViaLegacyRolesField(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	// Legacy clients post {"roles": [...]} with role keys.
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"roles": []string{"kitchen"}},
		withParam("userId", other.String())).
		expectStatus(204)
}

func TestUpdateMemberRoles_InvalidRoleIDFormat(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	other := fx.addUser("Bob")
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_ids": []string{"not-a-uuid"}},
		withParam("userId", other.String())).
		expectErr(400, "bad_request")
}

func TestUpdateMemberRoles_SecondOwnerAllowsStripping(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	// Add a second owner so stripping the first owner's role is safe.
	other := fx.addUser("SecondOwner")
	ownerID := ids["owner"]
	rbacGrantRole(t, fx, other, ownerID)

	// Now stripping owner from fx.User (replacing with waiter) should succeed.
	callHandler(t, fx, UpdateMemberRoles(repo), "PATCH", "/",
		map[string]any{"role_keys": []string{"waiter"}},
		withParam("userId", fx.User.String())).
		expectStatus(204)
}

// =========================================================================
// RemoveMember
// =========================================================================

func TestRemoveMember_BadUserID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RemoveMember, "DELETE", "/", nil,
		withParam("userId", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestRemoveMember_SelfRemoveRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RemoveMember, "DELETE", "/", nil,
		withParam("userId", fx.User.String())).
		expectErr(409, "self_remove")
}

func TestRemoveMember_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RemoveMember, "DELETE", "/", nil,
		withParam("userId", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestRemoveMember_LastOwnerProtected(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	ownerID := ids["owner"]
	// Make a second user the SOLE owner, then try to remove them — the
	// handler must refuse to leave the tenant with zero owners.
	other := fx.addUser("SecondOwner")
	rbacGrantRole(t, fx, other, ownerID)
	// Strip any owner grant from fx.User so `other` is the only owner.
	fx.adminExec(`DELETE FROM tenant_member_roles WHERE tenant_id = $1 AND user_id = $2`,
		fx.Tenant, fx.User)

	callHandler(t, fx, RemoveMember, "DELETE", "/", nil,
		withParam("userId", other.String()),
		actingAs(fx.User)).
		expectErr(409, "last_owner")
}

func TestRemoveMember_Success(t *testing.T) {
	fx := newTenant(t)
	other := fx.addUser("Bob")
	callHandler(t, fx, RemoveMember, "DELETE", "/", nil,
		withParam("userId", other.String())).
		expectStatus(204)
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
		fx.Tenant, other)
	if n != 0 {
		t.Fatalf("member still exists after remove, want 0 rows")
	}
}

func TestRemoveMember_SuccessRevokesSession(t *testing.T) {
	fx := newTenant(t)
	other := fx.addUser("Bob")
	// Seed an active session for Bob.
	var sessID uuid.UUID
	fx.adminScan([]any{&sessID}, `
		INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at)
		VALUES ($1, $2, 'testhash-bob', now() + interval '1 day')
		RETURNING id`,
		fx.Tenant, other)

	callHandler(t, fx, RemoveMember, "DELETE", "/", nil,
		withParam("userId", other.String())).
		expectStatus(204)

	var revokedAt *string
	fx.adminScan([]any{&revokedAt},
		`SELECT revoked_at::text FROM sessions WHERE id = $1`, sessID)
	if revokedAt == nil {
		t.Fatal("session not revoked after member removal")
	}
}

// =========================================================================
// ListInvites
// =========================================================================

func TestListInvites_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListInvites, "GET", "/", nil).
		expectStatus(200).json()
	invs, _ := r["invites"].([]any)
	if len(invs) != 0 {
		t.Fatalf("invites = %d, want 0", len(invs))
	}
}

func TestListInvites_WithRows(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	// Seed a pending invite directly.
	fx.adminExec(`
		INSERT INTO tenant_invites (tenant_id, email, roles, invited_by_user_id)
		VALUES ($1, 'pending@test.local', ARRAY['waiter']::text[], $2)`,
		fx.Tenant, fx.User)

	r := callHandler(t, fx, ListInvites, "GET", "/", nil).
		expectStatus(200).json()
	invs, _ := r["invites"].([]any)
	if len(invs) != 1 {
		t.Fatalf("invites = %d, want 1", len(invs))
	}
}

func TestListInvites_AcceptedExcluded(t *testing.T) {
	fx := newTenant(t)
	// Seed one accepted invite and one pending.
	fx.adminExec(`
		INSERT INTO tenant_invites (tenant_id, email, roles, accepted_at)
		VALUES ($1, 'done@test.local', ARRAY['owner']::text[], now())`,
		fx.Tenant)
	fx.adminExec(`
		INSERT INTO tenant_invites (tenant_id, email, roles)
		VALUES ($1, 'waiting@test.local', ARRAY['owner']::text[])`,
		fx.Tenant)

	r := callHandler(t, fx, ListInvites, "GET", "/", nil).
		expectStatus(200).json()
	invs, _ := r["invites"].([]any)
	if len(invs) != 1 {
		t.Fatalf("invites = %d, want 1 (accepted should be excluded)", len(invs))
	}
}

func TestListInvites_RevokedExcluded(t *testing.T) {
	fx := newTenant(t)
	fx.adminExec(`
		INSERT INTO tenant_invites (tenant_id, email, roles, revoked_at)
		VALUES ($1, 'gone@test.local', ARRAY['owner']::text[], now())`,
		fx.Tenant)

	r := callHandler(t, fx, ListInvites, "GET", "/", nil).
		expectStatus(200).json()
	invs, _ := r["invites"].([]any)
	if len(invs) != 0 {
		t.Fatalf("invites = %d, want 0 (revoked should be excluded)", len(invs))
	}
}

func TestListInvites_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	// Seed an invite for fx2 only.
	fx2.adminExec(`
		INSERT INTO tenant_invites (tenant_id, email, roles)
		VALUES ($1, 'other@test.local', ARRAY['owner']::text[])`,
		fx2.Tenant)

	r := callHandler(t, fx1, ListInvites, "GET", "/", nil).
		expectStatus(200).json()
	invs, _ := r["invites"].([]any)
	if len(invs) != 0 {
		t.Fatalf("tenant isolation broken: invites = %d, want 0", len(invs))
	}
}

// =========================================================================
// CreateInvite
// =========================================================================

func TestCreateInvite_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInvite, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateInvite_MissingEmail(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"roles": []string{"owner"}}).
		expectErr(400, "bad_request")
}

func TestCreateInvite_BlankEmail(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "   ", "roles": []string{"owner"}}).
		expectErr(400, "bad_request")
}

func TestCreateInvite_InvalidEmail_NoAt(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "notanemail", "roles": []string{"owner"}}).
		expectErr(400, "bad_request")
}

func TestCreateInvite_NoRoles(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "newuser@test.local", "roles": []string{}}).
		expectErr(400, "roles_required")
}

func TestCreateInvite_UnknownRoleKey(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "newuser@test.local", "roles": []string{"ghost"}}).
		expectErr(400, "bad_role")
}

func TestCreateInvite_AlreadyMember(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	// fx.User is already a member with email fx.Email.
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": fx.Email, "roles": []string{"waiter"}}).
		expectErr(409, "already_member")
}

func TestCreateInvite_DuplicatePending(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	body := map[string]any{"email": "dup@test.local", "roles": []string{"waiter"}}
	callHandler(t, fx, CreateInvite, "POST", "/", body).expectStatus(201)
	// Second invite for same email while first is still pending.
	callHandler(t, fx, CreateInvite, "POST", "/", body).
		expectErr(409, "already_invited")
}

func TestCreateInvite_SuccessReturnsInvite(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	r := callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "newbie@test.local", "roles": []string{"waiter"}}).
		expectStatus(201)

	var inv Invite
	r.decode(&inv)
	if inv.ID == uuid.Nil {
		t.Fatal("invite id is nil")
	}
	if inv.Email != "newbie@test.local" {
		t.Fatalf("email = %q, want newbie@test.local", inv.Email)
	}
	if len(inv.Roles) != 1 || inv.Roles[0] != "waiter" {
		t.Fatalf("roles = %v, want [waiter]", inv.Roles)
	}
}

func TestCreateInvite_EmailNormalisedToLower(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	r := callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "User@Test.LOCAL", "roles": []string{"waiter"}}).
		expectStatus(201)
	var inv Invite
	r.decode(&inv)
	if inv.Email != "user@test.local" {
		t.Fatalf("email not normalised: got %q", inv.Email)
	}
}

func TestCreateInvite_RevokedThenReInvited(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	body := map[string]any{"email": "reinvite@test.local", "roles": []string{"waiter"}}
	r := callHandler(t, fx, CreateInvite, "POST", "/", body).expectStatus(201)
	var inv Invite
	r.decode(&inv)
	// Revoke the invite.
	callHandler(t, fx, RevokeInvite, "DELETE", "/", nil,
		withParam("id", inv.ID.String())).expectStatus(204)
	// Should be able to re-invite the same email since the partial unique
	// index only constrains pending rows.
	callHandler(t, fx, CreateInvite, "POST", "/", body).expectStatus(201)
}

func TestCreateInvite_PersistsToDatabase(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "persisted@test.local", "roles": []string{"manager"}}).
		expectStatus(201)
	var n int
	fx.adminScan([]any{&n}, `
		SELECT count(*) FROM tenant_invites
		WHERE tenant_id = $1 AND email = 'persisted@test.local'
		  AND accepted_at IS NULL AND revoked_at IS NULL`,
		fx.Tenant)
	if n != 1 {
		t.Fatalf("invite not persisted: count = %d", n)
	}
}

// =========================================================================
// RevokeInvite
// =========================================================================

func TestRevokeInvite_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RevokeInvite, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestRevokeInvite_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RevokeInvite, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestRevokeInvite_AlreadyRevoked(t *testing.T) {
	fx := newTenant(t)
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO tenant_invites (tenant_id, email, roles, revoked_at)
		VALUES ($1, 'gone@test.local', ARRAY['owner']::text[], now())
		RETURNING id`, fx.Tenant)
	callHandler(t, fx, RevokeInvite, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestRevokeInvite_AlreadyAccepted(t *testing.T) {
	fx := newTenant(t)
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO tenant_invites (tenant_id, email, roles, accepted_at)
		VALUES ($1, 'accepted@test.local', ARRAY['owner']::text[], now())
		RETURNING id`, fx.Tenant)
	callHandler(t, fx, RevokeInvite, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestRevokeInvite_Success(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	// Create an invite then revoke it.
	r := callHandler(t, fx, CreateInvite, "POST", "/",
		map[string]any{"email": "torevoke@test.local", "roles": []string{"waiter"}}).
		expectStatus(201)
	var inv Invite
	r.decode(&inv)

	callHandler(t, fx, RevokeInvite, "DELETE", "/", nil,
		withParam("id", inv.ID.String())).
		expectStatus(204)

	// Verify revoked_at is set in DB.
	var revokedAt *string
	fx.adminScan([]any{&revokedAt},
		`SELECT revoked_at::text FROM tenant_invites WHERE id = $1`, inv.ID)
	if revokedAt == nil {
		t.Fatal("revoked_at not set after RevokeInvite")
	}
	// Row is retained (soft delete).
	var n int
	fx.adminScan([]any{&n}, `SELECT count(*) FROM tenant_invites WHERE id = $1`, inv.ID)
	if n != 1 {
		t.Fatal("invite row should be retained (soft delete), but it's gone")
	}
}

// =========================================================================
// ListPermissionManifest
// =========================================================================

func TestListPermissionManifest_ReturnsManifest(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListPermissionManifest, "GET", "/", nil).
		expectStatus(200).json()
	if _, ok := r["resources"]; !ok {
		t.Fatal("manifest missing 'resources'")
	}
	if _, ok := r["permissions"]; !ok {
		t.Fatal("manifest missing 'permissions'")
	}
	if _, ok := r["system_roles"]; !ok {
		t.Fatal("manifest missing 'system_roles'")
	}
	if v, ok := r["version"].(float64); !ok || v < 1 {
		t.Fatalf("manifest version = %v, want >= 1", r["version"])
	}
}

func TestListPermissionManifest_ContainsOwnerSystemRole(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListPermissionManifest, "GET", "/", nil).
		expectStatus(200).json()
	srs, _ := r["system_roles"].([]any)
	found := false
	for _, sr := range srs {
		m := sr.(map[string]any)
		if m["key"] == "owner" {
			found = true
			if locked, _ := m["locked"].(bool); !locked {
				t.Fatal("owner system role should have locked=true")
			}
		}
	}
	if !found {
		t.Fatal("owner system role not found in manifest")
	}
}

// =========================================================================
// ListRoles
// =========================================================================

func TestListRoles_Empty(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	r := callHandler(t, fx, ListRoles(repo), "GET", "/", nil).
		expectStatus(200).json()
	roles, _ := r["roles"].([]any)
	if len(roles) != 0 {
		t.Fatalf("roles = %d, want 0 (no system roles seeded)", len(roles))
	}
}

func TestListRoles_AfterSeed(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	r := callHandler(t, fx, ListRoles(repo), "GET", "/", nil).
		expectStatus(200).json()
	roles, _ := r["roles"].([]any)
	// Should have owner, manager, waiter, kitchen = 4 system roles.
	if len(roles) != 4 {
		t.Fatalf("roles = %d, want 4", len(roles))
	}
}

func TestListRoles_OwnerLockedTrue(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	r := callHandler(t, fx, ListRoles(repo), "GET", "/", nil).
		expectStatus(200).json()
	roles, _ := r["roles"].([]any)
	for _, rr := range roles {
		m := rr.(map[string]any)
		if m["key"] == "owner" {
			if locked, _ := m["locked"].(bool); !locked {
				t.Fatal("owner role wire.Locked should be true")
			}
			return
		}
	}
	t.Fatal("owner role not found in list")
}

func TestListRoles_MemberCountReflectsAssignment(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()

	waiterID := ids["waiter"]
	other := fx.addUser("Bob")
	rbacGrantRole(t, fx, other, waiterID)

	r := callHandler(t, fx, ListRoles(repo), "GET", "/", nil).
		expectStatus(200).json()
	roles, _ := r["roles"].([]any)
	for _, rr := range roles {
		m := rr.(map[string]any)
		if m["key"] == "waiter" {
			cnt := int(m["member_count"].(float64))
			if cnt != 1 {
				t.Fatalf("waiter member_count = %d, want 1", cnt)
			}
			return
		}
	}
	t.Fatal("waiter role not found")
}

func TestListRoles_IsolatedByTenant(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	rbacSeedSystemRoles(t, fx2) // seed only for tenant 2

	repo := rbacNewRepo()
	r := callHandler(t, fx1, ListRoles(repo), "GET", "/", nil).
		expectStatus(200).json()
	roles, _ := r["roles"].([]any)
	if len(roles) != 0 {
		t.Fatalf("tenant isolation broken: roles = %d, want 0", len(roles))
	}
}

// =========================================================================
// GetRole
// =========================================================================

func TestGetRole_BadID(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, GetRole(repo), "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestGetRole_NotFound(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, GetRole(repo), "GET", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestGetRole_OwnerRole(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	ownerID := ids["owner"]
	r := callHandler(t, fx, GetRole(repo), "GET", "/", nil,
		withParam("id", ownerID.String())).
		expectStatus(200).json()
	if r["key"] != "owner" {
		t.Fatalf("key = %q, want owner", r["key"])
	}
	if locked, _ := r["locked"].(bool); !locked {
		t.Fatal("owner locked should be true")
	}
	if isSystem, _ := r["is_system"].(bool); !isSystem {
		t.Fatal("owner is_system should be true")
	}
}

func TestGetRole_CustomRole(t *testing.T) {
	fx := newTenant(t)
	rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	// Look up by listing first to get the id.
	r := callHandler(t, fx, ListRoles(repo), "GET", "/", nil).expectStatus(200).json()
	roles, _ := r["roles"].([]any)
	var baristaID string
	for _, rr := range roles {
		m := rr.(map[string]any)
		if m["key"] == "barista" {
			baristaID = m["id"].(string)
		}
	}
	if baristaID == "" {
		t.Fatal("barista role not in list")
	}
	r2 := callHandler(t, fx, GetRole(repo), "GET", "/", nil,
		withParam("id", baristaID)).
		expectStatus(200).json()
	if r2["key"] != "barista" {
		t.Fatalf("key = %q, want barista", r2["key"])
	}
	if locked, _ := r2["locked"].(bool); locked {
		t.Fatal("custom role locked should be false")
	}
}

// =========================================================================
// CreateRole
// =========================================================================

func TestCreateRole_BadJSON(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateRole_MissingKey(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"name": "Barista"}).
		expectErr(400, "bad_request")
}

func TestCreateRole_MissingName(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "barista"}).
		expectErr(400, "bad_request")
}

func TestCreateRole_BlankKey(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "   ", "name": "Barista"}).
		expectErr(400, "bad_request")
}

func TestCreateRole_BlankName(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "barista", "name": "   "}).
		expectErr(400, "bad_request")
}

func TestCreateRole_ReservedOwnerKey(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "owner", "name": "Custom Owner"}).
		expectErr(409, "key_reserved")
}

func TestCreateRole_ReservedManagerKey(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "manager", "name": "Custom Manager"}).
		expectErr(409, "key_reserved")
}

func TestCreateRole_ReservedWaiterKey(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "waiter", "name": "Custom Waiter"}).
		expectErr(409, "key_reserved")
}

func TestCreateRole_ReservedKitchenKey(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "kitchen", "name": "Custom Kitchen"}).
		expectErr(409, "key_reserved")
}

func TestCreateRole_DuplicateKey(t *testing.T) {
	fx := newTenant(t)
	rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "barista", "name": "Another Barista"}).
		expectErr(409, "key_taken")
}

func TestCreateRole_BadPermission(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{
			"key":         "barista",
			"name":        "Barista",
			"permissions": []string{"not_valid_perm"},
		}).
		expectErr(400, "bad_request")
}

func TestCreateRole_Success(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	r := callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{
			"key":         "barista",
			"name":        "Barista",
			"description": "Makes coffee",
			"permissions": []string{"menu:read", "order:read"},
		}).
		expectStatus(201).json()

	if r["key"] != "barista" {
		t.Fatalf("key = %q, want barista", r["key"])
	}
	if r["name"] != "Barista" {
		t.Fatalf("name = %q, want Barista", r["name"])
	}
	if isSystem, _ := r["is_system"].(bool); isSystem {
		t.Fatal("custom role should have is_system=false")
	}
	if locked, _ := r["locked"].(bool); locked {
		t.Fatal("custom role should have locked=false")
	}
	perms, _ := r["permissions"].([]any)
	if len(perms) != 2 {
		t.Fatalf("permissions = %d, want 2", len(perms))
	}
	// Verify the row is in the DB.
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM roles WHERE tenant_id = $1 AND key = 'barista'`,
		fx.Tenant)
	if n != 1 {
		t.Fatalf("role not persisted: count = %d", n)
	}
}

func TestCreateRole_WithWildcardPermission(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	r := callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{
			"key":         "all_menu",
			"name":        "All Menu",
			"permissions": []string{"menu:*"},
		}).
		expectStatus(201).json()
	perms, _ := r["permissions"].([]any)
	if len(perms) != 1 || perms[0].(string) != "menu:*" {
		t.Fatalf("permissions = %v, want [menu:*]", perms)
	}
}

// =========================================================================
// UpdateRole
// =========================================================================

func TestUpdateRole_BadID(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "New Name"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateRole_BadJSON(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/", "{bad json",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateRole_NotFound(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "New Name"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateRole_OwnerImmutable(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	ownerID := ids["owner"]
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "Super Owner"},
		withParam("id", ownerID.String())).
		expectErr(403, "owner_immutable")
}

func TestUpdateRole_OwnerImmutable_PermissionChange(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	ownerID := ids["owner"]
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"permissions": []string{"menu:read"}},
		withParam("id", ownerID.String())).
		expectErr(403, "owner_immutable")
}

func TestUpdateRole_BlankName(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "   "},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateRole_BadPermission(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"permissions": []string{"invalid_perm"}},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateRole_SuccessName(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	r := callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "Head Barista"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["name"] != "Head Barista" {
		t.Fatalf("name = %q, want Head Barista", r["name"])
	}
}

func TestUpdateRole_SuccessPermissions(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	r := callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"permissions": []string{"menu:read", "order:create"}},
		withParam("id", id.String())).
		expectStatus(200).json()
	perms, _ := r["permissions"].([]any)
	if len(perms) != 2 {
		t.Fatalf("permissions = %d, want 2", len(perms))
	}
}

func TestUpdateRole_SuccessDescription(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	desc := "Makes espresso"
	r := callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"description": desc},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["description"] != desc {
		t.Fatalf("description = %q, want %q", r["description"], desc)
	}
}

func TestUpdateRole_OmittedFieldsPreserved(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	// Set a description first.
	callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"description": "Original description"},
		withParam("id", id.String())).expectStatus(200)
	// Now update only the name — description must survive.
	r := callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "Head Barista"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["description"] != "Original description" {
		t.Fatalf("description changed unexpectedly: %q", r["description"])
	}
}

func TestUpdateRole_ManagerCanBeRenamed(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	managerID := ids["manager"]
	r := callHandler(t, fx, UpdateRole(repo), "PATCH", "/",
		map[string]any{"name": "Senior Manager"},
		withParam("id", managerID.String())).
		expectStatus(200).json()
	if r["name"] != "Senior Manager" {
		t.Fatalf("name = %q, want Senior Manager", r["name"])
	}
}

// =========================================================================
// DeleteRole
// =========================================================================

func TestDeleteRole_BadID(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteRole_NotFound(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteRole_OwnerImmutable(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", ids["owner"].String())).
		expectErr(403, "owner_immutable")
}

func TestDeleteRole_RoleInUse(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	// Assign the role to the fixture user.
	rbacGrantRole(t, fx, fx.User, id)
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(409, "role_in_use")
}

func TestDeleteRole_Success(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	// Verify the row is gone.
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM roles WHERE id = $1`, id)
	if n != 0 {
		t.Fatalf("role still exists after delete: count = %d", n)
	}
}

func TestDeleteRole_PermissionsCleanedUp(t *testing.T) {
	fx := newTenant(t)
	repo := rbacNewRepo()
	// Create a role with permissions, then delete it.
	r := callHandler(t, fx, CreateRole(repo), "POST", "/",
		map[string]any{"key": "barista", "name": "Barista", "permissions": []string{"menu:read"}}).
		expectStatus(201).json()
	id := r["id"].(string)
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", id)).
		expectStatus(204)
	// role_permissions are cascade-deleted with the role.
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM role_permissions rp
		 JOIN roles r ON r.id = rp.role_id
		 WHERE r.tenant_id = $1 AND r.key = 'barista'`,
		fx.Tenant)
	if n != 0 {
		t.Fatalf("role_permissions not cleaned up: count = %d", n)
	}
}

func TestDeleteRole_NonOwnerSystemRoleCanBeDeleted(t *testing.T) {
	fx := newTenant(t)
	ids := rbacSeedSystemRoles(t, fx)
	repo := rbacNewRepo()
	// The waiter system role has no members, so it can be deleted.
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", ids["waiter"].String())).
		expectStatus(204)
}

func TestDeleteRole_SecondDeleteFails(t *testing.T) {
	fx := newTenant(t)
	id := rbacSeedCustomRole(t, fx, "barista", "Barista")
	repo := rbacNewRepo()
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", id.String())).expectStatus(204)
	callHandler(t, fx, DeleteRole(repo), "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}
