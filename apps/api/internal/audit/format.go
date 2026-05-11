package audit

import (
	"fmt"
	"strings"
)

// Money formats a cents amount as "Rs 1,234.56" so summaries are readable
// in the activity feed. We use "Rs " rather than the currency glyph to
// stay safe across fonts/terminals; the UI can re-style if desired.
func Money(cents int64) string {
	neg := ""
	if cents < 0 {
		neg = "-"
		cents = -cents
	}
	rupees := cents / 100
	paise := cents % 100

	// thousands separator (Indian-style grouping kept simple: 1,234,567)
	s := fmt.Sprintf("%d", rupees)
	if len(s) > 3 {
		var b strings.Builder
		head := len(s) % 3
		if head > 0 {
			b.WriteString(s[:head])
			if len(s) > head {
				b.WriteByte(',')
			}
		}
		for i := head; i < len(s); i += 3 {
			b.WriteString(s[i : i+3])
			if i+3 < len(s) {
				b.WriteByte(',')
			}
		}
		s = b.String()
	}
	return fmt.Sprintf("%sRs %s.%02d", neg, s, paise)
}

// Quote wraps a label in double quotes, collapsing empty strings.
func Quote(s string) string {
	if s == "" {
		return `""`
	}
	return `"` + s + `"`
}

// Truncate clips a string to n runes with an ellipsis. Used to keep
// summaries scannable in the UI.
func Truncate(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
