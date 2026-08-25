package insight

import "time"

// Registry is every detector, in a deliberate order: money that does not
// reconcile, then money the café is losing, then the coverage gaps that make
// those numbers trustworthy, then operations.
//
// Order here is declaration order only — the brief's ordering is decided by
// select.go, so a reader of the brief always gets worst-first regardless of how
// this list happens to be arranged. Keeping it grouped anyway makes it obvious
// at a glance what this product is about.
//
// Adding a detector: append it here, and registry_test.go will refuse the build
// if the key collides, the permission is not in the RBAC manifest, the feature
// is not in the billing catalogue, or the link template's argument count does not
// match what the detector passes.
var Registry = []Detector{
	// Arithmetic that does not add up.
	integrity,

	// Money leaving without a sale behind it.
	paymentRetraction,
	voidRate,
	voidConcentration,
	discountRate,
	discountConcentration,

	// What the café actually keeps.
	belowCost,
	marginSlip,

	// Why those numbers can or cannot be trusted.
	costCoverage,
	unallocatedSpend,

	// Operations, restricted to the invisible.
	shiftDiscipline,
	drawerVariance,
	creditAging,
	deadItems,
}

// ByKey looks a detector up, for rendering a stored finding whose detector has
// to be consulted for its label or link. Missing is possible after a detector is
// retired while its rows are still around, so callers must handle !ok rather
// than assume.
func ByKey(key string) (Detector, bool) {
	for _, d := range Registry {
		if d.Key == key {
			return d, true
		}
	}
	return Detector{}, false
}

// RunAll executes every detector against one café's snapshot and returns
// everything they found, unfiltered and unranked. Filtering by the viewer's
// permissions and the café's plan happens in select.go; muting happens in
// store.go against what the café has already dismissed. Keeping those three
// concerns out of here is what lets this function be tested with nothing but a
// struct literal.
func RunAll(now time.Time, in Inputs) []Finding {
	var out []Finding
	for _, d := range Registry {
		out = append(out, d.Run(now, in)...)
	}
	return out
}
