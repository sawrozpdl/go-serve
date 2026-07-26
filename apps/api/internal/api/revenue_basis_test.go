package api

// The revenue-basis contract. Before this, "Sales" meant SUM(orders.total_cents)
// on the Dashboard and SUM(qty × unit_price) on Profitability, and for a
// VAT-exclusive cafe with a service charge the two differed by ~14% with nothing
// on screen to explain it. These tests pin the relationship between every
// revenue figure so the two can never drift apart again unnoticed.
//
// The identity under test, for any set of closed orders:
//
//	billed sales (dashboard sales_cents) = Σ total_cents
//	net revenue  (profitability)         = Σ (total_cents − tax_cents)
//	menu item sales                      = Σ qty × unit_price   (mix only)
//
// and, exactly: Σ category net revenue == period net revenue.

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// revSeedOrder builds a closed order with the given lines and an optional
// discount, closing it through the same arithmetic CloseOrder uses so the stored
// columns are production-shaped.
func revSeedOrder(fx *fixture, closedAt time.Time, discountCents int64,
	lines []struct {
		cat   uuid.UUID
		name  string
		qty   int
		price int64
	},
) uuid.UUID {
	fx.t.Helper()
	order := fx.seedOpenOrder(nil)
	for _, l := range lines {
		item := fx.seedMenuItem(l.cat, l.name, l.price)
		fx.seedOrderItem(order, item, l.qty, l.price)
	}
	if discountCents > 0 {
		fx.adminExec(`
			INSERT INTO order_adjustments
			  (tenant_id, order_id, type, amount_cents, reason, applied_by_user_id)
			VALUES ($1, $2, 'discount', $3, 'test', $4)`,
			fx.Tenant, order, discountCents, fx.User)
	}
	fx.closeOrderWithTotals(order)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, order, closedAt)
	return order
}

type revLine = struct {
	cat   uuid.UUID
	name  string
	qty   int
	price int64
}

// The worked example from the audit, run through the real handlers in all three
// VAT modes: 2 × Rs 250 + 1 × Rs 60, Rs 50 discount, 10% service charge.
func TestRevenueBasis_DashboardVsProfitability(t *testing.T) {
	// One order everywhere: 2 × Rs 250 + 1 × Rs 60 = 56000 item sales,
	// Rs 50 discount, 10% service (5600) → base 56600.
	cases := []struct {
		mode string
		// billed = what the guest pays; tax = the VAT inside it;
		// net = what the cafe earned (billed − VAT).
		wantBilled, wantTax, wantNet int64
		why                          string
	}{
		{"none", 56600, 0, 56600,
			"no VAT: the cafe keeps the whole base, discount already deducted"},
		{"inclusive", 56600, 6512, 50088,
			"VAT is carved OUT of the menu price, so the cafe earns base − VAT"},
		{"exclusive", 63958, 7358, 56600,
			"VAT is added ON TOP, so the cafe earns the base and remits the rest"},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			fx := newTenant(t)
			fx.setTenantRates("10.00", "13.00")
			fx.setTenantVat(c.mode, "13.00")

			cat := fx.seedCategory("Mains")
			at := pastUTC(2)
			revSeedOrder(fx, at, 5000, []revLine{
				{cat, "Momo-" + c.mode, 2, 25000},
				{cat, "Tea-" + c.mode, 1, 6000},
			})

			day := localDay(t, at)
			q := "range=custom&from=" + day + "&to=" + day

			var dash ReportsDashboard
			callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
				withQuery(q)).expectStatus(http.StatusOK).decode(&dash)
			var prof ProfitReport
			callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
				withQuery(q)).expectStatus(http.StatusOK).decode(&prof)

			// Billed sales: what the guest was charged, VAT and service included.
			if dash.KPIs.SalesCents != c.wantBilled {
				t.Fatalf("dashboard sales_cents = %d, want %d", dash.KPIs.SalesCents, c.wantBilled)
			}
			if dash.KPIs.TaxCents != c.wantTax {
				t.Fatalf("tax_cents = %d, want %d", dash.KPIs.TaxCents, c.wantTax)
			}
			// Net revenue: billed minus the VAT liability. THE profit basis.
			wantNet := c.wantNet
			if wantNet != c.wantBilled-c.wantTax {
				t.Fatalf("case is inconsistent: net %d != billed %d − tax %d",
					wantNet, c.wantBilled, c.wantTax)
			}
			if prof.Totals.NetRevenueCents != wantNet {
				t.Fatalf("profitability net_revenue_cents = %d, want %d (billed %d − VAT %d)",
					prof.Totals.NetRevenueCents, wantNet, c.wantBilled, c.wantTax)
			}
			// Menu item sales are unchanged by discounts and VAT mode — which is
			// exactly why they must never be labelled revenue.
			if prof.Totals.ItemSalesCents != 56000 {
				t.Fatalf("item_sales_cents = %d, want 56000", prof.Totals.ItemSalesCents)
			}
			// The discount is really deducted and the service charge really counted:
			// in none/exclusive mode the cafe earns exactly item sales − discount +
			// service; in inclusive mode that figure less the embedded VAT. (%s)
			base := int64(56000 - 5000 + 5600)
			earned := base
			if c.mode == "inclusive" {
				earned = base - c.wantTax
			}
			if wantNet != earned {
				t.Fatalf("net revenue %d != item sales − discount + service (%d): %s",
					wantNet, earned, c.why)
			}
			// Net profit is computed on net revenue, never on item sales.
			if prof.NetProfitCents != wantNet-prof.TotalExpensesCents-prof.TransferFeesCents {
				t.Fatalf("net_profit_cents = %d, want %d",
					prof.NetProfitCents, wantNet-prof.TotalExpensesCents)
			}
		})
	}
}

