package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// newBusinessOf groups the given fixture tenants into one business, the way
// the /super console does, and returns its id.
func newBusinessOf(t *testing.T, name string, fxs ...*fixture) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx, `INSERT INTO businesses (name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
		t.Fatalf("seed business: %v", err)
	}
	for _, fx := range fxs {
		if _, err := adminPool.Exec(ctx, `UPDATE tenants SET business_id = $2 WHERE id = $1`, fx.Tenant, id); err != nil {
			t.Fatalf("attach %s: %v", fx.Slug, err)
		}
	}
	t.Cleanup(func() { _, _ = adminPool.Exec(context.Background(), `DELETE FROM businesses WHERE id = $1`, id) })
	return id
}

// joinBranch makes userID an active member of fx's tenant holding the given
// system role (system roles are seeded on the tenant first).
func joinBranch(t *testing.T, fx *fixture, userID uuid.UUID, roleKey string) {
	t.Helper()
	ids := rbacSeedSystemRoles(t, fx)
	ctx := context.Background()
	if _, err := adminPool.Exec(ctx, `
		INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'`, fx.Tenant, userID); err != nil {
		t.Fatalf("joinBranch member: %v", err)
	}
	if _, err := adminPool.Exec(ctx, `
		INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING`, fx.Tenant, userID, ids[roleKey]); err != nil {
		t.Fatalf("joinBranch role: %v", err)
	}
}

type branchesResp struct {
	Business *BusinessInfo `json:"business"`
	Branches []Branch      `json:"branches"`
}

func getBranches(t *testing.T, fx *fixture, opts ...func(*reqOpts)) branchesResp {
	t.Helper()
	var out branchesResp
	callHandler(t, fx, GetBusinessBranches(appPool, rbac.NewRepo(nil, nil)), http.MethodGet, "/v1/business/branches", nil, opts...).
		expectStatus(http.StatusOK).decode(&out)
	return out
}

func branchSlugs(bs []Branch) map[string]Branch {
	out := map[string]Branch{}
	for _, b := range bs {
		out[b.Slug] = b
	}
	return out
}

func TestBusinessBranches_StandaloneCafeHasNone(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	got := getBranches(t, fx)
	if got.Business != nil || len(got.Branches) != 0 {
		t.Fatalf("standalone café: got business=%v branches=%d, want none", got.Business, len(got.Branches))
	}
}

func TestBusinessBranches_ListsOnlyBranchesTheCallerBelongsTo(t *testing.T) {
	a, b, c := newTenant(t), newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Sahan Group", a, b, c)
	joinBranch(t, b, a.User, "owner")
	// c: a.User is NOT a member — c must not appear, not even by name.

	got := getBranches(t, a)
	if got.Business == nil || got.Business.Name != "Sahan Group" {
		t.Fatalf("business = %+v, want Sahan Group", got.Business)
	}
	m := branchSlugs(got.Branches)
	if len(m) != 2 {
		t.Fatalf("branches = %v, want exactly %s and %s", m, a.Slug, b.Slug)
	}
	if _, ok := m[c.Slug]; ok {
		t.Fatalf("branch %s leaked to a non-member", c.Slug)
	}
	if !m[a.Slug].IsActive || m[b.Slug].IsActive {
		t.Fatalf("is_active should mark only the anchor: %+v", m)
	}
	for _, br := range got.Branches {
		if br.Can == nil || !br.Can.ReportRead || !br.Can.MenuUpdate || !br.Can.FinanceRead {
			t.Fatalf("owner in %s should be able to read reports/finance and edit the menu: %+v", br.Slug, br.Can)
		}
	}
}

func TestBusinessBranches_CanReflectsEachBranchsOwnRole(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Mixed Roles", a, b)
	joinBranch(t, b, a.User, "waiter")

	m := branchSlugs(getBranches(t, a).Branches)
	if m[b.Slug].Can == nil || m[b.Slug].Can.ReportRead || m[b.Slug].Can.MenuUpdate {
		t.Fatalf("a waiter in %s must not read reports or edit the menu: %+v", b.Slug, m[b.Slug].Can)
	}
	if !m[a.Slug].Can.ReportRead {
		t.Fatalf("owner of %s should read reports", a.Slug)
	}
}

func TestBusinessBranches_InactiveMembershipHidesBranch(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Removed", a, b)
	joinBranch(t, b, a.User, "owner")
	a.adminExec(`UPDATE tenant_members SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`, b.Tenant, a.User)

	if m := branchSlugs(getBranches(t, a).Branches); len(m) != 1 {
		t.Fatalf("a suspended membership must hide the branch: %v", m)
	}
}

func TestBusinessBranches_OtherBusinessIsInvisible(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Mine", a)
	newBusinessOf(t, "Theirs", b)
	joinBranch(t, b, a.User, "owner") // member of b, but b is a different business

	m := branchSlugs(getBranches(t, a).Branches)
	if _, ok := m[b.Slug]; ok || len(m) != 1 {
		t.Fatalf("a branch of another business leaked: %v", m)
	}
}

// The function is anchored on the request's tenant AND requires membership of
// it: setting app.tenant_id to a café you don't belong to yields nothing.
func TestMyBusinessBranches_NonMemberAnchorYieldsNothing(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	newBusinessOf(t, "Probe", a, b)
	outsider := b.addUser("outsider") // member of b only

	err := a.appTx(func(tx pgx.Tx) error {
		bg := context.Background()
		if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", outsider.String()); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(bg, `SELECT count(*) FROM my_business_branches()`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			t.Fatalf("non-member of the anchor saw %d branches", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMe_IncludesBusinessOnlyForBranches(t *testing.T) {
	solo := newTenant(t)
	rbacSeedSystemRoles(t, solo)
	var me MeResponse
	callHandler(t, solo, Me(rbac.NewRepo(nil, nil)), http.MethodGet, "/v1/me", nil).expectStatus(http.StatusOK).decode(&me)
	if me.Business != nil || len(me.Branches) != 0 {
		t.Fatalf("standalone /me must not carry a business: %+v", me.Business)
	}

	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Two Branches", a, b)
	joinBranch(t, b, a.User, "manager")
	me = MeResponse{}
	callHandler(t, a, Me(rbac.NewRepo(nil, nil)), http.MethodGet, "/v1/me", nil).expectStatus(http.StatusOK).decode(&me)
	if me.Business == nil || me.Business.Name != "Two Branches" || len(me.Branches) != 2 {
		t.Fatalf("/me business = %+v, branches = %d; want Two Branches / 2", me.Business, len(me.Branches))
	}
}
