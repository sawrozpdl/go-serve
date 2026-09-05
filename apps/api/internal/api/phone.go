package api

import (
	"regexp"
	"strings"
)

// Phone validation, mirrored in TypeScript at packages/validation/src/phone.ts.
// This copy is the authoritative one — the client check is a courtesy so the
// person typing finds out before they submit.
//
// Nepal-shaped, because that is who uses the product, with a deliberate escape
// hatch: anything prefixed with '+' is treated as an international number and
// only length-checked. Someone typing a country code knows what they are
// doing; these rules exist to catch "123" and a half-typed number, not to
// refuse a supplier in Delhi.
//
// Keep the two implementations in step — phone_test.go and phone.test.ts run
// the same table.

var (
	nonDigits     = regexp.MustCompile(`\D`)
	nepalMobile   = regexp.MustCompile(`^9[678]\d{8}$`)
	nepalLandline = regexp.MustCompile(`^0\d{6,9}$`)
)

// phoneHint is shown under the field on the clients and reused as the API's
// rejection message, so the user reads the same sentence in both places.
const phoneHint = "Enter a 10-digit mobile (e.g. 9812345678) or a landline with its area code."

// normalizePhone reduces a number to digits with an optional single leading
// '+'. Formatting characters (spaces, dashes, parens, dots) are dropped.
func normalizePhone(raw string) string {
	s := strings.TrimSpace(raw)
	plus := strings.HasPrefix(s, "+")
	digits := nonDigits.ReplaceAllString(s, "")
	if plus {
		return "+" + digits
	}
	return digits
}

// validPhone reports whether raw is a number we are willing to store.
func validPhone(raw string) bool {
	v := normalizePhone(raw)
	if v == "" {
		return false
	}
	if strings.HasPrefix(v, "+") {
		d := v[1:]
		// 977 is ours, so hold it to the national rules rather than the loose
		// international length check — otherwise "+977 123" would pass.
		if strings.HasPrefix(d, "977") {
			return validNepalNational(d[3:])
		}
		return len(d) >= 8 && len(d) <= 15
	}
	// A bare 977-prefixed number (someone omitted the '+').
	if strings.HasPrefix(v, "977") && len(v) > 10 {
		return validNepalNational(v[3:])
	}
	return validNepalNational(v)
}

func validNepalNational(v string) bool {
	return nepalMobile.MatchString(v) || nepalLandline.MatchString(v)
}
