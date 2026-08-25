package insight

import (
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/platform/health"
)

// Operational findings, strictly limited to what is invisible from the counter.
//
// Notably absent: anything about how busy it was, when the rush happened, or
// whether today beat last Tuesday. The person running the café was there. And
// because all revenue is attributed by orders.closed_at — settlement time, not
// order time — a tab opened at 2pm and settled at 6pm lands in the 6pm bucket,
// so intraday claims would be wrong as well as unwelcome.

const (
	// Drawer variance over the window. A café that is out by a few rupees has
	// counted well; the number that matters is whether it adds up to real money.
	DrawerVarianceWarnCents = 50000  // Rs 500 total across the window
	DrawerVarianceBadCents  = 200000 // Rs 2,000
	// Or one single count this far out, however good the rest were.
	DrawerVarianceSingleCents = 100000 // Rs 1,000

	// Credit left uncollected.
	CreditAgingWarnDays = 30
	CreditAgingBadDays  = 60
	// Below this a stale tab is not worth chasing or mentioning.
	CreditAgingMinCents = 100000 // Rs 1,000

	// Menu items nobody ordered. Reported as one finding, never one each.
	DeadItemsWarnCount = 5
)

// shiftDiscipline reports trading days that ended with no drawer reconciliation.
// The thresholds are health's, imported rather than restated so the café-facing
// finding and the platform-facing health grade can never disagree about what
// counts as bad discipline.
var shiftDiscipline = Detector{
	Key:     "shift_discipline",
	Label:   "Days closed without reconciling",
	Perm:    "shift:read",
	LinkTpl: "/admin/shift",
	Fn: func(now time.Time, in Inputs) []Finding {
		misses := in.Close.Misses()
		stale := in.Close.OpenShiftSince != nil &&
			now.Sub(*in.Close.OpenShiftSince) > health.StaleShiftHours*time.Hour
		if stale {
			misses++
		}
		if misses < health.ShiftMissesWarn {
			return nil
		}
		sev := SeverityWarn
		if misses >= health.ShiftMissesBad {
			sev = SeverityBad
		}

		var detail string
		switch {
		case stale && misses == 1:
			detail = "A drawer session has been open for more than " +
				strconv.Itoa(health.StaleShiftHours) + " hours. Until it is closed, nothing " +
				"reconciles and the cash figure keeps drifting."
		case stale:
			detail = fmt.Sprintf(
				"%d of the last %d trading days ended without closing the drawer, and a session is still "+
					"hanging open. Every unreconciled day is a day nobody can prove the cash was right.",
				misses-1, in.Close.TradingDays)
		default:
			detail = fmt.Sprintf(
				"%d of the last %d trading days ended without closing the drawer. Those days have no "+
					"count behind them, so if cash went missing on one there is no way to tell.",
				misses, in.Close.TradingDays)
		}

		baseline := float64(0)
		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Drawer reconciliation",
			Severity:     sev,
			Detail:       detail,
			MetricValue:  float64(misses),
			Unit:         UnitCount,
			Baseline:     &baseline,
			Facts: map[string]any{
				"misses":           misses,
				"trading_days":     in.Close.TradingDays,
				"shift_close_days": in.Close.ShiftCloseDays,
				"stale_open_shift": stale,
			},
		}}
	},
}

// drawerVariance reports counts that did not match what the rows expected.
var drawerVariance = Detector{
	Key:     "drawer_variance",
	Label:   "Drawer didn't balance",
	Perm:    "shift:read",
	LinkTpl: "/admin/shift",
	Fn: func(_ time.Time, in Inputs) []Finding {
		var total, worst int64
		off := 0
		for _, s := range in.Shifts {
			d := s.Diff
			if d == 0 {
				continue
			}
			off++
			if d < 0 {
				d = -d
			}
			total += d
			if d > worst {
				worst = d
			}
		}
		if off == 0 {
			return nil
		}
		notable := total >= DrawerVarianceWarnCents || worst >= DrawerVarianceSingleCents
		if !notable {
			return nil
		}
		sev := SeverityWarn
		if total >= DrawerVarianceBadCents {
			sev = SeverityBad
		}
		baseline := float64(0)
		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Drawer variance",
			Severity:     sev,
			Detail: fmt.Sprintf(
				"%d of the last %d drawer counts did not match the rows, %s out in total and %s at worst. "+
					"A short drawer is usually a payment recorded against the wrong method rather than missing cash — "+
					"the shift screen will point at the likely one when there is only one candidate.",
				off, len(in.Shifts), audit.Money(total), audit.Money(worst)),
			MetricValue: float64(total),
			Unit:        UnitCents,
			Baseline:    &baseline,
			Facts: map[string]any{
				"shifts_off":   off,
				"shifts_total": len(in.Shifts),
				"total_cents":  total,
				"worst_cents":  worst,
			},
		}}
	},
}

