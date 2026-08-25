package insight

import (
	"fmt"
	"sort"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Arithmetic that does not reconcile, from tenant_integrity_check() (0068).
//
// These invariants already existed for the /super console as
// platform_accuracy_check() (0056) — eleven money checks, each with a signed
// delta. They were only ever shown to platform admins, which made them an
// anomaly engine pointed at the wrong audience. 0068 re-exposes the
// owner-actionable subset under RLS.
//
// ONE FINDING PER CHECK, NOT PER ROW. A café with forty unlinked drawer expenses
// has one problem, not forty; forty findings would bury everything else in the
// brief and make the list unreadable. The count and the total go in the sentence
// and the rows are one click away.

// integrityCheck describes how to talk about one invariant.
type integrityCheck struct {
	// One and Many complete "1 ..." and "N ...". Both forms are spelled out
	// because these phrases are clauses, not words — "closed bills whose total
	// does not match their own lines" has no mechanical singular, and "1
	// expenses" is exactly the kind of sloppiness that makes an owner trust the
	// numbers less.
	One  string
	Many string
	// Severity: arithmetic that cannot be explained is `bad`. Two of them are
	// bookkeeping tidiness rather than missing money, and are marked down.
	Severity Severity
	// Link is where the owner goes to see the rows.
	Link string
}

// integrityChecks is keyed by tenant_integrity_check()'s check_key. A key with
// no entry here is deliberately NOT reported: adding a check to the SQL does not
// silently start emailing cafés about it until someone writes the sentence.
var integrityChecks = map[string]integrityCheck{
	"order_arithmetic": {
		One:      "closed bill whose total does not match its own lines",
		Many:     "closed bills whose total does not match their own lines",
		Severity: SeverityBad, Link: "/admin/history",
	},
	"payments_vs_total": {
		One:      "closed bill where the payments taken do not equal the total",
		Many:     "closed bills where the payments taken do not equal the total",
		Severity: SeverityBad, Link: "/admin/history",
	},
	"post_close_void": {
		One:      "item voided after the bill had already been closed",
		Many:     "items voided after the bill had already been closed",
		Severity: SeverityBad, Link: "/admin/history",
	},
	"credit_without_tab": {
		One:      "credit charge with no credit account attached",
		Many:     "credit charges with no credit account attached",
		Severity: SeverityBad, Link: "/admin/credit",
	},
	"negative_tab": {
		One:      "credit account that has been collected on more than was ever charged",
		Many:     "credit accounts that have been collected on more than was ever charged",
		Severity: SeverityBad, Link: "/admin/credit",
	},
	"cash_without_shift": {
		One:      "cash payment taken with no drawer session open, which no count can ever see",
		Many:     "cash payments taken with no drawer session open, which no count can ever see",
		Severity: SeverityBad, Link: "/admin/shift",
	},
	"shift_expected_cash": {
		One:      "closed drawer whose expected cash no longer matches the rows behind it",
		Many:     "closed drawers whose expected cash no longer matches the rows behind it",
		Severity: SeverityBad, Link: "/admin/shift",
	},
	"reversal_incomplete": {
		One:      "credit reversal that was only half recorded",
		Many:     "credit reversals that were only half recorded",
		Severity: SeverityWarn, Link: "/admin/credit",
	},
	"drawer_expense_unlinked": {
		One:      "expense marked paid from the drawer that never moved the drawer",
		Many:     "expenses marked paid from the drawer that never moved the drawer",
		Severity: SeverityWarn, Link: "/admin/expenses",
	},
}

// noun picks the singular or plural clause for a count.
func (c integrityCheck) noun(n int) string {
	if n == 1 {
		return c.One
	}
	return c.Many
}

var integrity = Detector{
	Key:   "integrity",
	Label: "Books that don't add up",
	// Reconciliation is the owner's business, not a report — gate on the drawer
	// rather than on analytics.
	Perm: "shift:read",
	Fn: func(_ time.Time, in Inputs) []Finding {
		if len(in.Integrity) == 0 {
			return nil
		}

		type agg struct {
			count int
			gross int64
			net   int64
		}
		byKey := map[string]*agg{}
		for _, v := range in.Integrity {
			if _, known := integrityChecks[v.CheckKey]; !known {
				continue
			}
			a := byKey[v.CheckKey]
			if a == nil {
				a = &agg{}
				byKey[v.CheckKey] = a
			}
			a.count++
			a.net += v.DeltaCents
			if v.DeltaCents < 0 {
				a.gross -= v.DeltaCents
			} else {
				a.gross += v.DeltaCents
			}
		}

		// Stable order: worst money first, then the key, so two runs over the
		// same data always produce the same brief.
		keys := make([]string, 0, len(byKey))
		for k := range byKey {
			keys = append(keys, k)
		}
		// Severity first, then money, then key. Sorting on money alone let a
		// Rs 1,200 bookkeeping warn outrank a Rs 400 payments-mismatch bad,
		// which reads as though the tidier problem were the bigger one.
		sort.Slice(keys, func(i, j int) bool {
			si, sj := integrityChecks[keys[i]].Severity, integrityChecks[keys[j]].Severity
			if si != sj {
				return si.WorseThan(sj)
			}
			if byKey[keys[i]].gross != byKey[keys[j]].gross {
				return byKey[keys[i]].gross > byKey[keys[j]].gross
			}
			return keys[i] < keys[j]
		})

		out := make([]Finding, 0, len(keys))
		for _, k := range keys {
			a := byKey[k]
			spec := integrityChecks[k]
			out = append(out, Finding{
				// Keyed by check so each invariant gets its own lifecycle: an
				// owner can dismiss "unlinked drawer expenses" without also
				// dismissing "payments don't match the total".
				SubjectKind:  SubjectTenant,
				SubjectKey:   k,
				SubjectLabel: spec.Many,
				Severity:     spec.Severity,
				Detail: fmt.Sprintf("%d %s. %s is unaccounted for.",
					a.count, spec.noun(a.count), audit.Money(a.gross)),
				MetricValue: float64(a.count),
				Unit:        UnitCount,
				Facts: map[string]any{
					"check_key":   k,
					"row_count":   a.count,
					"gross_cents": a.gross,
					"net_cents":   a.net,
					"link":        spec.Link,
				},
			})
		}
		return out
	},
}
