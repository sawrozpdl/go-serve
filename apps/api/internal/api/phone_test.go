package api

import "testing"

// The same table runs in packages/validation/src/phone.test.ts. If you change
// a case here, change it there: two implementations that disagree mean the
// form accepts what the API then rejects, which is worse than either rule.
var phoneCases = []struct {
	in    string
	valid bool
	why   string
}{
	// Nepal mobiles — the overwhelmingly common case.
	{"9843413772", true, "NTC mobile"},
	{"9860099303", true, "Ncell mobile"},
	{"9612345678", true, "Smart mobile"},
	{"984-341-3772", true, "dashes are formatting"},
	{"984 341 3772", true, "spaces are formatting"},
	{" 9843413772 ", true, "surrounding whitespace"},
	{"+977 9843413772", true, "country code"},
	{"+9779843413772", true, "country code, unspaced"},
	{"9779843413772", true, "country code without the plus"},

	// Nepal landlines.
	{"014444444", true, "Kathmandu landline"},
	{"01-4444444", true, "landline with a dash"},
	{"061520000", true, "Pokhara landline"},

	// International — the '+' is the user asserting they meant it.
	{"+919876543210", true, "India"},
	{"+14155552671", true, "US"},

	// Rejected.
	{"", false, "empty"},
	{"   ", false, "whitespace only"},
	{"123", false, "far too short"},
	{"98434137", false, "mobile missing digits"},
	{"98434137721", false, "mobile with an extra digit"},
	{"1234567890", false, "10 digits but not a valid prefix"},
	{"5843413772", false, "mobile must start 96/97/98"},
	{"abcdefghij", false, "letters"},
	{"+977123", false, "country code cannot excuse a junk national number"},
	{"+1234567", false, "international too short"},
	{"+1234567890123456", false, "international too long"},
}

func TestValidPhone(t *testing.T) {
	for _, c := range phoneCases {
		if got := validPhone(c.in); got != c.valid {
			t.Errorf("validPhone(%q) = %v, want %v (%s)", c.in, got, c.valid, c.why)
		}
	}
}

func TestNormalizePhone(t *testing.T) {
	cases := map[string]string{
		"984-341-3772":    "9843413772",
		" 9843413772 ":    "9843413772",
		"+977 984 341 37": "+97798434137",
		"(01) 4444-444":   "014444444",
		"":                "",
	}
	for in, want := range cases {
		if got := normalizePhone(in); got != want {
			t.Errorf("normalizePhone(%q) = %q, want %q", in, got, want)
		}
	}
}
