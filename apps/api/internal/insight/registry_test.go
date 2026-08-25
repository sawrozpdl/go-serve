package insight

import (
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// The registry is data, so it gets linted like data. Every one of these has a
// failure mode that would otherwise only show up in production: a duplicate key
// silently merges two findings' lifecycles, an unknown permission means
// auth.Require rejects every request for it, an unknown feature means
// RequireFeature 403s forever, and a link template with the wrong arity emits
// "%!s(MISSING)" into an email.
func TestRegistry_KeysAreUniqueAndPresent(t *testing.T) {
	seen := map[string]bool{}
	for _, d := range Registry {
		if d.Key == "" {
			t.Errorf("detector %q has no Key", d.Label)
		}
		if seen[d.Key] {
			t.Errorf("duplicate detector key %q — two detectors would share one findings row", d.Key)
		}
		seen[d.Key] = true
		if d.Label == "" {
			t.Errorf("detector %q has no Label", d.Key)
		}
		if d.Fn == nil {
			t.Errorf("detector %q has no Fn", d.Key)
		}
	}
}

func TestRegistry_PermissionsExistInManifest(t *testing.T) {
	for _, d := range Registry {
		if d.Perm == "" {
			t.Errorf("detector %q has no Perm — every finding must be gated on something", d.Key)
			continue
		}
		if !rbac.M.IsKnown(d.Perm) {
			t.Errorf("detector %q wants permission %q, which is not in rbac/permissions.json",
				d.Key, d.Perm)
		}
	}
}

func TestRegistry_FeaturesExistInCatalogue(t *testing.T) {
	for _, d := range Registry {
		if d.Feature == "" {
			continue // ungated is a valid and common choice
		}
		if !billing.IsKnownFeature(string(d.Feature)) {
			t.Errorf("detector %q wants feature %q, which is not in billing.Registry",
				d.Key, d.Feature)
		}
	}
}

// A detector's LinkTpl and the LinkArgs its findings carry have to agree. This
// runs every detector over an empty snapshot AND over a populated one, so
// detectors that only produce findings when there is something to report are
// still covered.
func TestRegistry_LinkArityMatches(t *testing.T) {
	now := fixedNow()
	for _, in := range []Inputs{{}, richInputs()} {
		for _, d := range Registry {
			for _, f := range d.Run(now, in) {
				if got := countVerbs(d.LinkTpl); got != len(f.LinkArgs) {
					t.Errorf("detector %q: LinkTpl %q takes %d args but the finding carries %d",
						d.Key, d.LinkTpl, got, len(f.LinkArgs))
				}
			}
		}
	}
}

// An empty café must produce no findings at all. This is the single most
// important property in the package: a brand-new café that has recorded nothing
// gets silence, not a list of things it has failed to do.
func TestRunAll_EmptyInputsSaysNothing(t *testing.T) {
	if got := RunAll(fixedNow(), Inputs{}); len(got) != 0 {
		for _, f := range got {
			t.Logf("unexpected finding: %s — %s", f.DetectorKey, f.Detail)
		}
		t.Fatalf("empty inputs produced %d findings, want 0", len(got))
	}
}

// Every finding any detector can produce must be well-formed. Cheap to assert
// once here rather than in every detector's own test.
func TestRunAll_FindingsAreWellFormed(t *testing.T) {
	for _, f := range RunAll(fixedNow(), richInputs()) {
		if f.DetectorKey == "" {
			t.Errorf("finding %q has no DetectorKey — Detector.Run should have stamped it", f.Detail)
		}
		if f.Severity != SeverityWarn && f.Severity != SeverityBad {
			t.Errorf("%s: severity %q is neither warn nor bad", f.DetectorKey, f.Severity)
		}
		if f.Detail == "" {
			t.Errorf("%s: no Detail — the sentence IS the product", f.DetectorKey)
		}
		if f.Unit == "" {
			t.Errorf("%s: no Unit, so the number cannot be formatted", f.DetectorKey)
		}
		if f.SubjectKind == "" {
			t.Errorf("%s: no SubjectKind", f.DetectorKey)
		}
		if f.SubjectKind != SubjectTenant && f.SubjectKey == "" {
			t.Errorf("%s: SubjectKind %q needs a SubjectKey", f.DetectorKey, f.SubjectKind)
		}
	}
}