// Per-category net revenue must sum to the period's net revenue EXACTLY. This is
// the allocation guarantee: each order's discount / service / VAT is spread
// across its categories, and the paisa left over by integer division has to land
// somewhere rather than vanish.
func TestRevenueBasis_CategoryRowsSumToTotal(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("10.00", "13.00")
	fx.setTenantVat("exclusive", "13.00")

	food := fx.seedCategory("Food")
	drink := fx.seedCategory("Drink")
	at := pastUTC(3)

	// Deliberately awkward numbers: prices that don't divide evenly, a discount
	// that has to be split across two categories, three orders of different shapes.
	revSeedOrder(fx, at, 333, []revLine{
		{food, "Thali", 1, 1777},
		{drink, "Chiya", 3, 111},
	})
	revSeedOrder(fx, at, 0, []revLine{
		{drink, "Coffee", 1, 999},
	})
	revSeedOrder(fx, at, 101, []revLine{
		{food, "Sekuwa", 2, 707},
		{drink, "Lassi", 1, 303},
	})

	day := localDay(t, at)
	q := "range=custom&from=" + day + "&to=" + day

	var dash ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&dash)
	var prof ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&prof)

	periodNet := dash.KPIs.SalesCents - dash.KPIs.TaxCents
	var summed int64
	for _, c := range prof.Categories {
		summed += c.NetRevenueCents
	}
	if summed != periodNet {
		t.Fatalf("category rows sum to %d but the period's net revenue is %d — "+
			"the allocation lost or invented %d paisa", summed, periodNet, summed-periodNet)
	}
	if prof.Totals.NetRevenueCents != periodNet {
		t.Fatalf("totals row = %d, want %d", prof.Totals.NetRevenueCents, periodNet)
	}
}

