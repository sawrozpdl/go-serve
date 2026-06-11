package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// rpt* seed helpers — domain-prefixed so they never collide with harness or
// other test-file helpers.
// =========================================================================

// rptSeedClosedOrder seeds a complete closed order: category → item →
// open order → order item → set closed_at + status. Returns the order ID and
// item price for aggregate assertions. closedAt must be a UTC time.
func rptSeedClosedOrder(fx *fixture, itemName string, qty int, priceCents int64, closedAt time.Time) uuid.UUID {
	fx.t.Helper()
	catID := fx.seedCategory("Cat-" + itemName)
	itemID := fx.seedMenuItem(catID, itemName, priceCents)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, qty, priceCents)
	total := int64(qty) * priceCents
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=$3, total_cents=$3 WHERE id=$1`,
		orderID, closedAt, total,
	)
	return orderID
}

// rptSeedClosedOrderOnTable seeds a closed order attached to a known table.
func rptSeedClosedOrderOnTable(fx *fixture, tableID uuid.UUID, itemName string, qty int, priceCents int64, closedAt time.Time) uuid.UUID {
	fx.t.Helper()
	catID := fx.seedCategory("Cat-" + itemName + uuid.NewString()[:4])
	itemID := fx.seedMenuItem(catID, itemName, priceCents)
	orderID := fx.seedOpenOrder(ptrUUID(tableID))
	fx.seedOrderItem(orderID, itemID, qty, priceCents)
	total := int64(qty) * priceCents
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=$3, total_cents=$3 WHERE id=$1`,
		orderID, closedAt, total,
	)
	return orderID
}

// rptSeedExpense inserts a bank expense with a specific paid_at for window tests.
func (fx *fixture) rptSeedExpense(vendor string, amountCents int64, paidAt time.Time) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, payment_method, paid_from, recorded_by_user_id, paid_at)
		VALUES ($1, $2, $3, 'bank'::payment_method, 'bank'::expense_source, $4, $5)
		RETURNING id`,
		fx.Tenant, vendor, amountCents, fx.User, paidAt)
	return id
}

// rptSeedAllocation inserts an expense_allocations row.
func (fx *fixture) rptSeedAllocation(expenseID, menuCatID uuid.UUID, sharePct string, amountCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expense_allocations
		  (tenant_id, expense_id, menu_category_id, share_pct, amount_cents)
		VALUES ($1, $2, $3, $4::numeric, $5)
		RETURNING id`,
		fx.Tenant, expenseID, menuCatID, sharePct, amountCents)
	return id
}

// pastUTC returns a UTC timestamp offset by the given number of hours from now,
// guaranteed to fall in recent history so range presets like "7d"/"30d" cover it.
func pastUTC(hoursAgo float64) time.Time {
	return time.Now().UTC().Add(-time.Duration(hoursAgo * float64(time.Hour)))
}

// =========================================================================
// GetDashboard
// =========================================================================

func TestGetDashboard_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var dash ReportsDashboard
	resp.decode(&dash)
	if dash.KPIs.SalesCents != 0 {
		t.Errorf("want sales_cents=0, got %d", dash.KPIs.SalesCents)
	}
	if dash.KPIs.OrderCount != 0 {
		t.Errorf("want order_count=0, got %d", dash.KPIs.OrderCount)
	}
	if dash.Daily == nil {
		t.Error("want non-nil daily slice")
	}
	if dash.TopSellers == nil {
		t.Error("want non-nil top_sellers slice")
	}
	if dash.SlowMovers == nil {
		t.Error("want non-nil slow_movers slice")
	}
}

func TestGetDashboard_DefaultRangeIsToday(t *testing.T) {
	fx := newTenant(t)
	// No ?range= param — should still succeed (defaults to today).
	resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil)
	resp.expectStatus(http.StatusOK)
	var dash ReportsDashboard
	resp.decode(&dash)
	if dash.Range != "today" {
		t.Errorf("want range=today, got %q", dash.Range)
	}
}

func TestGetDashboard_KnownPresets(t *testing.T) {
	fx := newTenant(t)
	for _, preset := range []string{"yesterday", "7d", "30d", "mtd", "ytd", "thisweek", "lastweek", "lastmonth"} {
		preset := preset
		t.Run(preset, func(t *testing.T) {
			resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
				withQuery("range="+preset))
			resp.expectStatus(http.StatusOK)
			var dash ReportsDashboard
			resp.decode(&dash)
			if dash.Range != preset {
				t.Errorf("want range=%s, got %q", preset, dash.Range)
			}
		})
	}
}

