package insight

import (
	"sort"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
)

// Selection is deliberately NOT a score.
//
// The obvious design is to rank findings by severity × magnitude × recency and
// take the top three. It does not survive contact with the data: the magnitudes
// are in different units. "Rs 91,570 unallocated", "4.6% of takings voided",
// "1 missed reconciliation" and "17 dead menu items" cannot be put on one axis
// without inventing exchange rates between them, and any weights chosen would be
// arbitrary numbers dressed up as arithmetic — exactly the sort of false
// precision this whole feature is supposed to avoid.
//
// So the order is:
//
//	1. severity  — `bad` before `warn`, always
//	2. the DETECTOR's position in Registry — a deliberate editorial judgement
//	   about what matters to a café owner, written down once in one place
//	3. money, when the finding is denominated in money
//	4. subject label, so ties are stable
//
// The result is fully deterministic, which matters for more than tidiness: an
// accepted finding has to reappear in the same place when it comes due, and the
// email has to be testable.
//
// Filtering happens here too, and the order of the filters is not arbitrary
// either — plan gating before permissions before muting, so an upgrade prompt is
// never shown to somebody who could not have seen the finding anyway.

// Viewer is what a brief is being built for. A brief is filtered PER RECIPIENT,
// not per café: a cashier with no report:read has no business reading margin
// analysis, and the owner and the cashier can be sent different briefs from the
// same set of findings.
type Viewer struct {
	// Can reports whether the recipient holds a permission. rbac.PermissionSet
	// satisfies this.
	Can func(perm string) bool
	// HasFeature reports whether the café's plan includes a feature.
	HasFeature func(key billing.FeatureKey) bool
	// Muted holds detector keys this café has dismissed enough times to stop
	// hearing about. Three dismissals is the rule; see MutedDetectors.
	Muted map[string]bool
}

// detectorRank is Registry position, precomputed so sorting is not O(n²) over
// the registry for every comparison.
var detectorRank = func() map[string]int {
	m := make(map[string]int, len(Registry))
	for i, d := range Registry {
		m[d.Key] = i
	}
	return m
}()

// Rank orders findings worst-first, in place-safe fashion, and returns them.
func Rank(findings []Finding) []Finding {
	out := make([]Finding, len(findings))
	copy(out, findings)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Severity != b.Severity {
			return a.Severity.WorseThan(b.Severity)
		}
		ra, rb := detectorRank[a.DetectorKey], detectorRank[b.DetectorKey]
		if ra != rb {
			return ra < rb
		}
		// Only compare magnitudes when they are the same unit AND that unit is
		// money. Comparing a ratio against a count would be meaningless.
		if a.Unit == UnitCents && b.Unit == UnitCents && a.MetricValue != b.MetricValue {
			return a.MetricValue > b.MetricValue
		}
		return a.SubjectLabel < b.SubjectLabel
	})
	return out
}

// Visible drops findings the viewer must not or should not be shown.
func Visible(findings []Finding, v Viewer) []Finding {
	out := make([]Finding, 0, len(findings))
	for _, f := range findings {
		d, ok := ByKey(f.DetectorKey)
		if !ok {
			// A retired detector's stored rows stop being shown rather than
			// crashing the brief.
			continue
		}
		if d.Feature != "" && v.HasFeature != nil && !v.HasFeature(d.Feature) {
			continue
		}
		if d.Perm != "" && v.Can != nil && !v.Can(d.Perm) {
			continue
		}
		if v.Muted[f.DetectorKey] {
			continue
		}
		out = append(out, f)
	}
	return out
}

// BriefLimit is how many findings a single brief leads with. Three because that
// is roughly what somebody reads before opening the shop, and because a brief
// that lists everything is a report — which the product already has.
//
// Nothing is lost by the cut: everything stays on the findings page, and the
// brief says how many more there were.
const BriefLimit = 3

// ForBrief filters, ranks, and cuts. The second return value is how many
// visible findings did NOT make the cut, so the brief can state the remainder
// rather than pretending the list was complete — the platform digest's rule.
func ForBrief(findings []Finding, v Viewer) (lead []Finding, more int) {
	visible := Rank(Visible(findings, v))
	if len(visible) <= BriefLimit {
		return visible, 0
	}
	return visible[:BriefLimit], len(visible) - BriefLimit
}
