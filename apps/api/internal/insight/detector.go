package insight

import (
	"fmt"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
)

// DetectFunc is the whole of a detector's logic: a pure function from a snapshot
// to zero or more findings.
//
// `now` is explicit rather than read from the clock, mirroring health.Compute
// and billing.ComputeState, so every threshold and boundary is testable at a
// fixed instant. It is already in the café's own timezone.
type DetectFunc func(now time.Time, in Inputs) []Finding

// Detector is a struct wrapping a pure func rather than an interface, mirroring
// billing.Registry. The gates are declared as DATA next to the logic, which is
// what lets registry_test.go check every one of them against the RBAC manifest
// and the feature catalogue without running anything.
type Detector struct {
	// Key is the stable identity written to insight_findings.detector_key. It
	// outlives wording changes, so never rename one without a migration that
	// closes the old rows.
	Key string

	// Label is the short human name for the findings list and the settings
	// screen ("Unallocated spend"), not the sentence.
	Label string

	// Perm is the permission a member must hold to be shown this finding. A
	// cashier with no report:read has no business seeing margin analysis, and
	// the brief is filtered per recipient rather than per café.
	Perm string

	// Feature gates the detector behind a plan feature. Empty means ungated —
	// which is the right default for the money-truth detectors, because they are
	// the reason someone buys this.
	Feature billing.FeatureKey

	// LinkTpl is a printf template for the admin deep link, filled from
	// Finding.LinkArgs. Kept apart from the detector body so no detector ever
	// builds a URL and the lint can check that the verb count matches.
	LinkTpl string

	// Fn is the logic.
	Fn DetectFunc
}

// Link renders the deep link for a finding, or "" when the detector has no
// destination. Args that don't match the template are dropped rather than
// producing a "%!s(MISSING)" URL in an email.
func (d Detector) Link(f Finding) string {
	// An explicit path wins: see Finding.LinkPath.
	if f.LinkPath != "" {
		return f.LinkPath
	}
	if d.LinkTpl == "" {
		return ""
	}
	if countVerbs(d.LinkTpl) != len(f.LinkArgs) {
		return ""
	}
	return fmt.Sprintf(d.LinkTpl, f.LinkArgs...)
}

// countVerbs counts printf verbs in a template, treating "%%" as a literal.
// Used by Link and by registry_test.go's arity check.
func countVerbs(tpl string) int {
	n := 0
	for i := 0; i < len(tpl); i++ {
		if tpl[i] != '%' {
			continue
		}
		if i+1 < len(tpl) && tpl[i+1] == '%' {
			i++
			continue
		}
		n++
	}
	return n
}

// Run executes the detector and stamps its key onto every finding it produced,
// so a detector function cannot accidentally report under another's identity.
func (d Detector) Run(now time.Time, in Inputs) []Finding {
	out := d.Fn(now, in)
	for i := range out {
		out[i].DetectorKey = d.Key
	}
	return out
}
