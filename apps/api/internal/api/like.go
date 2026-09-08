package api

import "strings"

// escapeLike makes a user-supplied search term safe to interpolate into a
// LIKE/ILIKE pattern as a LITERAL substring.
//
// Every search endpoint here builds its pattern as '%' || term || '%', so an
// unescaped term let the user's own metacharacters through: '_' matched any
// single character and '%' matched any run, so searching "C_fe" found
// "Cafe Mocha" and searching "%" found everything. Café menus really do carry
// names like "50% off combo", so this is a correctness bug, not a hardening
// exercise.
//
// Postgres LIKE treats backslash as the escape character by default, so the
// backslash itself must be doubled FIRST — otherwise escaping '%' would produce
// a backslash that the next pass would escape again.
//
// Note this deliberately does NOT add an ESCAPE clause: '\' is already the
// default, and every caller passes the pattern as a bind parameter, so there is
// no SQL-level quoting to worry about — only LIKE-level metacharacters.
func escapeLike(s string) string {
	if !strings.ContainsAny(s, `\%_`) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		switch r {
		case '\\', '%', '_':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
