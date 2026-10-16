package api

import (
	"net/http"
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

func syncMenu(t *testing.T, anchor *fixture, body map[string]any) menuSyncResp {
	t.Helper()
	var out menuSyncResp
	callHandler(t, anchor, SyncBusinessMenu(appPool, rbac.NewRepo(nil, nil)), http.MethodPost,
		"/v1/business/menu/sync", body).expectStatus(http.StatusOK).decode(&out)
	return out
}

func targetOf(resp menuSyncResp, slug string) syncTarget {
	for _, t := range resp.Targets {
		if t.Slug == slug {
			return t
		}
	}
	return syncTarget{}
}

func (fx *fixture) itemPrice(name string) (int64, bool) {
	fx.t.Helper()
	var p int64
	var n int
	fx.adminScan([]any{&n}, `SELECT count(*) FROM menu_items WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`, fx.Tenant, name)
	if n == 0 {
		return 0, false
	}
	fx.adminScan([]any{&p}, `SELECT price_cents FROM menu_items WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`, fx.Tenant, name)
	return p, true
}

// syncPair: a (source) and b (target) in one business, a's owner owning both.
func syncPair(t *testing.T) (*fixture, *fixture) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Sync Group", a, b)
	joinBranch(t, b, a.User, "owner")
	return a, b
}

func TestMenuSync_DryRunPreviewsAndWritesNothing(t *testing.T) {
	a, b := syncPair(t)
	cat := a.seedCategory("Coffee")
	a.seedMenuItem(cat, "Latte", 25000)
	a.seedMenuItem(cat, "Mocha", 30000)
	bcat := b.seedCategory("Coffee")
	b.seedMenuItem(bcat, "Latte", 28000) // Thamel charges more

	got := syncMenu(t, a, map[string]any{"targets": []string{b.Slug}, "dry_run": true})
	tg := targetOf(got, b.Slug)
	if tg.Status != branchOK || tg.Result.Items.Created != 1 {
		t.Fatalf("target = %+v; want ok with 1 new item", tg)
	}
	actions := map[string]string{}
	for _, r := range tg.Result.Rows {
		actions[r.Item] = r.Action
	}
	if actions["Mocha"] != "new" || actions["Latte"] != "unchanged" {
		t.Fatalf("row actions = %v; want Mocha new, Latte unchanged (its own price is kept)", actions)
	}
	if _, ok := b.itemPrice("Mocha"); ok {
		t.Fatal("dry run wrote to the target branch")
	}
}

func TestMenuSync_KeepsTargetPricesUnlessAsked(t *testing.T) {
	a, b := syncPair(t)
	cat := a.seedCategory("Coffee")
	a.seedMenuItem(cat, "Latte", 25000)
	a.seedMenuItem(cat, "Mocha", 30000)
	bcat := b.seedCategory("Coffee")
	b.seedMenuItem(bcat, "Latte", 28000)

	syncMenu(t, a, map[string]any{"targets": []string{b.Slug}})
	if p, ok := b.itemPrice("Mocha"); !ok || p != 30000 {
		t.Fatalf("new item in target: price=%d present=%v; want 30000", p, ok)
	}
	if p, _ := b.itemPrice("Latte"); p != 28000 {
		t.Fatalf("existing target price changed to %d without include_prices", p)
	}

	syncMenu(t, a, map[string]any{"targets": []string{b.Slug}, "include_prices": true})
	if p, _ := b.itemPrice("Latte"); p != 25000 {
		t.Fatalf("include_prices did not push the price: %d", p)
	}
	// Source untouched throughout.
	if p, _ := a.itemPrice("Latte"); p != 25000 {
		t.Fatalf("source price moved: %d", p)
	}
}

func TestMenuSync_NeverDeletesInTheTarget(t *testing.T) {
	a, b := syncPair(t)
	a.seedMenuItem(a.seedCategory("Coffee"), "Latte", 25000)
	b.seedMenuItem(b.seedCategory("Local"), "Thamel Special", 50000)
	syncMenu(t, a, map[string]any{"targets": []string{b.Slug}})
	if _, ok := b.itemPrice("Thamel Special"); !ok {
		t.Fatal("an item only the target has was removed")
	}
}

func TestMenuSync_RespectsEachTargetsPermissionsAndLock(t *testing.T) {
	a, b, c := newTenant(t), newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Gate Group", a, b, c)
	joinBranch(t, b, a.User, "waiter") // can't edit b's menu
	joinBranch(t, c, a.User, "owner")
	c.adminExec(`UPDATE tenants SET billing_state = 'write_locked' WHERE id = $1`, c.Tenant)
	a.seedMenuItem(a.seedCategory("Coffee"), "Latte", 25000)

	got := syncMenu(t, a, map[string]any{"targets": []string{b.Slug, c.Slug}})
	if s := targetOf(got, b.Slug).Status; s != branchDenied {
		t.Fatalf("waiter branch status = %q, want forbidden", s)
	}
	if s := targetOf(got, c.Slug).Status; s != "write_locked" {
		t.Fatalf("locked branch status = %q, want write_locked", s)
	}
	if _, ok := b.itemPrice("Latte"); ok {
		t.Fatal("synced into a branch the user can't edit")
	}
	if _, ok := c.itemPrice("Latte"); ok {
		t.Fatal("synced into a write-locked branch")
	}
}

func TestMenuSync_ForeignBranchIsNotFound(t *testing.T) {
	a, b := syncPair(t)
	other := newTenant(t) // not in the business
	a.seedMenuItem(a.seedCategory("Coffee"), "Latte", 25000)
	got := syncMenu(t, a, map[string]any{"targets": []string{other.Slug, b.Slug}})
	if s := targetOf(got, other.Slug).Status; s != branchNotFound {
		t.Fatalf("foreign target status = %q, want not_found", s)
	}
	if _, ok := other.itemPrice("Latte"); ok {
		t.Fatal("synced into a café outside the business")
	}
}

func TestMenuSync_FreeItemsAreReportedNotFatal(t *testing.T) {
	a, b := syncPair(t)
	cat := a.seedCategory("Coffee")
	a.seedMenuItem(cat, "Latte", 25000)
	a.seedMenuItem(cat, "Water", 0)
	got := syncMenu(t, a, map[string]any{"targets": []string{b.Slug}})
	if len(got.NotSynced) != 1 || got.NotSynced[0].Item != "Water" {
		t.Fatalf("not_synced = %+v; want Water", got.NotSynced)
	}
	if _, ok := b.itemPrice("Latte"); !ok {
		t.Fatal("one free item blocked the rest of the sync")
	}
}