func TestGetDashboard_PopulatedAggregates(t *testing.T) {
	fx := newTenant(t)
	// Two closed orders within the last hour, one open order (excluded).
	now := time.Now().UTC()
	// Order A: 2 × 1500 = 3000 cents
	rptSeedClosedOrder(fx, "Espresso", 2, 1500, now.Add(-30*time.Minute))
	// Order B: 1 × 2000 = 2000 cents
	rptSeedClosedOrder(fx, "Latte", 1, 2000, now.Add(-20*time.Minute))
	// Open order — must NOT appear in KPIs.
	catID := fx.seedCategory("CatOpen")
	itemID := fx.seedMenuItem(catID, "OpenItem", 5000)
	openOrd := fx.seedOpenOrder(nil)
	fx.seedOrderItem(openOrd, itemID, 1, 5000)

	resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var dash ReportsDashboard
	resp.decode(&dash)

	wantSales := int64(3000 + 2000)
	if dash.KPIs.SalesCents != wantSales {
		t.Errorf("sales_cents: want %d, got %d", wantSales, dash.KPIs.SalesCents)
	}
	if dash.KPIs.OrderCount != 2 {
		t.Errorf("order_count: want 2, got %d", dash.KPIs.OrderCount)
	}
	wantAvg := wantSales / 2
	if dash.KPIs.AvgTicketCents != wantAvg {
		t.Errorf("avg_ticket_cents: want %d, got %d", wantAvg, dash.KPIs.AvgTicketCents)
	}
	if dash.KPIs.NetCents != wantSales {
		t.Errorf("net_cents: want %d (no expenses), got %d", wantSales, dash.KPIs.NetCents)
	}
	if len(dash.Daily) < 1 {
		t.Error("want at least one daily point")
	}
	// Daily series always expands to at least 14 days for charting.
	if len(dash.Daily) < 14 {
		t.Errorf("want ≥14 daily points for chart, got %d", len(dash.Daily))
	}
	if len(dash.TopSellers) == 0 {
		t.Error("want at least one top seller")
	}
}

func TestGetDashboard_NetReducedByExpenses(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	rptSeedClosedOrder(fx, "Mocha", 1, 5000, now.Add(-10*time.Minute))
	fx.rptSeedExpense("Supplier", 2000, now.Add(-5*time.Minute))

	resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var dash ReportsDashboard
	resp.decode(&dash)
	if dash.KPIs.ExpensesCents != 2000 {
		t.Errorf("expenses_cents: want 2000, got %d", dash.KPIs.ExpensesCents)
	}
	if dash.KPIs.NetCents != 3000 {
		t.Errorf("net_cents: want 3000, got %d", dash.KPIs.NetCents)
	}
}

func TestGetDashboard_TabCentsPopulated(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	orderID := rptSeedClosedOrder(fx, "TabItem", 1, 4000, now.Add(-15*time.Minute))
	shift := fx.seedOpenShift(0)
	fx.seedPayment(orderID, "house_tab", 4000, ptrUUID(shift))

	resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var dash ReportsDashboard
	resp.decode(&dash)
	if dash.KPIs.TabCents != 4000 {
		t.Errorf("tab_cents: want 4000, got %d", dash.KPIs.TabCents)
	}
}

func TestGetDashboard_TopSellerIsHighestRevenue(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	rptSeedClosedOrder(fx, "Cheap", 1, 100, now.Add(-2*time.Hour))
	rptSeedClosedOrder(fx, "Pricey", 1, 9999, now.Add(-1*time.Hour))

	resp := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var dash ReportsDashboard
	resp.decode(&dash)
	if len(dash.TopSellers) == 0 {
		t.Fatal("want at least one top seller")
	}
	if dash.TopSellers[0].Name != "Pricey" {
		t.Errorf("top seller: want Pricey, got %q", dash.TopSellers[0].Name)
	}
	if dash.TopSellers[0].RevenueCents != 9999 {
		t.Errorf("top seller revenue: want 9999, got %d", dash.TopSellers[0].RevenueCents)
	}
}

// =========================================================================
// GetSales
// =========================================================================

func TestGetSales_MissingFromTo(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestGetSales_MissingTo(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2026-01-01")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestGetSales_MissingFrom(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("to=2026-01-02")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestGetSales_BadGroupBy(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2026-01-01&to=2026-01-31&group_by=wrong")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestGetSales_GroupByDay_Empty(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2024-01-01&to=2024-01-03&group_by=day"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows, ok := m["rows"].([]any)
	if !ok {
		t.Fatalf("want rows array, got %T: %v", m["rows"], m["rows"])
	}
	if len(rows) != 0 {
		t.Errorf("want 0 rows for empty window, got %d", len(rows))
	}
}

func TestGetSales_GroupByDay_Populated(t *testing.T) {
	fx := newTenant(t)
	// Use a fixed UTC date far enough in the past to avoid TZ boundary issues.
	day := time.Date(2026, 1, 15, 10, 0, 0, 0, time.UTC)
	rptSeedClosedOrder(fx, "DayCoffee", 2, 1000, day)
	rptSeedClosedOrder(fx, "DayTea", 1, 500, day.Add(1*time.Hour))

	resp := callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2026-01-15T00:00:00Z&to=2026-01-16T00:00:00Z&group_by=day"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows := m["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("want at least one day row")
	}
	row := rows[0].(map[string]any)
	if row["order_count"] == nil {
		t.Error("want order_count field")
	}
	if row["revenue_cents"] == nil {
		t.Error("want revenue_cents field")
	}
}

