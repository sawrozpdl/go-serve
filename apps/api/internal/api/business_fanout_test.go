package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// seedBranchSale closes one paid cash order of `qty` × `price` in fx, inside an
// open shift so the drawer sees it.
func seedBranchSale(fx *fixture, qty int, price int64) {
	fx.t.Helper()
	var shift uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`SELECT id FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL`, fx.Tenant).Scan(&shift); err != nil {
		shift = fx.seedOpenShift(10000) // one open shift per café
	}
	cat := fx.seedCategory("Drinks " + uuid.NewString()[:4])
	item := fx.seedMenuItem(cat, "Latte", price)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, qty, price)
	fx.closeOrderWithTotals(order)
	var total int64
	fx.adminScan([]any{&total}, `SELECT total_cents FROM orders WHERE id = $1`, order)
	fx.seedPayment(order, "cash", total, &shift)
}

type fanDash = FanoutResponse[ReportsDashboard]
type fanBal = FanoutResponse[CafeBalance]

func businessDashboard(t *testing.T, anchor *fixture, query string) fanDash {
	t.Helper()
	var out fanDash
	callHandler(t, anchor, GetBusinessDashboard(appPool, rbac.NewRepo(nil, nil)), http.MethodGet,
		"/v1/business/reports/dashboard", nil, withQuery(query)).
		expectStatus(http.StatusOK).decode(&out)
	return out
}

func ownDashboard(t *testing.T, fx *fixture, actor uuid.UUID, query string) ReportsDashboard {
	t.Helper()
	var out ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/v1/reports/dashboard", nil, withQuery(query), actingAs(actor)).
		expectStatus(http.StatusOK).decode(&out)
	return out
}

func statusOf(sts []BranchStatus, slug string) string {
	for _, s := range sts {
		if s.Slug == slug {
			return s.Status
		}
	}
	return ""
}

// The headline invariant: the all-branches figure is exactly the sum of what
// each branch's own dashboard says. Nothing is re-derived.
func TestBusinessDashboard_TotalsEqualSumOfBranchDashboards(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Sum Group", a, b)
	joinBranch(t, b, a.User, "owner")
	seedBranchSale(a, 3, 25000)
	seedBranchSale(b, 2, 40000)
	seedBranchSale(b, 1, 9900)

	const q = "range=30d"
	got := businessDashboard(t, a, q)
	if !got.Complete || len(got.PerBranch) != 2 {
		t.Fatalf("complete=%v per_branch=%d branches=%+v", got.Complete, len(got.PerBranch), got.Branches)
	}
	da, db := ownDashboard(t, a, a.User, q), ownDashboard(t, b, a.User, q)
	if da.KPIs.SalesCents == 0 || db.KPIs.SalesCents == 0 {
		t.Fatal("a branch has no sales in the window — the sum check would prove nothing")
	}

	assertMoney(t, "sales", got.Totals.KPIs.SalesCents, da.KPIs.SalesCents+db.KPIs.SalesCents)
	assertMoney(t, "net", got.Totals.KPIs.NetCents, da.KPIs.NetCents+db.KPIs.NetCents)
	assertMoney(t, "tax", got.Totals.KPIs.TaxCents, da.KPIs.TaxCents+db.KPIs.TaxCents)
	assertMoney(t, "cash mix", got.Totals.PaymentMix.CashCents, da.PaymentMix.CashCents+db.PaymentMix.CashCents)
	if got.Totals.KPIs.OrderCount != 3 {
		t.Fatalf("orders = %d, want 3", got.Totals.KPIs.OrderCount)
	}
	// Average ticket is recomputed from the totals, not averaged across branches.
	assertMoney(t, "avg ticket", got.Totals.KPIs.AvgTicketCents, got.Totals.KPIs.SalesCents/3)

	var dailySum, ownDaily int64
	for _, d := range got.Totals.Daily {
		dailySum += d.SalesCents
	}
	for _, d := range append(da.Daily, db.Daily...) {
		ownDaily += d.SalesCents
	}
	assertMoney(t, "daily series", dailySum, ownDaily)
	if len(got.Totals.TopSellers) != 0 || len(got.Totals.TabBreakdown) != 0 {
		t.Fatal("top sellers / tab breakdowns must not be merged into the totals")
	}
}

func TestBusinessCafeBalance_TotalsEqualSumOfBranchBalances(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Balance Group", a, b)
	joinBranch(t, b, a.User, "owner")
	seedBranchSale(a, 1, 12000)
	seedBranchSale(b, 4, 5000)

	var got fanBal
	callHandler(t, a, GetBusinessCafeBalance(appPool, rbac.NewRepo(nil, nil)), http.MethodGet,
		"/v1/business/reports/cafe-balance", nil).expectStatus(http.StatusOK).decode(&got)

	var ba, bb CafeBalance
	callHandler(t, a, GetCafeBalance, http.MethodGet, "/v1/finance/cafe-balance", nil).expectStatus(http.StatusOK).decode(&ba)
	callHandler(t, b, GetCafeBalance, http.MethodGet, "/v1/finance/cafe-balance", nil, actingAs(a.User)).expectStatus(http.StatusOK).decode(&bb)

	assertMoney(t, "total", got.Totals.TotalCents, ba.TotalCents+bb.TotalCents)
	assertMoney(t, "drawer", got.Totals.DrawerCents, ba.DrawerCents+bb.DrawerCents)
	if got.Totals.DrawerCents == 0 {
		t.Fatal("seeded cash never reached a drawer — the test proves nothing")
	}
}