// Half portions are the pathological case: qty is numeric(6,2), so a line can
// carry a half paisa and per-group rounding drifts. The allocation must still
// land exactly on the order total.
func TestRevenueBasis_HalfPortionsStillSumExactly(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("inclusive", "13.00")
	food := fx.seedCategory("Halves")
	drink := fx.seedCategory("Halves2")

	order := fx.seedOpenOrder(nil)
	// Odd prices at half quantity: 0.5 × 333 = 166.5 paisa each.
	i1 := fx.seedMenuItem(food, "HalfPlate", 333)
	i2 := fx.seedMenuItem(drink, "HalfGlass", 333)
	fx.adminExec(`UPDATE menu_items SET allow_half = true WHERE id IN ($1, $2)`, i1, i2)
	fx.adminExec(`
		INSERT INTO order_items (tenant_id, order_id, menu_item_id, qty, unit_price_cents,
		                         unit_cost_cents)
		VALUES ($1, $2, $3, 0.5, 333, 0), ($1, $2, $4, 0.5, 333, 0)`,
		fx.Tenant, order, i1, i2)
	fx.closeOrderWithTotals(order)
	at := pastUTC(2)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, order, at)

	day := localDay(t, at)
	q := "range=custom&from=" + day + "&to=" + day

	var dash ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&dash)
	var prof ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&prof)

	periodNet := dash.KPIs.SalesCents - dash.KPIs.TaxCents
	var summed int64
	for _, c := range prof.Categories {
		summed += c.NetRevenueCents
	}
	if summed != periodNet {
		t.Fatalf("half-portion allocation summed to %d, want %d", summed, periodNet)
	}
}

// A drill-down must equal the row the user clicked — same shares, same tie-break.
func TestRevenueBasis_DrilldownMatchesItsRow(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("10.00", "13.00")
	fx.setTenantVat("exclusive", "13.00")
	food := fx.seedCategory("DrillFood")
	drink := fx.seedCategory("DrillDrink")
	at := pastUTC(4)
	revSeedOrder(fx, at, 777, []revLine{
		{food, "Biryani", 1, 4321},
		{drink, "Nimbu", 2, 234},
	})

	day := localDay(t, at)
	q := "range=custom&from=" + day + "&to=" + day
	var prof ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&prof)

	for _, row := range prof.Categories {
		if row.MenuCategoryID == nil || row.NetRevenueCents == 0 {
			continue
		}
		var dd ProfitDrilldown
		callHandler(t, fx, GetProfitabilityDrilldown, http.MethodGet, "/", nil,
			withParam("categoryId", row.MenuCategoryID.String()),
			withQuery(q)).expectStatus(http.StatusOK).decode(&dd)
		if dd.Category.NetRevenueCents != row.NetRevenueCents {
			t.Fatalf("%s: drilldown net revenue = %d but the report row says %d",
				row.Name, dd.Category.NetRevenueCents, row.NetRevenueCents)
		}
		if dd.Category.ItemSalesCents != row.ItemSalesCents {
			t.Fatalf("%s: drilldown item sales = %d but the report row says %d",
				row.Name, dd.Category.ItemSalesCents, row.ItemSalesCents)
		}
	}
}

// Transfer fees are money out that never reaches the `expenses` table. Profit
// used to ignore them entirely while the account balances (correctly) did not.
func TestRevenueBasis_NetProfitCountsTransferFees(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(50000)
	cat := fx.seedCategory("FeeCat")
	at := pastUTC(1)
	revSeedOrder(fx, at, 0, []revLine{{cat, "Plate", 1, 10000}})

	callHandler(t, fx, CreateTransfer, http.MethodPost, "/",
		map[string]any{
			"from_method": "cash", "to_method": "bank",
			"amount_cents": 5000, "fee_cents": 120,
		}).expectStatus(http.StatusCreated)

	day := localDay(t, at)
	var prof ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=custom&from="+day+"&to="+day)).
		expectStatus(http.StatusOK).decode(&prof)

	if prof.TransferFeesCents != 120 {
		t.Fatalf("transfer_fees_cents = %d, want 120", prof.TransferFeesCents)
	}
	want := prof.Totals.NetRevenueCents - prof.TotalExpensesCents - 120
	if prof.NetProfitCents != want {
		t.Fatalf("net_profit_cents = %d, want %d (fees on the cost side)",
			prof.NetProfitCents, want)
	}
}

