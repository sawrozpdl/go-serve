package insight

import (
	"fmt"
	"sort"

	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// A DETECTOR MUST NEVER EMIT AN UNBOUNDED NUMBER OF FINDINGS.
//
// This rule was learned the hard way, on real data. creditAging originally
// produced one finding per account, reasoning that each is a separate
// conversation with a separate person. Run against the anchor café it produced
// TWENTY-FIVE, all identically shaped, which buried the four findings that
// actually mattered that month (voided sales, cost coverage, unallocated spend,
// a missed reconciliation). A brief nobody can read is worse than no brief.
//
// So per-subject detectors name the few that matter and roll up the rest. The
// remainder is always STATED, never silently dropped — the same doctrine as the
// platform digest's maxPerSection ("and 16 more"), because a truncated list
// pretends it was complete.
//
// Detectors that are naturally bounded (marginSlip, capped by how many menu
// categories exist) do not need this. Detectors over an open-ended set (credit
// accounts, menu items) always do.
const MaxNamedPerDetector = 3

// capNamed keeps the first n findings — callers sort worst-first before calling —
// and folds the remainder into one summary finding built by rollup.
//
// rollup receives the findings that did not make the cut and returns the single
// finding that stands for them. It is only called when there IS a remainder, so
// it never has to handle an empty slice.
func capNamed(findings []Finding, n int, rollup func(rest []Finding) Finding) []Finding {
	if len(findings) <= n {
		return findings
	}
	kept := findings[:n:n]
	return append(kept, rollup(findings[n:]))
}

// sumFacts totals one int64 fact across findings, for building a roll-up
// sentence out of the numbers the individual findings already carried.
func sumFacts(findings []Finding, key string) int64 {
	var total int64
	for _, f := range findings {
		if v, ok := f.Facts[key].(int64); ok {
			total += v
		}
	}
	return total
}

// worstSeverity is the roll-up's severity: as loud as the loudest thing inside
// it. Rolling three `bad` accounts into a `warn` would quietly downgrade them.
func worstSeverity(findings []Finding) Severity {
	worst := SeverityWarn
	for _, f := range findings {
		if f.Severity.WorseThan(worst) {
			worst = f.Severity
		}
	}
	return worst
}

// namesOf lists subject labels, sorted, for a roll-up's Facts so the evidence
// view can show exactly who was folded in.
func namesOf(findings []Finding) []string {
	out := make([]string, 0, len(findings))
	for _, f := range findings {
		out = append(out, f.SubjectLabel)
	}
	sort.Strings(out)
	return out
}

// plural is the small grammar helper these roll-ups need. "1 accounts" is
// exactly the kind of sloppiness that makes an owner trust the numbers less.
func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// moneyTotal formats a summed amount for a roll-up sentence.
func moneyTotal(cents int64) string { return audit.Money(cents) }
