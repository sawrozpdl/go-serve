package api

import (
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/insight"
)

// internal/insight cannot import this package — internal/api imports IT, for the
// /v1/insights handlers — so it keeps its own copy of the two money-vocabulary
// SQL fragments. This test is what makes that copy safe.
//
// If it fails, do not "fix" it by editing the expected value. money.go is the
// source of truth: change insight's constant to match, and check whether any
// stored finding quoted the old basis.
//
// The stakes are the reason this exists at all. Before money.go, "Sales" meant
// SUM(orders.total_cents) on the dashboard and SUM(qty x unit_price) on
// profitability, and for a VAT-exclusive café those differ by roughly 14%. A
// brief that quotes a number the linked screen contradicts is worse than no
// brief: the whole feature is a claim that these numbers can be trusted.
func TestInsightMoneyVocabularyMatchesMoneyGo(t *testing.T) {
	if insight.NetRevenueExpr != netRevenueExpr {
		t.Errorf("net revenue expression has drifted:\n  money.go: %s\n  insight:  %s",
			netRevenueExpr, insight.NetRevenueExpr)
	}
	if insight.ClosedOrdersInWindow != closedOrdersInWindow {
		t.Errorf("closed-orders predicate has drifted:\n  money.go: %s\n  insight:  %s",
			closedOrdersInWindow, insight.ClosedOrdersInWindow)
	}
}