// The Owners page and the Reports page must agree on lifetime revenue and on
// what "net profit" means. They used to use different bases AND different
// formulas — cafe-summary subtracted direct COGS on top of expenses, which the
// profitability policy explicitly forbids as double-counting inventory.
func TestRevenueBasis_CafeSummaryAgreesWithProfitability(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("10.00", "13.00")
	fx.setTenantVat("exclusive", "13.00")
	cat := fx.seedCategory("SummaryCat")
	at := pastUTC(5)
	order := revSeedOrder(fx, at, 1000, []revLine{{cat, "Set", 2, 3000}})
	// Give the item a direct cost so the double-count would show up.
	fx.adminExec(`UPDATE order_items SET unit_cost_cents = 900 WHERE order_id = $1`, order)

	var s CafeSummary
	callHandler(t, fx, GetCafeSummary, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).decode(&s)

	// Lifetime revenue is net revenue for every closed order.
	var wantNet int64
	// NOTE: adminScan runs on the superuser pool, which bypasses RLS — the
	// tenant filter has to be explicit or this sums every tenant in the database.
	fx.adminScan([]any{&wantNet},
		`SELECT COALESCE(SUM(total_cents - tax_cents), 0)::bigint FROM orders
		 WHERE status = 'closed' AND tenant_id = $1`, fx.Tenant)
	if s.LifetimeRevenueCents != wantNet {
		t.Fatalf("lifetime_revenue_cents = %d, want %d (net revenue)", s.LifetimeRevenueCents, wantNet)
	}
	// Direct COGS is reported but NOT subtracted — the stock is already an expense.
	if s.LifetimeDirectCogsCents != 1800 {
		t.Fatalf("lifetime_direct_cogs_cents = %d, want 1800", s.LifetimeDirectCogsCents)
	}
	want := s.LifetimeRevenueCents - s.LifetimeExpensesCents - s.LifetimeTransferFeesCents
	if s.CafeNetProfitCents != want {
		t.Fatalf("cafe_net_profit_cents = %d, want %d — direct COGS must not be subtracted again",
			s.CafeNetProfitCents, want)
	}

	// And it matches the Profitability report over an all-time window.
	var prof ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=all")).expectStatus(http.StatusOK).decode(&prof)
	if prof.Totals.NetRevenueCents != s.LifetimeRevenueCents {
		t.Fatalf("profitability net revenue %d != cafe-summary lifetime revenue %d",
			prof.Totals.NetRevenueCents, s.LifetimeRevenueCents)
	}
}

// A soft-deleted category still carries the revenue it earned. Dropping it would
// silently remove real money from the totals and from net profit.
func TestRevenueBasis_SoftDeletedCategoryKeepsItsHistory(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Retired")
	at := pastUTC(6)
	revSeedOrder(fx, at, 0, []revLine{{cat, "OldFavourite", 1, 4000}})

	day := localDay(t, at)
	q := "range=custom&from=" + day + "&to=" + day
	var before ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&before)

	// Retire the category (and its items, as DeleteMenuCategory requires).
	fx.adminExec(`UPDATE menu_items SET deleted_at = now() WHERE category_id = $1`, cat)
	fx.adminExec(`UPDATE menu_categories SET deleted_at = now() WHERE id = $1`, cat)

	var after ProfitReport
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery(q)).expectStatus(http.StatusOK).decode(&after)

	if after.Totals.NetRevenueCents != before.Totals.NetRevenueCents {
		t.Fatalf("net revenue changed from %d to %d after retiring the category — "+
			"history must not move", before.Totals.NetRevenueCents, after.Totals.NetRevenueCents)
	}
	found := false
	for _, c := range after.Categories {
		if c.Name == "Retired" && c.NetRevenueCents > 0 {
			found = true
		}
	}
	if !found {
		t.Fatal("the retired category's historical revenue disappeared from the report")
	}
}
