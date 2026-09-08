package api

import "testing"

// The shared table. packages/validation/src/name.test.ts runs the same cases —
// keep them in step.
var nameCases = []struct {
	in   string
	want string // "" means rejected
	why  string
}{
	{"Cafe Mocha", "Cafe Mocha", "ordinary name passes through untouched"},
	{"Cafe+Mocha----@DFG56789...", "Cafe+Mocha----@DFG56789...", "punctuation and symbols are a café's business, not ours"},
	{"  Cafe Mocha  ", "Cafe Mocha", "trimmed"},
	{"Cafe   Mocha", "Cafe Mocha", "internal whitespace runs collapse"},
	{"Cafe\tMocha", "Cafe Mocha", "tab becomes a separator, not a join"},
	{"Cafe\nMocha", "Cafe Mocha", "a newline would be a line feed on the ESC/POS docket"},
	{"Cafe Mocha", "Cafe Mocha", "NBSP is a space"},
	{"Cafe​Mocha", "CafeMocha", "zero-width space is dropped, not turned into a gap"},
	{"Cafe‮Mocha", "CafeMocha", "bidi override dropped — it can reorder the whole line"},
	{"चिया", "चिया", "Devanagari is a first-class name"},
	{"", "", "empty rejected"},
	{"   ", "", "whitespace-only rejected — this used to save as a blank name"},
	{"​​", "", "invisible-only rejected"},
	{"50% off", "50% off", "a percent sign in a name is fine; escapeLike keeps search honest"},
}

func TestNameInput(t *testing.T) {
	for _, c := range nameCases {
		got, ok := nameInput(c.in)
		if c.want == "" {
			if ok {
				t.Errorf("nameInput(%q) = %q, ok — want rejected (%s)", c.in, got, c.why)
			}
			continue
		}
		if !ok {
			t.Errorf("nameInput(%q) rejected — want %q (%s)", c.in, c.want, c.why)
			continue
		}
		if got != c.want {
			t.Errorf("nameInput(%q) = %q, want %q (%s)", c.in, got, c.want, c.why)
		}
	}
}

func TestNameInputLength(t *testing.T) {
	// Counted in runes, so a Devanagari name gets the same allowance an ASCII
	// one does — a byte cap would have cut this to 26 characters.
	long := ""
	for range nameMaxRunes {
		long += "अ"
	}
	if got, ok := nameInput(long); !ok || got != long {
		t.Errorf("%d-rune Devanagari name rejected, want accepted", nameMaxRunes)
	}
	if _, ok := nameInput(long + "अ"); ok {
		t.Errorf("%d-rune name accepted, want rejected", nameMaxRunes+1)
	}
	// Trimming happens BEFORE the cap, so trailing spaces can't push a
	// legitimate name over the edge.
	if _, ok := nameInput(long + "     "); !ok {
		t.Error("name at the cap plus trailing spaces rejected, want accepted")
	}
}

func TestNormalizeNameIsIdempotent(t *testing.T) {
	for _, c := range nameCases {
		once := normalizeName(c.in)
		if twice := normalizeName(once); twice != once {
			t.Errorf("normalizeName not idempotent for %q: %q → %q", c.in, once, twice)
		}
	}
}

func TestNormalizeNameComposesNFC(t *testing.T) {
	// "Café" decomposed (e + U+0301) must become the same string as the
	// precomposed form, or the two save as distinct rows and neither is findable.
	decomposed := "Café Mocha"
	precomposed := "Café Mocha"
	if got := normalizeName(decomposed); got != precomposed {
		t.Errorf("normalizeName(decomposed) = %q, want %q", got, precomposed)
	}
}

func TestEscapeLike(t *testing.T) {
	cases := []struct{ in, want, why string }{
		{"mocha", "mocha", "nothing to escape"},
		{"C_fe", `C\_fe`, "underscore matched any single char — this found 'Cafe'"},
		{"50%", `50\%`, "percent matched any run — this found everything"},
		{"%", `\%`, "a bare wildcard search returned the whole table"},
		{`back\slash`, `back\\slash`, "the escape char itself must double first"},
		{`50%\`, `50\%\\`, "both, in one term"},
		{"", "", "empty stays empty so the no-filter branch still fires"},
	}
	for _, c := range cases {
		if got := escapeLike(c.in); got != c.want {
			t.Errorf("escapeLike(%q) = %q, want %q (%s)", c.in, got, c.want, c.why)
		}
	}
}