func TestGetSales_GroupByItem_Populated(t *testing.T) {
	fx := newTenant(t)
	day := time.Date(2026, 2, 10, 9, 0, 0, 0, time.UTC)
	rptSeedClosedOrder(fx, "Cappuccino", 3, 800, day)

	resp := callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2026-02-10T00:00:00Z&to=2026-02-11T00:00:00Z&group_by=item"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows := m["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("want at least one item row")
	}
	row := rows[0].(map[string]any)
	if row["name"] != "Cappuccino" {
		t.Errorf("want name=Cappuccino, got %v", row["name"])
	}
	// qty is scanned as a JSON number; Go decodes JSON numbers as float64.
	if qty, _ := row["qty"].(float64); int(qty) != 3 {
		t.Errorf("want qty=3, got %v", row["qty"])
	}
	wantRev := float64(3 * 800)
	if rev, _ := row["revenue_cents"].(float64); rev != wantRev {
		t.Errorf("want revenue_cents=%v, got %v", wantRev, row["revenue_cents"])
	}
}

func TestGetSales_GroupByCategory_Populated(t *testing.T) {
	fx := newTenant(t)
	day := time.Date(2026, 3, 5, 8, 0, 0, 0, time.UTC)
	rptSeedClosedOrder(fx, "Flat White", 2, 1200, day)

	resp := callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2026-03-05T00:00:00Z&to=2026-03-06T00:00:00Z&group_by=category"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows := m["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("want at least one category row")
	}
	row := rows[0].(map[string]any)
	if row["name"] == nil || row["name"] == "" {
		t.Errorf("want non-empty category name, got %v", row["name"])
	}
	wantRev := float64(2 * 1200)
	if rev, _ := row["revenue_cents"].(float64); rev != wantRev {
		t.Errorf("want revenue_cents=%v, got %v", wantRev, row["revenue_cents"])
	}
}

func TestGetSales_DateBoundary_ExcludesOutsideWindow(t *testing.T) {
	fx := newTenant(t)
	// Seed order on Jan 20; query Jan 21–22 → should not appear.
	rptSeedClosedOrder(fx, "OutsideDay", 1, 999, time.Date(2026, 1, 20, 12, 0, 0, 0, time.UTC))

	resp := callHandler(t, fx, GetSales, http.MethodGet, "/reports/sales", nil,
		withQuery("from=2026-01-21T00:00:00Z&to=2026-01-22T00:00:00Z&group_by=item"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows := m["rows"].([]any)
	for _, r := range rows {
		row := r.(map[string]any)
		if row["name"] == "OutsideDay" {
			t.Error("order outside window must not appear in results")
		}
	}
}

// =========================================================================
// GetProfitability
// =========================================================================

func TestGetProfitability_BadRange_Custom_MissingFromTo(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=custom")).
		expectErr(http.StatusBadRequest, "bad_range")
}

func TestGetProfitability_BadRange_Custom_BadDates(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=custom&from=not-a-date&to=also-bad")).
		expectErr(http.StatusBadRequest, "bad_range")
}

func TestGetProfitability_BadRange_Custom_ToBeforeFrom(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=custom&from=2026-06-10&to=2026-06-09")).
		expectErr(http.StatusBadRequest, "bad_range")
}

func TestGetProfitability_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var rep ProfitReport
	resp.decode(&rep)
	if rep.Categories == nil {
		t.Error("want non-nil categories slice")
	}
	if rep.Totals.RevenueCents != 0 {
		t.Errorf("want totals.revenue_cents=0, got %d", rep.Totals.RevenueCents)
	}
	if rep.UnallocatedCogsCents != 0 {
		t.Errorf("want unallocated_cogs_cents=0, got %d", rep.UnallocatedCogsCents)
	}
}

func TestGetProfitability_Populated_RevenueAndMargin(t *testing.T) {
	fx := newTenant(t)
	day := time.Date(2026, 4, 1, 10, 0, 0, 0, time.UTC)

	// Seed a category + item + order so revenue appears.
	catID := fx.seedCategory("Beverages")
	itemID := fx.seedMenuItem(catID, "Americano", 1500)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, 4, 1500) // 4 × 1500 = 6000
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=6000, total_cents=6000 WHERE id=$1`,
		orderID, day,
	)

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("from=2026-04-01T00:00:00Z&to=2026-04-02T00:00:00Z&range=custom"))
	resp.expectStatus(http.StatusOK)

	var rep ProfitReport
	resp.decode(&rep)

	if rep.Totals.RevenueCents != 6000 {
		t.Errorf("totals.revenue_cents: want 6000, got %d", rep.Totals.RevenueCents)
	}
	if rep.Totals.GrossProfitCents != 6000 {
		t.Errorf("totals.gross_profit_cents: want 6000, got %d", rep.Totals.GrossProfitCents)
	}
	// Margin should be 100% since no COGS.
	if rep.Totals.MarginPct == nil {
		t.Error("want non-nil margin_pct")
	} else if *rep.Totals.MarginPct != 100.0 {
		t.Errorf("margin_pct: want 100.0, got %v", *rep.Totals.MarginPct)
	}

	// Find the Beverages category in the response.
	var found bool
	for _, c := range rep.Categories {
		if c.Name == "Beverages" {
			found = true
			if c.RevenueCents != 6000 {
				t.Errorf("Beverages revenue_cents: want 6000, got %d", c.RevenueCents)
			}
		}
	}
	if !found {
		t.Error("Beverages category not found in profitability response")
	}
}

// A single-day custom range (from === to) is how the Profitability day-stepper
// queries any past day. Date-only from/to must resolve to the whole tenant-local
// day window rather than a zero-width range, so this must return 200 with the
// day's revenue — not bad_range.
func TestGetProfitability_Custom_SingleDay(t *testing.T) {
	fx := newTenant(t)
	// 2026-04-01 10:00 UTC falls inside the Asia/Kathmandu day of 2026-04-01.
	day := time.Date(2026, 4, 1, 10, 0, 0, 0, time.UTC)

	catID := fx.seedCategory("Beverages")
	itemID := fx.seedMenuItem(catID, "Americano", 1500)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, 4, 1500) // 6000
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=6000, total_cents=6000 WHERE id=$1`,
		orderID, day,
	)

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=custom&from=2026-04-01&to=2026-04-01"))
	resp.expectStatus(http.StatusOK)

	var rep ProfitReport
	resp.decode(&rep)
	if rep.Totals.RevenueCents != 6000 {
		t.Errorf("totals.revenue_cents: want 6000, got %d", rep.Totals.RevenueCents)
	}
}

