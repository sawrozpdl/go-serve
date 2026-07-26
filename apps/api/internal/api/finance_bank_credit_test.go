package api

// Regression test for the cafe-balance bank tile: credit settled by bank
// transfer raised the Accounts page bank card (accounts.go sums
// house_tab_settlements for every bucket) while GetCafeBalance and
// GetCafeSummary summed payments only — so that money was missing from the
// Bank tile and from the cafe's total position.

import (
	"net/http"
	"testing"
)

// Regression: credit settled by bank transfer used to raise the Accounts page
// bank card while being dropped from the cafe-balance bank tile and total.
func TestCafeBalance_IncludesBankCreditSettlement(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("BankSettled", true)
	creditSaleOn(fx, tabID, 20000, pastUTC(24*2))
	htSeedSettlement(fx, tabID, "bank", 20000, nil)

	m := callHandler(t, fx, GetCafeBalance, http.MethodGet, "/finance/cafe-balance", nil).
		expectStatus(http.StatusOK).json()
	if got := int64(m["bank_cents"].(float64)); got != 20000 {
		t.Fatalf("bank_cents = %d, want 20000 (bank-settled credit)", got)
	}
	if got := int64(m["total_cents"].(float64)); got != 20000 {
		t.Fatalf("total_cents = %d, want 20000", got)
	}

	// cafe-summary reads the same position and must agree.
	s := callHandler(t, fx, GetCafeSummary, http.MethodGet, "/finance/cafe-summary", nil).
		expectStatus(http.StatusOK).json()
	if got := int64(s["cafe_balance_cents"].(float64)); got != 20000 {
		t.Fatalf("cafe_balance_cents = %d, want 20000", got)
	}
	// The collection is not revenue: the only sale was the credit serve itself.
	if got := int64(s["lifetime_revenue_cents"].(float64)); got != 20000 {
		t.Fatalf("lifetime_revenue_cents = %d, want 20000 (the serve, counted once)", got)
	}
}
