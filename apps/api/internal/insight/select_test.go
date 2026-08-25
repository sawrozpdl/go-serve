package insight

import (
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
)

func f(key string, sev Severity, unit Unit, v float64, label string) Finding {
	return Finding{DetectorKey: key, Severity: sev, Unit: unit, MetricValue: v,
		SubjectLabel: label, SubjectKind: SubjectTenant}
}

func keysOf(fs []Finding) []string {
	out := make([]string, len(fs))
	for i, x := range fs {
		out[i] = x.DetectorKey
	}
	return out
}

func TestRank_SeverityBeatsEverything(t *testing.T) {
	// dead_items is last in Registry; integrity is first. A `bad` dead_items must
	// still outrank a `warn` integrity, because severity is the first key.
	got := Rank([]Finding{
		f("integrity", SeverityWarn, UnitCount, 1, "a"),
		f("dead_items", SeverityBad, UnitCount, 1, "b"),
	})
	if got[0].DetectorKey != "dead_items" {
		t.Fatalf("order = %v, want the bad one first", keysOf(got))
	}
}

func TestRank_WithinSeverityUsesRegistryOrder(t *testing.T) {
	// Registry order is an editorial judgement about what matters to an owner,
	// written down once. Within a severity it decides.
	got := Rank([]Finding{
		f("dead_items", SeverityWarn, UnitCount, 100, "a"),
		f("void_rate", SeverityWarn, UnitRatio, 0.01, "b"),
		f("integrity", SeverityWarn, UnitCount, 1, "c"),
	})
	want := []string{"integrity", "void_rate", "dead_items"}
	for i, k := range want {
		if got[i].DetectorKey != k {
			t.Fatalf("order = %v, want %v", keysOf(got), want)
		}
	}
}

func TestRank_MoneyBreaksTiesOnlyBetweenMoney(t *testing.T) {
	// Same detector, same severity, both in cents: the bigger loss leads.
	got := Rank([]Finding{
		f("below_cost", SeverityBad, UnitCents, 1_000, "small"),
		f("below_cost", SeverityBad, UnitCents, 90_000, "big"),
	})
	if got[0].SubjectLabel != "big" {
		t.Fatalf("expected the larger amount first, got %q", got[0].SubjectLabel)
	}

	// A ratio and a count must NOT be compared numerically — 0.9 vs 17 says
	// nothing. Ties fall through to the label, deterministically.
	stable := Rank([]Finding{
		f("dead_items", SeverityWarn, UnitCount, 17, "zebra"),
		f("dead_items", SeverityWarn, UnitRatio, 0.9, "alpha"),
	})
	if stable[0].SubjectLabel != "alpha" {
		t.Fatalf("cross-unit ties must fall back to the label, got %q", stable[0].SubjectLabel)
	}
}

func TestRank_DoesNotMutateItsInput(t *testing.T) {
	// The caller keeps the full list for the findings page while the brief takes
	// a ranked slice; sorting in place would reorder both.
	in := []Finding{
		f("dead_items", SeverityWarn, UnitCount, 1, "a"),
		f("integrity", SeverityBad, UnitCount, 1, "b"),
	}
	_ = Rank(in)
	if in[0].DetectorKey != "dead_items" {
		t.Fatal("Rank mutated its argument")
	}
}

// allowAll is a viewer who can see everything.
func allowAll() Viewer {
	return Viewer{
		Can:        func(string) bool { return true },
		HasFeature: func(billing.FeatureKey) bool { return true },
	}
}

func TestVisible_DropsFeatureGatedFindings(t *testing.T) {
	// unallocated_spend is gated on the profitability feature.
	v := allowAll()
	v.HasFeature = func(k billing.FeatureKey) bool { return k != "profitability" }

	got := Visible([]Finding{
		f("unallocated_spend", SeverityBad, UnitRatio, 0, "x"),
		f("void_rate", SeverityWarn, UnitRatio, 0.05, "y"),
	}, v)
	if len(got) != 1 || got[0].DetectorKey != "void_rate" {
		t.Fatalf("got %v, want only void_rate", keysOf(got))
	}
}

func TestVisible_DropsFindingsTheViewerCannotSee(t *testing.T) {
	// A cashier without report:read has no business reading margin analysis.
	// Briefs are filtered per RECIPIENT, not per café.
	v := allowAll()
	v.Can = func(p string) bool { return p == "shift:read" }

	got := Visible([]Finding{
		f("void_rate", SeverityWarn, UnitRatio, 0.05, "x"),     // report:read
		f("shift_discipline", SeverityWarn, UnitCount, 2, "y"), // shift:read
	}, v)
	if len(got) != 1 || got[0].DetectorKey != "shift_discipline" {
		t.Fatalf("got %v, want only shift_discipline", keysOf(got))
	}
}

func TestVisible_RespectsMuting(t *testing.T) {
	v := allowAll()
	v.Muted = map[string]bool{"dead_items": true}
	got := Visible([]Finding{
		f("dead_items", SeverityWarn, UnitCount, 9, "x"),
		f("void_rate", SeverityWarn, UnitRatio, 0.05, "y"),
	}, v)
	if len(got) != 1 || got[0].DetectorKey != "void_rate" {
		t.Fatalf("got %v, want the muted detector dropped", keysOf(got))
	}
}

func TestVisible_RetiredDetectorIsDroppedNotCrashed(t *testing.T) {
	// Stored rows outlive their detector. The brief must degrade, not fail.
	got := Visible([]Finding{f("a_detector_we_deleted", SeverityBad, UnitCount, 1, "x")}, allowAll())
	if len(got) != 0 {
		t.Fatalf("got %d findings for an unknown detector, want 0", len(got))
	}
}

func TestForBrief_CutsToTheLimitAndStatesTheRemainder(t *testing.T) {
	var in []Finding
	for i := 0; i < BriefLimit+4; i++ {
		in = append(in, f("void_rate", SeverityBad, UnitCents, float64(1000-i), "x"))
	}
	lead, more := ForBrief(in, allowAll())
	if len(lead) != BriefLimit {
		t.Errorf("lead = %d findings, want %d", len(lead), BriefLimit)
	}
	// A truncated list that does not say it was truncated pretends it was
	// complete — the platform digest's rule.
	if more != 4 {
		t.Errorf("more = %d, want 4", more)
	}
}

func TestForBrief_CountsRemainderAfterFiltering(t *testing.T) {
	// The remainder must count only what the viewer could actually have seen,
	// or an owner is told "and 5 more" about findings that do not exist for them.
	v := allowAll()
	v.HasFeature = func(k billing.FeatureKey) bool { return k != "profitability" }

	in := []Finding{
		f("void_rate", SeverityBad, UnitRatio, 0.1, "a"),
		f("unallocated_spend", SeverityBad, UnitRatio, 0, "b"),
		f("unallocated_spend", SeverityBad, UnitRatio, 0, "c"),
	}
	lead, more := ForBrief(in, v)
	if len(lead) != 1 || more != 0 {
		t.Fatalf("lead=%d more=%d, want 1 and 0", len(lead), more)
	}
}
