package api

// Integration tests for GetProfitability — specifically the cash-basis Net
// Profit line added alongside the per-category gross-margin view.
//
// Net Profit = Sales − ALL expenses for the period (incl. salary and any
// expense not allocated to a menu category). Gross profit, by contrast, only
// subtracts per-unit cost + expenses explicitly allocated to a category. This
// test pins the distinction the owner asked about: an unallocated salary must
// reduce Net Profit but NOT category gross profit.

import (
	"net/http"
	"testing"
)

func TestProfitability_NetProfitCountsAllExpenses(t *testing.T) {
	fx := newTenant(t)

	// 1000 in closed sales, no per-unit cost set → zero direct COGS.
	rptSeedClosedOrder(fx, "Momo", 2, 500, pastUTC(2))

	// An unallocated salary expense — overhead, not tagged to any category.
	fx.rptSeedExpense("Salary — June", 600, pastUTC(2))

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=30d"))
	resp.expectStatus(http.StatusOK)

	var report ProfitReport
	resp.decode(&report)

	if report.Totals.RevenueCents != 1000 {
		t.Fatalf("revenue = %d, want 1000", report.Totals.RevenueCents)
	}
	// Gross profit ignores the unallocated salary (no COGS allocated) → 1000.
	if report.Totals.GrossProfitCents != 1000 {
		t.Fatalf("gross profit = %d, want 1000 (salary not allocated)", report.Totals.GrossProfitCents)
	}
	// The salary still shows up as unallocated, for review.
	if report.UnallocatedCogsCents != 600 {
		t.Fatalf("unallocated = %d, want 600", report.UnallocatedCogsCents)
	}
	// Net profit DOES count the salary: 1000 − 600 = 400.
	if report.TotalExpensesCents != 600 {
		t.Fatalf("total expenses = %d, want 600", report.TotalExpensesCents)
	}
	if report.NetProfitCents != 400 {
		t.Fatalf("net profit = %d, want 400 (1000 sales − 600 expenses)", report.NetProfitCents)
	}
}

func TestProfitability_NetProfitSubtractsAllocatedToo(t *testing.T) {
	fx := newTenant(t)

	// Build a closed order on a known category so we can allocate to it.
	catID := fx.seedCategory("Drinks")
	itemID := fx.seedMenuItem(catID, "Latte", 400)
	orderID := fx.seedOpenOrder(nil)
	fx.seedOrderItem(orderID, itemID, 5, 400) // 2000 revenue
	fx.adminExec(
		`UPDATE orders SET status='closed'::order_status, closed_at=$2,
		  subtotal_cents=$3, total_cents=$3 WHERE id=$1`,
		orderID, pastUTC(2), int64(2000),
	)

	// A milk expense fully allocated to Drinks (counts toward category COGS).
	milk := fx.rptSeedExpense("Milk", 500, pastUTC(2))
	fx.rptSeedAllocation(milk, catID, "100", 500)
	// Plus an unallocated salary.
	fx.rptSeedExpense("Salary", 300, pastUTC(2))

	resp := callHandler(t, fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery("range=30d"))
	resp.expectStatus(http.StatusOK)

	var report ProfitReport
	resp.decode(&report)

	// Gross profit subtracts only the allocated milk: 2000 − 500 = 1500.
	if report.Totals.GrossProfitCents != 1500 {
		t.Fatalf("gross profit = %d, want 1500 (only allocated milk)", report.Totals.GrossProfitCents)
	}
	// Total expenses + net profit count both: 2000 − (500 + 300) = 1200.
	if report.TotalExpensesCents != 800 {
		t.Fatalf("total expenses = %d, want 800", report.TotalExpensesCents)
	}
	if report.NetProfitCents != 1200 {
		t.Fatalf("net profit = %d, want 1200 (2000 − 800)", report.NetProfitCents)
	}
}