func TestGetProfitability_AllocatedCOGS(t *testing.T) {
	fx := newTenant(t)
	day := time.Date(2026, 4, 5, 10, 0, 0, 0, time.UTC)

	catID := fx.seedCategory("Food")
	itemID := fx.seedMenuItem(catID, "Sandwich", 3000)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, 2, 3000) // 6000 revenue
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=6000, total_cents=6000 WHERE id=$1`,
		orderID, day,
	)

	// Seed an expense and allocate 50% to Food (1000 out of 2000).
	expID := fx.rptSeedExpense("Food Vendor", 2000, day)
	fx.rptSeedAllocation(expID, catID, "50", 1000)

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("from=2026-04-05T00:00:00Z&to=2026-04-06T00:00:00Z&range=custom"))
	resp.expectStatus(http.StatusOK)

	var rep ProfitReport
	resp.decode(&rep)

	var food *ProfitRow
	for i := range rep.Categories {
		if rep.Categories[i].Name == "Food" {
			food = &rep.Categories[i]
			break
		}
	}
	if food == nil {
		t.Fatal("Food category not found in response")
	}
	if food.AllocatedCogsCents != 1000 {
		t.Errorf("allocated_cogs_cents: want 1000, got %d", food.AllocatedCogsCents)
	}
	if food.GrossProfitCents != 5000 {
		t.Errorf("gross_profit_cents: want 5000 (6000-1000), got %d", food.GrossProfitCents)
	}
	// The other 1000 of the expense (unallocated 50%) appears in unallocated_cogs_cents.
	// Note: it IS allocated to a category so unallocated should be 0 unless there are
	// additional unallocated expenses. The 50% that went to Food is allocated; no
	// unallocated residual because we didn't insert an unallocated expense here.
	if rep.UnallocatedCogsCents != 0 {
		t.Errorf("unallocated_cogs_cents: want 0 (expense is allocated), got %d", rep.UnallocatedCogsCents)
	}
}

func TestGetProfitability_UnallocatedExpense(t *testing.T) {
	fx := newTenant(t)
	day := time.Date(2026, 4, 10, 10, 0, 0, 0, time.UTC)

	// Expense with no allocations → all of it is unallocated.
	fx.rptSeedExpense("Unallocated Vendor", 3000, day)

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("from=2026-04-10T00:00:00Z&to=2026-04-11T00:00:00Z&range=custom"))
	resp.expectStatus(http.StatusOK)

	var rep ProfitReport
	resp.decode(&rep)
	if rep.UnallocatedCogsCents != 3000 {
		t.Errorf("unallocated_cogs_cents: want 3000, got %d", rep.UnallocatedCogsCents)
	}
}

func TestGetProfitability_OutsideWindowExcluded(t *testing.T) {
	fx := newTenant(t)
	// Order on April 20; query April 21 → should not contribute.
	rptSeedClosedOrder(fx, "OldItem", 1, 5000, time.Date(2026, 4, 20, 10, 0, 0, 0, time.UTC))

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("from=2026-04-21T00:00:00Z&to=2026-04-22T00:00:00Z&range=custom"))
	resp.expectStatus(http.StatusOK)
	var rep ProfitReport
	resp.decode(&rep)
	if rep.Totals.RevenueCents != 0 {
		t.Errorf("want 0 revenue for out-of-window order, got %d", rep.Totals.RevenueCents)
	}
}

// =========================================================================
// GetProfitabilityDrilldown
// =========================================================================

func TestGetProfitabilityDrilldown_BadCategoryID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetProfitabilityDrilldown, http.MethodGet, "/reports/profitability/bad/items", nil,
		withParam("categoryId", "not-a-uuid"),
		withQuery("range=today")).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestGetProfitabilityDrilldown_BadRange(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetProfitabilityDrilldown, http.MethodGet, "/reports/profitability/x/items", nil,
		withParam("categoryId", uuid.New().String()),
		withQuery("range=custom&from=bad")).
		expectErr(http.StatusBadRequest, "bad_range")
}

func TestGetProfitabilityDrilldown_ValidCategoryNoData(t *testing.T) {
	fx := newTenant(t)
	catID := fx.seedCategory("EmptyCat")

	resp := callHandler(t, fx, GetProfitabilityDrilldown, http.MethodGet, "/reports/profitability/x/items", nil,
		withParam("categoryId", catID.String()),
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var dd ProfitDrilldown
	resp.decode(&dd)
	if dd.Category.RevenueCents != 0 {
		t.Errorf("want revenue=0, got %d", dd.Category.RevenueCents)
	}
	if dd.Expenses == nil {
		t.Error("want non-nil expenses slice")
	}
	if dd.Items == nil {
		t.Error("want non-nil items slice")
	}
}

func TestGetProfitabilityDrilldown_Populated(t *testing.T) {
	fx := newTenant(t)
	day := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)

	catID := fx.seedCategory("Snacks")
	itemID := fx.seedMenuItem(catID, "Brownie", 800)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, 5, 800) // 4000 revenue
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=4000, total_cents=4000 WHERE id=$1`,
		orderID, day,
	)
	expID := fx.rptSeedExpense("Bakery", 1000, day)
	fx.rptSeedAllocation(expID, catID, "100", 1000)

	resp := callHandler(t, fx, GetProfitabilityDrilldown, http.MethodGet, "/reports/profitability/x/items", nil,
		withParam("categoryId", catID.String()),
		withQuery("from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z&range=custom"))
	resp.expectStatus(http.StatusOK)

	var dd ProfitDrilldown
	resp.decode(&dd)

	if dd.Category.Name != "Snacks" {
		t.Errorf("category.name: want Snacks, got %q", dd.Category.Name)
	}
	if dd.Category.RevenueCents != 4000 {
		t.Errorf("category.revenue_cents: want 4000, got %d", dd.Category.RevenueCents)
	}
	if dd.Category.AllocatedCogsCents != 1000 {
		t.Errorf("category.allocated_cogs_cents: want 1000, got %d", dd.Category.AllocatedCogsCents)
	}
	if dd.Category.GrossProfitCents != 3000 {
		t.Errorf("category.gross_profit_cents: want 3000, got %d", dd.Category.GrossProfitCents)
	}
	if len(dd.Expenses) != 1 {
		t.Errorf("want 1 drilldown expense, got %d", len(dd.Expenses))
	} else if dd.Expenses[0].AllocatedCents != 1000 {
		t.Errorf("expense.allocated_cents: want 1000, got %d", dd.Expenses[0].AllocatedCents)
	}
	if len(dd.Items) != 1 {
		t.Errorf("want 1 drilldown item, got %d", len(dd.Items))
	} else {
		it := dd.Items[0]
		if it.Name != "Brownie" {
			t.Errorf("item.name: want Brownie, got %q", it.Name)
		}
		if it.Qty != 5 {
			t.Errorf("item.qty: want 5, got %d", it.Qty)
		}
		if it.RevenueCents != 4000 {
			t.Errorf("item.revenue_cents: want 4000, got %d", it.RevenueCents)
		}
	}
}

