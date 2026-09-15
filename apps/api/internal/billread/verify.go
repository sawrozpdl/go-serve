package billread

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// The verifier. This file is the reason the rest of the feature can be trusted.
//
// internal/llm solved its problem by forbidding digits outright — one predicate,
// total, impossible to partially satisfy. That trick is unavailable here: a bill
// is digits and nothing else. So this file takes the job llm/verify.go declined,
// and bounds it so it stays winnable:
//
//   * every value arrives as a STRING and is re-parsed in Go;
//   * every parse is exact — no coercion, no "best effort", no rounding;
//   * anything that does not survive is DROPPED, not corrected.
//
// Dropping rather than fixing is the whole discipline. A blank field the
// operator has to fill is a visible, ordinary nuisance. A field that is present
// and subtly wrong — 1250.5 read as ₹1,250.05 — is money entered wrong by
// somebody who trusted the machine, and nothing downstream will ever question
// it. The failure has to be safe in the direction that is noticeable.

const (
	MaxVendorLen    = 120
	MaxReferenceLen = 64
	MaxLineItems    = 50
	// MaxAmountCents is ₹10 crore. A cafe's supplier bill is not this, and an
	// amount above it is a misread decimal or a phone number, never a total.
	MaxAmountCents = 100_000_000_00
	// MaxBillAgeDays bounds how far back a bill date may be. Older is a
	// misparsed year, which is the most common date failure by far.
	MaxBillAgeDays = 365
)

// modelReply is the JSON contract. Every numeric field is a STRING: making the
// model emit JSON numbers would hand the parsing to encoding/json, where
// "1,250.50" fails silently as a zero and 1250.5 arrives as a float64 whose
// conversion to paisa is exactly the rounding bug money.go exists to prevent.
type modelReply struct {
	Vendor    string `json:"vendor"`
	Amount    string `json:"amount"`
	PaidAt    string `json:"paid_at"`
	Reference string `json:"reference"`
	LineItems []struct {
		Description string `json:"description"`
		QtyText     string `json:"qty_text"`
		Amount      string `json:"amount"`
	} `json:"line_items"`
}

var (
	// Digits, with at most one decimal point and at most two decimal places.
	// Deliberately strict: "1.2.3", "1e3" and "12.345" are all rejected rather
	// than interpreted.
	amountRe = regexp.MustCompile(`^\d{1,9}(\.\d{1,2})?$`)
	// A bill number is printed characters, not prose. Anything outside this is
	// the model having narrated instead of quoting.
	referenceRe = regexp.MustCompile(`^[A-Za-z0-9/\-_. #]{1,64}$`)
	isoDateRe   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// stripFence removes a ```json … ``` wrapper. Providers add these even when
// asked for raw JSON and even with responseMimeType set. Copied from llm rather
// than shared: it is eight lines, and coupling the two packages so that a change
// for one silently alters the other is the thing worth avoiding.
func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	s = strings.TrimPrefix(s, "```")
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
}

// parseAmountCents converts a printed amount to integer paisa.
//
// Integer arithmetic throughout — never strconv.ParseFloat followed by *100.
// That path turns "0.07" into 7.000000000000001 and "8.10" into 809, which is
// the precise class of error api/money.go's header was written about. Splitting
// on the decimal point and zero-padding cannot drift.
//
// Returns ok=false for anything it cannot read exactly.
func parseAmountCents(raw string) (int64, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	// Strip what a printed total wears: currency words, symbols, thousands
	// separators and spaces. Nothing here changes the VALUE.
	for _, junk := range []string{"NPR", "npr", "Rs.", "Rs", "rs", "₹", ",", " ", " "} {
		s = strings.ReplaceAll(s, junk, "")
	}
	if !amountRe.MatchString(s) {
		return 0, false
	}

	whole, frac, hasFrac := strings.Cut(s, ".")
	units, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, false
	}
	cents := int64(0)
	if hasFrac {
		// Zero-pad so "5" means 50 paisa and "05" means 5.
		for len(frac) < 2 {
			frac += "0"
		}
		cents, err = strconv.ParseInt(frac, 10, 64)
		if err != nil {
			return 0, false
		}
	}
	total := units*100 + cents
	if total <= 0 || total > MaxAmountCents {
		return 0, false
	}
	return total, true
}

