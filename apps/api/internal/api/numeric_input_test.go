package api

// Unit tests for numericInput (no DB).

import "testing"

func TestNumericInput(t *testing.T) {
	cases := []struct {
		in   string
		want string // "" means: expect rejection
	}{
		{"5", "5"},
		{"-1", "-1"},
		{"+200", "+200"},
		{"0.5", "0.5"},
		{".5", ".5"},
		{"2.", "2."},
		{"  -3  ", "-3"},
		{"−2", "-2"},  // U+2212 minus (iOS / copy-paste)
		{"–2", "-2"},  // en-dash
		{"_1", ""},    // the prod 500: '_' shares the '-' key on phone keyboards
		{"1_000", ""}, //
		{"", ""},
		{"-", ""},
		{"abc", ""},
		{"1.2.3", ""},
		{"5 units", ""},
		{"1e5", ""},
		{"1,5", ""},
		{"NaN", ""},
	}
	for _, c := range cases {
		got, ok := numericInput(c.in)
		if c.want == "" {
			if ok {
				t.Errorf("numericInput(%q) = %q, true; want rejected", c.in, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Errorf("numericInput(%q) = %q, %v; want %q, true", c.in, got, ok, c.want)
		}
	}
}
