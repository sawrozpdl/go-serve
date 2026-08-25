package insight

import (
	"fmt"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Books Confidence — how much of the café's own profit figure we can vouch for.
//
// The brief asks the owner to trust a margin number. Two things quietly make
// that number a fiction, and neither is visible from the counter:
//
//   1. menu_items.cost_cents is NULLABLE and NULL is treated as zero everywhere
//      in the app. An item with no cost recorded reports 100% margin. So gross
//      margin does not degrade gracefully as costs go missing — it silently
//      inflates.
//   2. expense_allocations is a MANUAL attribution of overhead to a menu
//      category. Until spend is tagged, per-category profit counts only direct
//      ingredient cost and overstates every category.
//
// The honest response is not to hedge the margin with a fake confidence
// interval. It is to tell the owner exactly how much of their own revenue and
// spend the figure actually accounts for, and hand them the screen that fixes
// it. That is also the only "AI trustworthiness" mechanism here that cannot be
// faked, and it is what drives the data entry every later detector depends on.

const (
	// Cost coverage: share of window revenue from items that have a cost set.
	// A couple of percent is ordinary — a one-off item, a round of free water —
	// so the floor is not 100%.
	CostCoverageGood = 0.98
	CostCoverageWarn = 0.90

	// Expense allocation: share of window spend attributed to a category.
	// The bar is deliberately lower than for cost coverage. Allocation is a
	// judgement call an owner makes monthly, not a per-item fact, and demanding
	// near-total attribution would nag every café forever.
	ExpenseAllocGood = 0.80
	ExpenseAllocWarn = 0.40
)

// costCoverage reports revenue earned from items whose cost nobody has entered.
var costCoverage = Detector{
	Key:     "cost_coverage",
	Label:   "Sales with no cost recorded",
	Perm:    "report:read",
	LinkTpl: "/admin/menu",
	Fn: func(_ time.Time, in Inputs) []Finding {
		ratio, ok := in.CostCoverage.Ratio()
		// No revenue in the window: nothing to have a cost for. Say nothing
		// rather than reporting 0% coverage of nothing.
		if !ok || ratio >= CostCoverageGood {
			return nil
		}
		sev := SeverityWarn
		if ratio < CostCoverageWarn {
			sev = SeverityBad
		}
		gap := in.CostCoverage.GapCents()
		baseline := CostCoverageGood

		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Cost coverage",
			Severity:     sev,
			Detail: fmt.Sprintf(
				"%s of the last %d days' sales came from items with no cost recorded (%.0f%% of revenue). "+
					"Those items report as pure profit, so your margin is currently reported higher than it really is.",
				audit.Money(gap), in.Window.Days(), (1-ratio)*100),
			MetricValue: ratio,
			Unit:        UnitRatio,
			Baseline:    &baseline,
			Facts: map[string]any{
				"covered_cents": in.CostCoverage.KnownCents,
				"total_cents":   in.CostCoverage.TotalCents,
				"gap_cents":     gap,
			},
		}}
	},
}

// unallocatedSpend reports overhead nobody has attributed to a category.
var unallocatedSpend = Detector{
	Key:     "unallocated_spend",
	Label:   "Unallocated spend",
	Perm:    "report:read",
	Feature: "profitability",
	LinkTpl: "/admin/expenses",
	Fn: func(_ time.Time, in Inputs) []Finding {
		ratio, ok := in.ExpenseCoverage.Ratio()
		// A café that recorded no expenses at all has nothing to allocate.
		// Telling them 0% of nothing is untagged is exactly the kind of
		// technically-true noise this engine is supposed to refuse.
		if !ok || ratio >= ExpenseAllocGood {
			return nil
		}
		sev := SeverityWarn
		if ratio < ExpenseAllocWarn {
			sev = SeverityBad
		}
		gap := in.ExpenseCoverage.GapCents()
		baseline := ExpenseAllocGood

		// "None of it" reads better than "0% of it", and it is the common case
		// for a café that has never opened the allocation screen.
		lead := fmt.Sprintf("%s of the last %d days' spending", audit.Money(gap), in.Window.Days())
		if in.ExpenseCoverage.KnownCents == 0 {
			lead = fmt.Sprintf("None of the last %d days' %s of spending",
				in.Window.Days(), audit.Money(in.ExpenseCoverage.TotalCents))
		}

		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Unallocated spend",
			Severity:     sev,
			Detail: lead + " is attributed to a part of the menu, so profit by category counts " +
				"ingredient cost only and reads high for every category. Tagging it in Expenses is what " +
				"turns those percentages into real numbers.",
			MetricValue: ratio,
			Unit:        UnitRatio,
			Baseline:    &baseline,
			Facts: map[string]any{
				"allocated_cents": in.ExpenseCoverage.KnownCents,
				"total_cents":     in.ExpenseCoverage.TotalCents,
				"gap_cents":       gap,
			},
		}}
	},
}

// BooksConfidence is the composite figure the brief leads its margin section
// with. Deliberately NOT a detector: it is context for reading everything else,
// not a thing to action, and the two gaps that make it up have their own
// findings with their own fix screens.
//
// It is the mean of the components that APPLY. A café with no expenses recorded
// is not penalised for failing to allocate them — that would make the number
// punish cafés for what they haven't done yet rather than describe what we know.
func (in Inputs) BooksConfidence() (float64, bool) {
	var sum float64
	var n int
	if r, ok := in.CostCoverage.Ratio(); ok {
		sum, n = sum+r, n+1
	}
	if r, ok := in.ExpenseCoverage.Ratio(); ok {
		sum, n = sum+r, n+1
	}
	if in.Close.TradingDays > 0 {
		closed := float64(in.Close.ShiftCloseDays) / float64(in.Close.TradingDays)
		if closed > 1 {
			closed = 1
		}
		sum, n = sum+closed, n+1
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}
