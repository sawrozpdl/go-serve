package api

import (
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Display-name normalization for the things a café names itself: menu items,
// categories. Mirrored in TypeScript at packages/validation/src/name.ts — this
// copy is the authoritative one, the client check is a courtesy so the person
// typing finds out before they submit. Keep the two in step: name_test.go and
// name.test.ts run the same table.
//
// This exists because the three write paths disagreed. The web form sent the
// name untrimmed, the mobile sheet trimmed it, and bulk import trimmed it and
// deduped case-insensitively — one column, three behaviours. Worse,
// CreateMenuItem rejected an empty name while UpdateMenuItem validated nothing
// at all, so a PATCH could blank a name that could never have been created.
//
// The rules are deliberately permissive about punctuation. A café that wants to
// call a drink "Cafe+Mocha (2-shot!)" is not making a mistake, and refusing it
// would be us imposing taste. What we do refuse is the stuff that has no
// business in a display name and that silently breaks things downstream:
//
//   - Runs of whitespace, and leading/trailing whitespace, which make two
//     visually identical names distinct rows and defeat search.
//   - Control characters. A newline inside a name breaks the ESC/POS docket
//     (one \n = one line feed on the printer) and the CSV export.
//   - Format characters — zero-width joiners, zero-width spaces, and the bidi
//     overrides (U+202A-U+202E, U+2066-U+2069). An invisible character makes a
//     name unsearchable; a bidi override can reorder how the whole line renders.
//   - Anything over nameMaxRunes. Counted in RUNES, not bytes, so a Devanagari
//     name gets the same 80 characters an ASCII one does.
const nameMaxRunes = 80

// nameHint is shown under the field on the clients and reused as the API's
// rejection message, so the user reads the same sentence in both places.
const nameHint = "Use 1-80 characters. Punctuation is fine; line breaks and invisible characters are not."

// normalizeName folds a user-supplied display name to its storable form. It is
// idempotent: normalizeName(normalizeName(s)) == normalizeName(s).
//
// NFC composition runs first so "é" typed as e+combining-accent becomes the
// single code point Postgres and every search path will compare against. Two
// names that look identical must not be two rows.
func normalizeName(s string) string {
	s = norm.NFC.String(s)

	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		// Tabs and newlines are meant as separators, so they become a space and
		// get collapsed below rather than joining two words together.
		case r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f':
			b.WriteByte(' ')
		// NBSP and friends look like a space, so make them one.
		case unicode.Is(unicode.Zs, r):
			b.WriteByte(' ')
		// Remaining controls, format/bidi characters, surrogates and private-use
		// code points are dropped outright — they render as nothing or as a box.
		case unicode.Is(unicode.Cc, r), unicode.Is(unicode.Cf, r),
			unicode.Is(unicode.Cs, r), unicode.Is(unicode.Co, r):
			continue
		default:
			b.WriteRune(r)
		}
	}

	return strings.Join(strings.Fields(b.String()), " ")
}

// nameInput normalizes and length-checks a display name, reporting false when
// nothing usable is left or when it is too long to fit a receipt line.
func nameInput(s string) (string, bool) {
	v := normalizeName(s)
	if v == "" || utf8.RuneCountInString(v) > nameMaxRunes {
		return "", false
	}
	return v, true
}

// requireName validates a required display-name body field, writing a 400 and
// returning ok=false when it is unusable. Callers must return on !ok.
func requireName(w http.ResponseWriter, field, raw string) (string, bool) {
	v, ok := nameInput(raw)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_name", fmt.Sprintf("%s: %s", field, nameHint))
		return "", false
	}
	return v, true
}

// requireNamePtr is requireName for optional (pointer) fields on a PATCH: a nil
// value is left alone so COALESCE keeps the stored name, but a value that IS
// present must be valid. This is the half UpdateMenuItem was missing — it let
// `{"name": ""}` through and blanked the row.
func requireNamePtr(w http.ResponseWriter, field string, raw **string) bool {
	if *raw == nil {
		return true
	}
	v, ok := requireName(w, field, **raw)
	if !ok {
		return false
	}
	*raw = &v
	return true
}