// A branch the caller can't read reports in contributes nothing, and says why.
func TestBusinessDashboard_HonoursEachBranchsOwnPermissions(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Perm Group", a, b)
	joinBranch(t, b, a.User, "waiter")
	seedBranchSale(a, 1, 10000)
	seedBranchSale(b, 1, 99900)

	got := businessDashboard(t, a, "range=30d")
	if statusOf(got.Branches, b.Slug) != branchDenied {
		t.Fatalf("waiter branch status = %q, want forbidden: %+v", statusOf(got.Branches, b.Slug), got.Branches)
	}
	if got.Complete || len(got.PerBranch) != 1 {
		t.Fatalf("complete=%v per_branch=%d; want incomplete with one branch", got.Complete, len(got.PerBranch))
	}
	da := ownDashboard(t, a, a.User, "range=30d")
	assertMoney(t, "sales excludes the forbidden branch", got.Totals.KPIs.SalesCents, da.KPIs.SalesCents)
}

// Naming a branch you don't belong to gets the same answer as naming one that
// doesn't exist — and none of its money.
func TestBusinessDashboard_UnknownOrForeignBranchIsNotFound(t *testing.T) {
	a, b, c := newTenant(t), newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Probe Group", a, b, c)
	joinBranch(t, b, a.User, "owner")
	seedBranchSale(c, 1, 77700)

	got := businessDashboard(t, a, "range=30d&branches="+c.Slug+",no-such-branch,"+b.Slug)
	if statusOf(got.Branches, c.Slug) != branchNotFound || statusOf(got.Branches, "no-such-branch") != branchNotFound {
		t.Fatalf("statuses = %+v; want not_found for both", got.Branches)
	}
	if len(got.PerBranch) != 1 || got.PerBranch[0].Slug != b.Slug {
		t.Fatalf("per_branch = %+v; want only %s", got.PerBranch, b.Slug)
	}
}

func TestBusinessDashboard_StandaloneCafeReturnsNothing(t *testing.T) {
	fx := newTenant(t)
	rbacSeedSystemRoles(t, fx)
	seedBranchSale(fx, 1, 5000)
	got := businessDashboard(t, fx, "range=30d")
	if got.Business != nil || len(got.PerBranch) != 0 || got.Totals.KPIs.SalesCents != 0 {
		t.Fatalf("standalone café got a consolidated answer: %+v", got)
	}
}

// The per-branch tx is read-only: a report that tried to write would fail
// instead of writing into a sibling branch.
func TestRunInBranch_TransactionIsReadOnly(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "RO Group", a, b)
	joinBranch(t, b, a.User, "owner")

	var writeErr error
	writer := func(w http.ResponseWriter, r *http.Request) {
		_, writeErr = appctx.Tx(r.Context()).Exec(r.Context(),
			`INSERT INTO menu_categories (tenant_id, name) VALUES ($1, 'sneaky')`, b.Tenant)
		w.WriteHeader(http.StatusOK)
	}
	callHandler(t, a, func(w http.ResponseWriter, r *http.Request) {
		_, branches, err := loadMyBusiness(r.Context(), appctx.Tx(r.Context()))
		if err != nil {
			t.Fatal(err)
		}
		for _, br := range branches {
			if br.TenantID == b.Tenant {
				if _, _, err := runInBranch(r, appPool, rbac.NewRepo(nil, nil), a.User, br,
					fanoutRoute{perm: "report:read", handler: writer}); err != nil {
					t.Fatal(err)
				}
			}
		}
		w.WriteHeader(http.StatusOK)
	}, http.MethodGet, "/x", nil).expectStatus(http.StatusOK)

	if writeErr == nil {
		t.Fatal("a write inside a fan-out branch succeeded")
	}
	var n int
	_ = adminPool.QueryRow(context.Background(), `SELECT count(*) FROM menu_categories WHERE tenant_id = $1 AND name = 'sneaky'`, b.Tenant).Scan(&n)
	if n != 0 {
		t.Fatal("the write landed")
	}
}

func TestMergeDashboards_RecomputesAverageAndSumsDays(t *testing.T) {
	got := mergeDashboards([]ReportsDashboard{
		{KPIs: DashboardKPIs{SalesCents: 1000, OrderCount: 1, AvgTicketCents: 1000}},
		{KPIs: DashboardKPIs{SalesCents: 3000, OrderCount: 3, AvgTicketCents: 1000}},
		{KPIs: DashboardKPIs{SalesCents: 6000, OrderCount: 1, AvgTicketCents: 6000}},
	})
	if got.KPIs.AvgTicketCents != 2000 { // 10000 / 5, not (1000+1000+6000)/3
		t.Fatalf("avg = %d, want 2000", got.KPIs.AvgTicketCents)
	}
	d := mergeDashboards([]ReportsDashboard{
		{Daily: []DailyPoint{{Day: "2026-10-02", SalesCents: 5}, {Day: "2026-10-01", SalesCents: 1}}},
		{Daily: []DailyPoint{{Day: "2026-10-01", SalesCents: 2}}},
	}).Daily
	if len(d) != 2 || d[0].Day != "2026-10-01" || d[0].SalesCents != 3 || d[1].SalesCents != 5 {
		t.Fatalf("daily = %+v", d)
	}
}