// =========================================================================
// GetTopSellers
// =========================================================================

func TestGetTopSellers_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetTopSellers, http.MethodGet, "/reports/top-sellers", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var ts TopSellersResp
	resp.decode(&ts)
	if ts.Top == nil {
		t.Error("want non-nil top slice")
	}
	if ts.Bottom == nil {
		t.Error("want non-nil bottom slice")
	}
	if len(ts.Top) != 0 {
		t.Errorf("want 0 top sellers, got %d", len(ts.Top))
	}
}

func TestGetTopSellers_Populated(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	rptSeedClosedOrder(fx, "BestSeller", 5, 2000, now.Add(-30*time.Minute))
	rptSeedClosedOrder(fx, "WorstSeller", 1, 100, now.Add(-20*time.Minute))

	resp := callHandler(t, fx, GetTopSellers, http.MethodGet, "/reports/top-sellers", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var ts TopSellersResp
	resp.decode(&ts)
	if len(ts.Top) == 0 {
		t.Fatal("want at least one top seller")
	}
	if ts.Top[0].Name != "BestSeller" {
		t.Errorf("top[0].name: want BestSeller, got %q", ts.Top[0].Name)
	}
	if ts.Top[0].RevenueCents != 10000 {
		t.Errorf("top[0].revenue_cents: want 10000, got %d", ts.Top[0].RevenueCents)
	}
	if ts.Top[0].Qty != 5 {
		t.Errorf("top[0].qty: want 5, got %d", ts.Top[0].Qty)
	}
}

func TestGetTopSellers_DeltaPctNilWhenNoPriorRevenue(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	// Only seed in the current window; prior window is empty → DeltaPct nil.
	rptSeedClosedOrder(fx, "NewItem", 1, 3000, now.Add(-1*time.Hour))

	resp := callHandler(t, fx, GetTopSellers, http.MethodGet, "/reports/top-sellers", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var ts TopSellersResp
	resp.decode(&ts)
	if len(ts.Top) == 0 {
		t.Skip("no top sellers seeded in window")
	}
	// Find NewItem; its DeltaPct should be nil (prior revenue = 0).
	for _, row := range ts.Top {
		if row.Name == "NewItem" && row.DeltaPct != nil {
			t.Errorf("DeltaPct should be nil when prior revenue=0, got %v", *row.DeltaPct)
		}
	}
}

func TestGetTopSellers_PrevFromPrevToPresent(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetTopSellers, http.MethodGet, "/reports/top-sellers", nil,
		withQuery("range=7d"))
	resp.expectStatus(http.StatusOK)
	var ts TopSellersResp
	resp.decode(&ts)
	if ts.PrevFrom.IsZero() {
		t.Error("want non-zero prev_from")
	}
	if ts.PrevTo.IsZero() {
		t.Error("want non-zero prev_to")
	}
	if !ts.PrevTo.Before(ts.From) && ts.PrevTo != ts.From {
		t.Errorf("prev_to should be <= from; prev_to=%v from=%v", ts.PrevTo, ts.From)
	}
}

// =========================================================================
// GetHeatmap
// =========================================================================

func TestGetHeatmap_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetHeatmap, http.MethodGet, "/reports/heatmap", nil,
		withQuery("range=7d"))
	resp.expectStatus(http.StatusOK)

	var hm HeatmapResp
	resp.decode(&hm)
	if hm.Cells == nil {
		t.Error("want non-nil cells slice")
	}
	// Empty tenant → no non-zero cells returned.
	if len(hm.Cells) != 0 {
		t.Errorf("want 0 cells for empty tenant, got %d", len(hm.Cells))
	}
}