// creditAging reports credit nobody has collected on in a long time. One finding
// per account: unlike unlinked expenses, each is a different conversation with a
// different person, and the owner acts on them one at a time.
var creditAging = Detector{
	Key:     "credit_aging",
	Label:   "Credit going stale",
	Perm:    "house_tab:read",
	Feature: "house_tabs",
	LinkTpl: "/admin/credit/%s",
	Fn: func(_ time.Time, in Inputs) []Finding {
		out := make([]Finding, 0)
		for _, tab := range in.Credit {
			if tab.BalanceCents < CreditAgingMinCents {
				continue
			}
			// Nothing ever collected is the loud case: this is not a customer
			// paying slowly, it is an account that has only ever taken.
			if tab.DaysSincePayment == nil {
				out = append(out, Finding{
					SubjectKind:  SubjectHouseTab,
					SubjectKey:   tab.ID.String(),
					SubjectLabel: tab.Name,
					Severity:     SeverityBad,
					Detail: fmt.Sprintf(
						"%s owes %s and has never paid anything against it. Worth deciding whether this is "+
							"credit you expect back or a cost you have already absorbed.",
						tab.Name, audit.Money(tab.BalanceCents)),
					MetricValue: float64(tab.BalanceCents),
					Unit:        UnitCents,
					Facts: map[string]any{
						"balance_cents": tab.BalanceCents,
						"ever_paid":     false,
					},
					LinkArgs: []any{tab.ID.String()},
				})
				continue
			}
			days := *tab.DaysSincePayment
			if days < CreditAgingWarnDays {
				continue
			}
			sev := SeverityWarn
			if days >= CreditAgingBadDays {
				sev = SeverityBad
			}
			baseline := float64(CreditAgingWarnDays)
			out = append(out, Finding{
				SubjectKind:  SubjectHouseTab,
				SubjectKey:   tab.ID.String(),
				SubjectLabel: tab.Name,
				Severity:     sev,
				Detail: fmt.Sprintf(
					"%s owes %s and nothing has been collected for %d days. Credit that stops moving usually "+
						"needs a conversation rather than another reminder.",
					tab.Name, audit.Money(tab.BalanceCents), days),
				MetricValue: float64(days),
				Unit:        UnitDays,
				Baseline:    &baseline,
				Facts: map[string]any{
					"balance_cents":      tab.BalanceCents,
					"days_since_payment": days,
					"ever_paid":          true,
				},
				LinkArgs: []any{tab.ID.String()},
			})
		}
		// Largest balance first — that is the order an owner would chase them in.
		sort.Slice(out, func(i, j int) bool {
			bi, _ := out[i].Facts["balance_cents"].(int64)
			bj, _ := out[j].Facts["balance_cents"].(int64)
			if bi != bj {
				return bi > bj
			}
			return out[i].SubjectLabel < out[j].SubjectLabel
		})

		// Name the biggest few, fold the tail. A café with 25 stale accounts
		// would otherwise produce 25 findings and bury everything else.
		return capNamed(out, MaxNamedPerDetector, func(rest []Finding) Finding {
			total := sumFacts(rest, "balance_cents")
			return Finding{
				SubjectKind:  SubjectTenant,
				SubjectKey:   "credit_tail",
				SubjectLabel: "Other stale credit accounts",
				Severity:     worstSeverity(rest),
				Detail: fmt.Sprintf(
					"%s are also going stale, owing %s between them. The credit page lists them "+
						"largest first.",
					plural(len(rest), "other credit account", "other credit accounts"), moneyTotal(total)),
				MetricValue: float64(total),
				Unit:        UnitCents,
				Facts: map[string]any{
					"account_count": len(rest),
					"balance_cents": total,
					"names":         namesOf(rest),
				},
				LinkArgs: []any{""},
			}
		})
	},
}

// deadItems reports menu listings nobody ordered. One finding for the whole set:
// seventeen separate findings would bury the money ones, and the decision the
// owner makes ("tidy the menu") is a single decision anyway.
var deadItems = Detector{
	Key:     "dead_items",
	Label:   "Menu items nobody orders",
	Perm:    "menu:read",
	LinkTpl: "/admin/menu",
	Fn: func(_ time.Time, in Inputs) []Finding {
		if len(in.DeadItems) < DeadItemsWarnCount {
			return nil
		}
		never := 0
		names := make([]string, 0, len(in.DeadItems))
		for _, d := range in.DeadItems {
			if !d.EverSold {
				never++
			}
			names = append(names, d.Name)
		}
		sort.Strings(names)

		detail := fmt.Sprintf(
			"%d items are still on the menu but sold nothing in the last %d days",
			len(in.DeadItems), in.Window.Days())
		if never > 0 {
			detail += fmt.Sprintf(", and %d of them have never sold at all", never)
		}
		detail += ". A shorter menu is faster to cook and easier to choose from; " +
			"these are the candidates."

		baseline := float64(0)
		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Unsold menu items",
			// Never `bad`. A quiet item is a business decision, not a problem,
			// and this must never outrank money in the brief.
			Severity:    SeverityWarn,
			Detail:      detail,
			MetricValue: float64(len(in.DeadItems)),
			Unit:        UnitCount,
			Baseline:    &baseline,
			Facts: map[string]any{
				"dead_count": len(in.DeadItems),
				"never_sold": never,
				"item_names": names,
			},
		}}
	},
}
