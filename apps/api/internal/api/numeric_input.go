package api

import (
	"fmt"
	"net/http"
	"strings"
)

// Free-text quantity fields (delta_units, par_low_units, vat_pct, …) arrive as
// strings and reach Postgres as `$n::numeric` so the DB keeps full decimal
// precision. Anything Postgres can't parse comes back as 22P02, which the
// handlers report as an opaque 500 — prod hit exactly that when a phone
// keyboard sent "_1" instead of "-1" for a stock adjustment. Validating the
// string here turns that into a 400 the cashier can act on.

// numericInput normalizes a user-supplied decimal string, reporting false when
// it isn't a plain number. Typographic minus signs (which soft keyboards and
// copy-paste from documents produce) are folded to ASCII '-'.
func numericInput(s string) (string, bool) {
	s = strings.NewReplacer("−", "-", "–", "-", "—", "-").
		Replace(strings.TrimSpace(s))
	if s == "" {
		return "", false
	}
	i := 0
	if s[0] == '+' || s[0] == '-' {
		i = 1
	}
	digits, dots := 0, 0
	for ; i < len(s); i++ {
		switch c := s[i]; {
		case c >= '0' && c <= '9':
			digits++
		case c == '.':
			dots++
		default:
			return "", false
		}
	}
	if digits == 0 || dots > 1 {
		return "", false
	}
	return s, true
}

// requireNumeric validates a numeric body field, writing a 400 and returning
// ok=false when it isn't a plain number. Callers must return on !ok.
func requireNumeric(w http.ResponseWriter, field, raw string) (string, bool) {
	v, ok := numericInput(raw)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_number",
			fmt.Sprintf("%s must be a plain number like 2, -1 or 0.5 (got %q)", field, raw))
		return "", false
	}
	return v, true
}

// requireNumericPtr is requireNumeric for optional (pointer) fields: a nil or
// blank value is left untouched so COALESCE keeps the stored value.
func requireNumericPtr(w http.ResponseWriter, field string, raw *string) bool {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return true
	}
	v, ok := requireNumeric(w, field, *raw)
	if !ok {
		return false
	}
	*raw = v
	return true
}