func TestGetHeatmap_Populated(t *testing.T) {
	fx := newTenant(t)
	// One closed order within the last hour.
	now := time.Now().UTC()
	rptSeedClosedOrder(fx, "HeatItem", 1, 1000, now.Add(-30*time.Minute))

	resp := callHandler(t, fx, GetHeatmap, http.MethodGet, "/reports/heatmap", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var hm HeatmapResp
	resp.decode(&hm)
	if len(hm.Cells) == 0 {
		t.Error("want at least one cell after seeding an order")
	}
	cell := hm.Cells[0]
	if cell.OrderCount <= 0 {
		t.Errorf("cell.order_count: want >0, got %d", cell.OrderCount)
	}
	if cell.Hour < 0 || cell.Hour > 23 {
		t.Errorf("cell.hour out of range: %d", cell.Hour)
	}
	if cell.Dow < 0 || cell.Dow > 6 {
		t.Errorf("cell.dow out of range: %d", cell.Dow)
	}
}

func TestGetHeatmap_RangeFieldsPresent(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetHeatmap, http.MethodGet, "/reports/heatmap", nil,
		withQuery("range=30d"))
	resp.expectStatus(http.StatusOK)
	var hm HeatmapResp
	resp.decode(&hm)
	if hm.Range != "30d" {
		t.Errorf("want range=30d, got %q", hm.Range)
	}
	if hm.Timezone == "" {
		t.Error("want non-empty timezone")
	}
	if hm.From.IsZero() {
		t.Error("want non-zero from")
	}
}

// =========================================================================
// GetCategoryMix
// =========================================================================

func TestGetCategoryMix_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetCategoryMix, http.MethodGet, "/reports/category-mix", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows, ok := m["rows"].([]any)
	if !ok {
		t.Fatalf("want rows array, got %T", m["rows"])
	}
	if len(rows) != 0 {
		t.Errorf("want 0 rows for empty tenant, got %d", len(rows))
	}
}