// parseBillDate reads YYYY-MM-DD in the TENANT's timezone.
//
// Only that one format is accepted. "12/03/2026" is ambiguous between two
// continents and there is no way to tell which the printer meant; dropping it
// costs the operator one field, and guessing costs them a date that is wrong
// three quarters of the time in a way nobody notices for a month.
func parseBillDate(raw string, b Bill) (time.Time, bool) {
	s := strings.TrimSpace(raw)
	if !isoDateRe.MatchString(s) {
		return time.Time{}, false
	}
	loc := time.UTC
	if b.TZ != "" {
		if l, err := time.LoadLocation(b.TZ); err == nil {
			loc = l
		}
	}
	d, err := time.ParseInLocation("2006-01-02", s, loc)
	if err != nil {
		return time.Time{}, false
	}
	today := b.Today.In(loc)
	todayMidnight := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, loc)
	// A bill cannot be from the future, and one from before the cafe existed is
	// a misread year.
	if d.After(todayMidnight) {
		return time.Time{}, false
	}
	if d.Before(todayMidnight.AddDate(0, 0, -MaxBillAgeDays)) {
		return time.Time{}, false
	}
	return d, true
}

// cleanText strips control characters and bounds the length. Returns "" when
// nothing printable survives.
func cleanText(raw string, max int) string {
	var b strings.Builder
	for _, r := range raw {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	s := strings.TrimSpace(b.String())
	if s == "" {
		return ""
	}
	if len([]rune(s)) > max {
		return ""
	}
	return s
}

// hasDigit reports whether s contains at least one digit. Every invoice number
// has one; a sentence usually does not.
func hasDigit(s string) bool {
	for _, r := range s {
		if unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// hasLetter reports whether s contains at least one unicode letter. A "vendor"
// of "12345" is the model having read the invoice number into the wrong field.
func hasLetter(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}

// Verify parses and checks a model response.
//
// Exported and pure — no client, no network, no clock — so every rule above is
// tested directly rather than through a mock provider, exactly as llm.Verify is.
func Verify(raw string, b Bill) (Suggestion, error) {
	var reply modelReply
	if err := json.Unmarshal([]byte(stripFence(raw)), &reply); err != nil {
		return Suggestion{}, &RejectedError{Reason: "response was not JSON", Raw: truncate(raw, 500)}
	}

	var s Suggestion
	fields := []string{}

	if v := cleanText(reply.Vendor, MaxVendorLen); v != "" && hasLetter(v) {
		s.Vendor = v
		fields = append(fields, "vendor")
	}
	if cents, ok := parseAmountCents(reply.Amount); ok {
		s.AmountCents = &cents
		fields = append(fields, "amount_cents")
	}
	if d, ok := parseBillDate(reply.PaidAt, b); ok {
		s.PaidAt = &d
		fields = append(fields, "paid_at")
	}
	// A reference must look like a printed code AND contain a digit. The
	// character class alone is not enough: stripping a newline out of "the
	// number is on\nthe second page" leaves an ordinary sentence that matches
	// it perfectly, and the model narrating its own failure into the reference
	// field is a real and common way for this to go wrong.
	if r := cleanText(reply.Reference, MaxReferenceLen); r != "" &&
		referenceRe.MatchString(r) && hasDigit(r) {
		s.Reference = r
		fields = append(fields, "reference")
	}

	for i, li := range reply.LineItems {
		if i >= MaxLineItems {
			break
		}
		desc := cleanText(li.Description, 200)
		if desc == "" {
			continue
		}
		item := LineItem{Description: desc, QtyText: cleanText(li.QtyText, 40)}
		// An unreadable line amount keeps the description: the operator can
		// still see WHAT was bought, which is most of the value, and a nil
		// amount says plainly that this one was not read.
		if cents, ok := parseAmountCents(li.Amount); ok {
			item.AmountCents = &cents
		}
		s.LineItems = append(s.LineItems, item)
	}

	s.Fields = fields
	return s, nil
}
