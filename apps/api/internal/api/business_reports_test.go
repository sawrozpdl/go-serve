package api

import (
	"net/http"
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

func (fx *fixture) grantFeatures(keys ...string) {
	fx.t.Helper()
	fx.adminExec(`UPDATE tenants SET feature_overrides = jsonb_build_object('grant', to_jsonb($2::text[])) WHERE id = $1`, fx.Tenant, keys)
}

// reportPair: two branches, both selling a "Latte" in "Coffee" (as after a
// menu sync) plus one item only the second sells.
func reportPair(t *testing.T) (*fixture, *fixture) {
	t.Helper()
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Report Group", a, b)
	joinBranch(t, b, a.User, "owner")
	for _, fx := range []*fixture{a, b} {
		fx.grantFeatures("advanced_analytics", "profitability")
	}
	sell := func(fx *fixture, cat, item string, qty int, price int64) {
		c := fx.seedCategory(cat)
		i := fx.seedMenuItem(c, item, price)
		o := fx.seedOpenOrder(nil)
		fx.seedOrderItem(o, i, qty, price)
		fx.closeOrderPaidInFull(o)
	}
	sell(a, "Coffee", "Latte", 3, 25000)
	sell(b, "coffee", "latte", 2, 28000) // same names, different case + price
	sell(b, "Bakery", "Croissant", 4, 15000)
	return a, b
}

func TestBusinessMovers_MergesSameItemByName(t *testing.T) {
	a, _ := reportPair(t)
	var got FanoutResponse[MoversResp]
	callHandler(t, a, GetBusinessMovers(appPool, rbac.NewRepo(nil, nil)), http.MethodGet,
		"/v1/business/reports/movers", nil, withQuery("range=30d")).expectStatus(http.StatusOK).decode(&got)
	if !got.Complete {
		t.Fatalf("incomplete: %+v", got.Branches)
	}
	if got.Totals.Total != 2 {
		t.Fatalf("rows = %+v; want Latte merged + Croissant", got.Totals.Rows)
	}
	for _, r := range got.Totals.Rows {
		if r.Name == "Latte" && (r.Qty != 5 || r.RevenueCents != 3*25000+2*28000) {
			t.Fatalf("merged Latte = qty %v rev %d", r.Qty, r.RevenueCents)
		}
	}
	// Sorted by revenue desc: Latte (131000) before Croissant (60000).
	if got.Totals.Rows[0].Name != "Latte" {
		t.Fatalf("order = %+v", got.Totals.Rows)
	}
}

func TestBusinessCategoryMix_RevenueEqualsSumOfBranches(t *testing.T) {
	a, b := reportPair(t)
	var got FanoutResponse[CategoryMixResp]
	callHandler(t, a, GetBusinessCategoryMix(appPool, rbac.NewRepo(nil, nil)), http.MethodGet,
		"/v1/business/reports/category-mix", nil, withQuery("range=30d")).expectStatus(http.StatusOK).decode(&got)

	var own CategoryMixResp
	var ownSum int64
	for _, fx := range []*fixture{a, b} {
		callHandler(t, fx, GetCategoryMix, http.MethodGet, "/v1/reports/category-mix", nil, withQuery("range=30d"), actingAs(a.User)).
			expectStatus(http.StatusOK).decode(&own)
		for _, r := range own.Rows {
			ownSum += r.RevenueCents
		}
	}
	var sum int64
	var share float64
	for _, r := range got.Totals.Rows {
		sum += r.RevenueCents
		share += r.SharePct
	}
	if ownSum == 0 {
		t.Fatal("no revenue seeded — the check proves nothing")
	}
	assertMoney(t, "category revenue", sum, ownSum)
	if len(got.Totals.Rows) != 2 {
		t.Fatalf("categories = %+v; want Coffee merged + Bakery", got.Totals.Rows)
	}
	if share < 99.9 || share > 100.1 {
		t.Fatalf("shares sum to %v", share)
	}
}

func TestBusinessProfitability_NetProfitEqualsSumOfBranches(t *testing.T) {
	a, b := reportPair(t)
	a.adminExec(`INSERT INTO expenses (tenant_id, vendor, amount_cents, paid_at, recorded_by_user_id, paid_from, payment_method) VALUES ($1, 'Gas', 9000, now(), $2, 'bank', 'bank')`, a.Tenant, a.User)

	var got FanoutResponse[ProfitReport]
	callHandler(t, a, GetBusinessProfitability(appPool, rbac.NewRepo(nil, nil)), http.MethodGet,
		"/v1/business/reports/profitability", nil, withQuery("range=30d")).expectStatus(http.StatusOK).decode(&got)

	var pa, pb ProfitReport
	callHandler(t, a, GetProfitability, http.MethodGet, "/v1/reports/profitability", nil, withQuery("range=30d")).
		expectStatus(http.StatusOK).decode(&pa)
	callHandler(t, b, GetProfitability, http.MethodGet, "/v1/reports/profitability", nil, withQuery("range=30d"), actingAs(a.User)).
		expectStatus(http.StatusOK).decode(&pb)
	if pa.NetProfitCents == 0 || pb.NetProfitCents == 0 {
		t.Fatal("a branch has no profit figure — the check proves nothing")
	}
	assertMoney(t, "net profit", got.Totals.NetProfitCents, pa.NetProfitCents+pb.NetProfitCents)
	assertMoney(t, "net revenue", got.Totals.Totals.NetRevenueCents, pa.Totals.NetRevenueCents+pb.Totals.NetRevenueCents)
	assertMoney(t, "expenses", got.Totals.TotalExpensesCents, pa.TotalExpensesCents+pb.TotalExpensesCents)
}

// A branch whose plan lacks profitability is reported, and its money stays out.
func TestBusinessProfitability_PlanGateIsPerBranch(t *testing.T) {
	a, b := reportPair(t)
	b.adminExec(`UPDATE tenants SET feature_overrides = jsonb_build_object('revoke', jsonb_build_array('profitability')) WHERE id = $1`, b.Tenant)
	var got FanoutResponse[ProfitReport]
	callHandler(t, a, GetBusinessProfitability(appPool, rbac.NewRepo(nil, nil)), http.MethodGet,
		"/v1/business/reports/profitability", nil, withQuery("range=30d")).expectStatus(http.StatusOK).decode(&got)
	if statusOf(got.Branches, b.Slug) != branchUpgrade {
		t.Fatalf("status = %q; want plan_upgrade_required (%+v)", statusOf(got.Branches, b.Slug), got.Branches)
	}
	if len(got.PerBranch) != 1 {
		t.Fatalf("per_branch = %d, want 1", len(got.PerBranch))
	}
}

func TestMergeMovers_PagesAfterMerging(t *testing.T) {
	parts := []MoversResp{
		{Rows: []MoverRow{{Name: "A", RevenueCents: 10}, {Name: "B", RevenueCents: 5}}},
		{Rows: []MoverRow{{Name: "b", RevenueCents: 20}, {Name: "C", RevenueCents: 1}}},
	}
	got := mergeMovers(parts, false, false, 1, 0)
	if got.Total != 3 || len(got.Rows) != 1 || got.Rows[0].Name != "B" || got.Rows[0].RevenueCents != 25 {
		t.Fatalf("got %+v", got)
	}
	got = mergeMovers(parts, false, false, 10, 2)
	if len(got.Rows) != 1 || got.Rows[0].Name != "C" {
		t.Fatalf("page 2 = %+v", got.Rows)
	}
}