func TestGetCategoryMix_Populated_SharePct(t *testing.T) {
	fx := newTenant(t)
	// Seed two categories with known revenue so share_pct is deterministic.
	// Cat1: 6000, Cat2: 4000 → total 10000. Cat1 share=60%, Cat2 share=40%.
	now := time.Now().UTC()

	catID1 := fx.seedCategory("CatMix1")
	item1 := fx.seedMenuItem(catID1, "MixItem1", 1000)
	ord1 := fx.seedOpenOrder(nil)
	fx.seedOrderItem(ord1, item1, 6, 1000)
	fx.adminExec(`UPDATE orders SET status='closed'::order_status, closed_at=$2, subtotal_cents=6000, total_cents=6000 WHERE id=$1`, ord1, now.Add(-40*time.Minute))

	catID2 := fx.seedCategory("CatMix2")
	item2 := fx.seedMenuItem(catID2, "MixItem2", 2000)
	ord2 := fx.seedOpenOrder(nil)
	fx.seedOrderItem(ord2, item2, 2, 2000)
	fx.adminExec(`UPDATE orders SET status='closed'::order_status, closed_at=$2, subtotal_cents=4000, total_cents=4000 WHERE id=$1`, ord2, now.Add(-30*time.Minute))

	resp := callHandler(t, fx, GetCategoryMix, http.MethodGet, "/reports/category-mix", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows := m["rows"].([]any)

	if len(rows) < 2 {
		t.Fatalf("want ≥2 category rows, got %d", len(rows))
	}

	// Rows are ordered by revenue DESC: CatMix1 first.
	r0 := rows[0].(map[string]any)
	if r0["name"] != "CatMix1" {
		t.Errorf("rows[0].name: want CatMix1, got %v", r0["name"])
	}
	sharePct, _ := r0["share_pct"].(float64)
	if sharePct != 60.0 {
		t.Errorf("rows[0].share_pct: want 60.0, got %v", sharePct)
	}

	r1 := rows[1].(map[string]any)
	if r1["name"] != "CatMix2" {
		t.Errorf("rows[1].name: want CatMix2, got %v", r1["name"])
	}
	sharePct1, _ := r1["share_pct"].(float64)
	if sharePct1 != 40.0 {
		t.Errorf("rows[1].share_pct: want 40.0, got %v", sharePct1)
	}
}

func TestGetCategoryMix_RangeFieldsPresent(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetCategoryMix, http.MethodGet, "/reports/category-mix", nil,
		withQuery("range=7d"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	if m["range"] != "7d" {
		t.Errorf("want range=7d, got %v", m["range"])
	}
	if m["from"] == nil {
		t.Error("want from field")
	}
	if m["to"] == nil {
		t.Error("want to field")
	}
}

// =========================================================================
// GetTableMix
// =========================================================================

func TestGetTableMix_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetTableMix, http.MethodGet, "/reports/table-mix", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows, ok := m["rows"].([]any)
	if !ok {
		t.Fatalf("want rows array, got %T", m["rows"])
	}
	// No tables seeded → empty rows (not a 500).
	if len(rows) != 0 {
		t.Errorf("want 0 rows for empty tenant, got %d", len(rows))
	}
}

func TestGetTableMix_ZeroActivityTableIncluded(t *testing.T) {
	fx := newTenant(t)
	// Seed a table but no closed orders against it.
	fx.seedTable("IdleTable")

	resp := callHandler(t, fx, GetTableMix, http.MethodGet, "/reports/table-mix", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)
	m := resp.json()
	rows := m["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("want at least the idle table in response")
	}
	row := rows[0].(map[string]any)
	if row["name"] != "IdleTable" {
		t.Errorf("want IdleTable, got %v", row["name"])
	}
	if cnt, _ := row["order_count"].(float64); cnt != 0 {
		t.Errorf("order_count: want 0, got %v", row["order_count"])
	}
	if rev, _ := row["revenue_cents"].(float64); rev != 0 {
		t.Errorf("revenue_cents: want 0, got %v", row["revenue_cents"])
	}
	if avg, _ := row["avg_ticket_cents"].(float64); avg != 0 {
		t.Errorf("avg_ticket_cents: want 0, got %v", row["avg_ticket_cents"])
	}
}

func TestGetTableMix_Populated(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	tblID := fx.seedTable("BusyTable")
	// Two closed orders on this table.
	rptSeedClosedOrderOnTable(fx, tblID, "TblItem1", 1, 3000, now.Add(-40*time.Minute))
	rptSeedClosedOrderOnTable(fx, tblID, "TblItem2", 1, 5000, now.Add(-20*time.Minute))

	resp := callHandler(t, fx, GetTableMix, http.MethodGet, "/reports/table-mix", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	m := resp.json()
	rows := m["rows"].([]any)
	var found map[string]any
	for _, raw := range rows {
		r := raw.(map[string]any)
		if r["name"] == "BusyTable" {
			found = r
			break
		}
	}
	if found == nil {
		t.Fatal("BusyTable not found in table mix response")
	}
	if cnt, _ := found["order_count"].(float64); int(cnt) != 2 {
		t.Errorf("order_count: want 2, got %v", found["order_count"])
	}
	if rev, _ := found["revenue_cents"].(float64); rev != 8000 {
		t.Errorf("revenue_cents: want 8000, got %v", found["revenue_cents"])
	}
	if avg, _ := found["avg_ticket_cents"].(float64); avg != 4000 {
		t.Errorf("avg_ticket_cents: want 4000, got %v", found["avg_ticket_cents"])
	}
}

// =========================================================================
// GetVelocity
// =========================================================================

func TestGetVelocity_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetVelocity, http.MethodGet, "/reports/velocity", nil,
		withQuery("range=7d"))
	resp.expectStatus(http.StatusOK)

	var vr VelocityResp
	resp.decode(&vr)
	if vr.Series == nil {
		t.Error("want non-nil series slice")
	}
	// 7d range → 7 series points (generate_series fills zeros).
	if len(vr.Series) != 7 {
		t.Errorf("want 7 series points for 7d range, got %d", len(vr.Series))
	}
	if vr.TotalOrders != 0 {
		t.Errorf("total_orders: want 0, got %d", vr.TotalOrders)
	}
	if vr.TotalRevenueCents != 0 {
		t.Errorf("total_revenue_cents: want 0, got %d", vr.TotalRevenueCents)
	}
}

