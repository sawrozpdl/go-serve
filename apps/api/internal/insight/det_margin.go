package insight

import (
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// What the café actually keeps.
//
// Both detectors here depend on cost data being present, and cost data is
// exactly what is most often missing (see det_books.go). They are honest about
// it in two ways: belowCost only ever looks at items that HAVE a cost recorded,
// and marginSlip refuses to fire without a prior window to compare against.

const (
	// A category's gross margin dropping by this many percentage points against
	// the previous window of the same length. Points, not percent-of-percent:
	// 65% → 58% is a 7-point slip.
	MarginSlipWarnPoints = 0.05
	MarginSlipBadPoints  = 0.10

	// Ignore categories too small for a swing to mean anything. A category that
	// sold Rs 300 last month will move double digits on one unusual order.
	MarginSlipMinRevenueCents = 500000 // Rs 5,000

	// An item sold at or below cost is always worth saying; this only decides
	// how loud.
	BelowCostBadCents = 100000 // Rs 1,000 given away over the window
)

// belowCost reports items that sold for no more than they cost.
var belowCost = Detector{
	Key:     "below_cost",
	Label:   "Selling below cost",
	Perm:    "report:read",
	LinkTpl: "/admin/reports/movers?item=%s",
	Fn: func(_ time.Time, in Inputs) []Finding {
		out := make([]Finding, 0, len(in.BelowCost))
		for _, it := range in.BelowCost {
			// gather.go only selects rows with a real cost, but a detector must
			// not rely on its caller for a correctness guard this cheap.
			if it.CostCents <= 0 || it.Qty <= 0 {
				continue
			}
			sev := SeverityWarn
			if it.LostCents >= BelowCostBadCents {
				sev = SeverityBad
			}

			var detail string
			if it.CostCents == it.PriceCents {
				detail = fmt.Sprintf(
					"%s sells for exactly what it costs (%s). %.0f sold in the last %d days earned nothing at all.",
					it.Name, audit.Money(it.PriceCents), it.Qty, in.Window.Days())
			} else {
				detail = fmt.Sprintf(
					"%s costs %s and sells for %s, so every one loses %s. That is %s given away across %.0f sold "+
						"in the last %d days — usually a supplier price rise that the menu price never caught up with.",
					it.Name, audit.Money(it.CostCents), audit.Money(it.PriceCents),
					audit.Money(it.CostCents-it.PriceCents), audit.Money(it.LostCents),
					it.Qty, in.Window.Days())
			}

			out = append(out, Finding{
				SubjectKind:  SubjectMenuItem,
				SubjectKey:   it.ID.String(),
				SubjectLabel: it.Name,
				Severity:     sev,
				Detail:       detail,
				MetricValue:  float64(it.LostCents),
				Unit:         UnitCents,
				Facts: map[string]any{
					"price_cents": it.PriceCents,
					"cost_cents":  it.CostCents,
					"qty":         it.Qty,
					"lost_cents":  it.LostCents,
				},
				LinkArgs: []any{it.ID.String()},
			})
		}
		// Worst money first, then name, so the ordering is deterministic.
		sort.Slice(out, func(i, j int) bool {
			if out[i].MetricValue != out[j].MetricValue {
				return out[i].MetricValue > out[j].MetricValue
			}
			return out[i].SubjectLabel < out[j].SubjectLabel
		})

		return capNamed(out, MaxNamedPerDetector, func(rest []Finding) Finding {
			total := sumFacts(rest, "lost_cents")
			return Finding{
				SubjectKind:  SubjectTenant,
				SubjectKey:   "below_cost_tail",
				SubjectLabel: "Other items priced under cost",
				Severity:     worstSeverity(rest),
				Detail: fmt.Sprintf(
					"%s are also selling at or below cost, giving away %s between them over the last %d days. "+
						"A supplier price rise usually moves several at once.",
					plural(len(rest), "other item", "other items"), moneyTotal(total), in.Window.Days()),
				MetricValue: float64(total),
				Unit:        UnitCents,
				Facts: map[string]any{
					"item_count": len(rest),
					"lost_cents": total,
					"names":      namesOf(rest),
				},
				LinkArgs: []any{""},
			}
		})
	},
}

// marginSlip reports a category earning materially less per rupee than it did.
var marginSlip = Detector{
	Key:     "margin_slip",
	Label:   "Margin slipping",
	Perm:    "report:read",
	Feature: "profitability",
	LinkTpl: "/admin/reports/profitability?category=%s",
	Fn: func(_ time.Time, in Inputs) []Finding {
		out := make([]Finding, 0)
		for _, c := range in.Categories {
			if c.RevenueCents < MarginSlipMinRevenueCents {
				continue
			}
			now, ok := c.Margin()
			if !ok {
				continue
			}
			prior, hadPrior := c.PriorMargin()
			// No baseline: say nothing. This is health.gradeVolume's "no earlier
			// weeks to compare against", and inventing a comparison here would
			// flag every newly-added category as collapsing.
			if !hadPrior || c.PriorRevenueCents < MarginSlipMinRevenueCents {
				continue
			}
			drop := prior - now
			if drop < MarginSlipWarnPoints {
				continue
			}
			sev := SeverityWarn
			if drop >= MarginSlipBadPoints {
				sev = SeverityBad
			}
			baseline := prior

			out = append(out, Finding{
				SubjectKind:  SubjectCategory,
				SubjectKey:   c.ID.String(),
				SubjectLabel: c.Name,
				Severity:     sev,
				Detail: fmt.Sprintf(
					"%s earned %.0f%% margin over the last %d days, down from %.0f%% the %d days before — "+
						"%.0f points. On %s of sales that is about %s less kept than the old rate would have given you.",
					c.Name, now*100, in.Window.Days(), prior*100, in.Prior.Days(), drop*100,
					audit.Money(c.RevenueCents), audit.Money(int64(math.Round(drop*float64(c.RevenueCents))))),
				MetricValue: now,
				Unit:        UnitRatio,
				Baseline:    &baseline,
				Facts: map[string]any{
					"margin_now":          now,
					"margin_prior":        prior,
					"drop_points":         drop,
					"revenue_cents":       c.RevenueCents,
					"prior_revenue_cents": c.PriorRevenueCents,
				},
				LinkArgs: []any{c.ID.String()},
			})
		}
		sort.Slice(out, func(i, j int) bool {
			di, _ := out[i].Facts["drop_points"].(float64)
			dj, _ := out[j].Facts["drop_points"].(float64)
			if di != dj {
				return di > dj
			}
			return out[i].SubjectLabel < out[j].SubjectLabel
		})
		return out
	},
}
