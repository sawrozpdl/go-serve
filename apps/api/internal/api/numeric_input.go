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

// nonNegativeNumeric reports whether a validated numeric string is >= 0.
// It runs on numericInput's output, so the sign is already ASCII-folded and
// the digits are already known to parse. "-0" and "-0.00" are negative zero,
// which is zero, so they pass.
func nonNegativeNumeric(s string) bool {
	if s == "" || s[0] != '-' {
		return true
	}
	return strings.Trim(s[1:], "0.") == ""
}

// requireNonNegativeNumeric is requireNumeric for fields that cannot be
// negative — par_low_units is a low-stock alert threshold, so a negative value
// describes an alert that can never fire. Callers must return on !ok.
//
// Deliberately NOT used for stock adjustments: delta_units is signed, and
// "remove 3 sticks" is the whole point of that field.
func requireNonNegativeNumeric(w http.ResponseWriter, field, raw string) (string, bool) {
	v, ok := requireNumeric(w, field, raw)
	if !ok {
		return "", false
	}
	if !nonNegativeNumeric(v) {
		writeErr(w, http.StatusBadRequest, "bad_number",
			fmt.Sprintf("%s cannot be negative (got %q)", field, raw))
		return "", false
	}
	return v, true
}

// requireNonNegativeNumericPtr is requireNonNegativeNumeric for optional
// (pointer) fields: a nil or blank value is left untouched so COALESCE keeps
// the stored value.
func requireNonNegativeNumericPtr(w http.ResponseWriter, field string, raw *string) bool {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return true
	}
	v, ok := requireNonNegativeNumeric(w, field, *raw)
	if !ok {
		return false
	}
	*raw = v
	return true
}