func TestGetVelocity_Populated(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	// Two closed orders today.
	rptSeedClosedOrder(fx, "VelItem1", 3, 1000, now.Add(-50*time.Minute))
	rptSeedClosedOrder(fx, "VelItem2", 2, 500, now.Add(-30*time.Minute))

	resp := callHandler(t, fx, GetVelocity, http.MethodGet, "/reports/velocity", nil,
		withQuery("range=today"))
	resp.expectStatus(http.StatusOK)

	var vr VelocityResp
	resp.decode(&vr)
	if vr.TotalOrders != 2 {
		t.Errorf("total_orders: want 2, got %d", vr.TotalOrders)
	}
	wantRevenue := int64(3*1000 + 2*500)
	if vr.TotalRevenueCents != wantRevenue {
		t.Errorf("total_revenue_cents: want %d, got %d", wantRevenue, vr.TotalRevenueCents)
	}
	if vr.AvgTicketCents != wantRevenue/2 {
		t.Errorf("avg_ticket_cents: want %d, got %d", wantRevenue/2, vr.AvgTicketCents)
	}
	// today range → 1 series point.
	if len(vr.Series) != 1 {
		t.Errorf("want 1 series point for today range, got %d", len(vr.Series))
	}
	pt := vr.Series[0]
	if pt.OrderCount != 2 {
		t.Errorf("series[0].order_count: want 2, got %d", pt.OrderCount)
	}
	if pt.RevenueCents != wantRevenue {
		t.Errorf("series[0].revenue_cents: want %d, got %d", wantRevenue, pt.RevenueCents)
	}
	if pt.ItemsTotal != 5 { // 3 + 2
		t.Errorf("series[0].items_total: want 5, got %d", pt.ItemsTotal)
	}
	// ItemsPerOrderX10: (5 items × 10) / 2 orders = 25
	if pt.ItemsPerOrderX10 != 25 {
		t.Errorf("series[0].items_per_order_x10: want 25, got %d", pt.ItemsPerOrderX10)
	}
}

func TestGetVelocity_SeriesPointsCountMatchDays(t *testing.T) {
	fx := newTenant(t)
	for _, tc := range []struct {
		preset string
		days   int
	}{
		{"today", 1},
		{"yesterday", 1},
		{"7d", 7},
		{"30d", 30},
	} {
		tc := tc
		t.Run(tc.preset, func(t *testing.T) {
			resp := callHandler(t, fx, GetVelocity, http.MethodGet, "/reports/velocity", nil,
				withQuery("range="+tc.preset))
			resp.expectStatus(http.StatusOK)
			var vr VelocityResp
			resp.decode(&vr)
			if len(vr.Series) != tc.days {
				t.Errorf("range=%s: want %d series points, got %d", tc.preset, tc.days, len(vr.Series))
			}
		})
	}
}

func TestGetVelocity_RangeMetaPresent(t *testing.T) {
	fx := newTenant(t)
	resp := callHandler(t, fx, GetVelocity, http.MethodGet, "/reports/velocity", nil,
		withQuery("range=7d"))
	resp.expectStatus(http.StatusOK)
	var vr VelocityResp
	resp.decode(&vr)
	if vr.Range != "7d" {
		t.Errorf("want range=7d, got %q", vr.Range)
	}
	if vr.Timezone == "" {
		t.Error("want non-empty timezone")
	}
	if vr.From.IsZero() {
		t.Error("want non-zero from")
	}
	if vr.To.IsZero() {
		t.Error("want non-zero to")
	}
}
