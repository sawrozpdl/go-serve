package billread

import (
	"encoding/json"
	"testing"
	"time"
)

// A fixed instant, so every date rule is testable without a clock.
func testBill(t *testing.T) Bill {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatalf("load tz: %v", err)
	}
	return Bill{
		TZ:    "Asia/Kathmandu",
		Today: time.Date(2026, 9, 15, 12, 0, 0, 0, loc),
	}
}

func reply(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Money. The single most important thing in this file.
// ---------------------------------------------------------------------------

func TestParseAmount_ReadsPrintedTotals(t *testing.T) {
	cases := map[string]int64{
		"1250.50":     125050,
		"1,250.50":    125050,
		"Rs 1250.50":  125050,
		"Rs. 1250.50": 125050,
		"₹ 1250.50":   125050,
		"NPR1250.50":  125050,
		"1250":        125000,
		"1250.5":      125050, // one decimal place is tenths, not hundredths
		"0.07":        7,
		"8.10":        810,
		"0.01":        1,
	}
	for in, want := range cases {
		got, ok := parseAmountCents(in)
		if !ok {
			t.Fatalf("parseAmountCents(%q) refused a readable amount", in)
		}
		if got != want {
			t.Fatalf("parseAmountCents(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseAmount_NeverGoesThroughAFloat(t *testing.T) {
	// The two classic float-rounding pairs. ParseFloat("0.07")*100 is
	// 7.000000000000001 and ParseFloat("8.10")*100 is 809.9999999999999, so an
	// implementation that truncates gives 7 and 809 — off by a paisa, silently,
	// on the exact amounts most likely to appear on a real bill.
	if got, _ := parseAmountCents("0.07"); got != 7 {
		t.Fatalf("0.07 = %d paisa, want 7 — this is the float path", got)
	}
	if got, _ := parseAmountCents("8.10"); got != 810 {
		t.Fatalf("8.10 = %d paisa, want 810 — this is the float path", got)
	}
	if got, _ := parseAmountCents("1.15"); got != 115 {
		t.Fatalf("1.15 = %d paisa, want 115", got)
	}
}

func TestParseAmount_DropsAnythingItCannotReadExactly(t *testing.T) {
	// Every one of these is DROPPED, never coerced. A blank the operator fills
	// beats a plausible wrong number they will not question.
	for _, in := range []string{
		"", "   ", "abc", "-5", "1e3", "1.2.3", "12.345", "1/2",
		"0", "0.00", // a zero total is not a total
		"9999999999", // above MaxAmountCents
		"twelve",
	} {
		if got, ok := parseAmountCents(in); ok {
			t.Fatalf("parseAmountCents(%q) = %d, want dropped", in, got)
		}
	}
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

func TestParseBillDate_AcceptsOnlyUnambiguousISO(t *testing.T) {
	b := testBill(t)
	if _, ok := parseBillDate("2026-09-15", b); !ok {
		t.Fatal("today's date was refused")
	}
	if _, ok := parseBillDate("2026-09-01", b); !ok {
		t.Fatal("a recent date was refused")
	}
	// "12/03/2026" means two different days on two continents and the bill does
	// not say which. Guessing is wrong three quarters of the time.
	for _, in := range []string{"12/03/2026", "15-09-2026", "Sep 15 2026", "2026/09/15", ""} {
		if _, ok := parseBillDate(in, b); ok {
			t.Fatalf("parseBillDate(%q) was accepted — it is ambiguous or unparseable", in)
		}
	}
}

func TestParseBillDate_RejectsTheFutureAndTheDistantPast(t *testing.T) {
	b := testBill(t)
	if _, ok := parseBillDate("2026-09-16", b); ok {
		t.Fatal("a bill from tomorrow was accepted")
	}
	if _, ok := parseBillDate("2024-01-01", b); ok {
		t.Fatal("a bill from 600 days ago was accepted — that is a misread year")
	}
}

func TestParseBillDate_ResolvesInTheTenantsTimezone(t *testing.T) {
	// The same calendar day is a different instant in a different zone. The
	// expense date is a tenant-local fact, so this must follow the tenant.
	ktm := testBill(t)
	utc := Bill{TZ: "UTC", Today: ktm.Today}

	a, okA := parseBillDate("2026-09-15", ktm)
	c, okC := parseBillDate("2026-09-15", utc)
	if !okA || !okC {
		t.Fatal("both zones should accept the date")
	}
	if a.Equal(c) {
		t.Fatal("the same calendar day resolved to the same instant in two zones")
	}
	if a.Format("2006-01-02") != "2026-09-15" || c.Format("2006-01-02") != "2026-09-15" {
		t.Fatal("the calendar day itself changed")
	}
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

func TestVerify_DropsUnusableText(t *testing.T) {
	b := testBill(t)

	// A "vendor" of digits is the invoice number read into the wrong field.
	s, _ := Verify(reply(t, map[string]any{"vendor": "12345"}), b)
	if s.Vendor != "" {
		t.Fatalf("vendor = %q, want dropped", s.Vendor)
	}

	long := ""
	for i := 0; i < 300; i++ {
		long += "a"
	}
	s, _ = Verify(reply(t, map[string]any{"vendor": long}), b)
	if s.Vendor != "" {
		t.Fatal("an over-long vendor was kept")
	}

	s, _ = Verify(reply(t, map[string]any{"vendor": "Fresh\x00Foods\x07"}), b)
	if s.Vendor != "FreshFoods" {
		t.Fatalf("vendor = %q, want control characters stripped", s.Vendor)
	}

	// A reference is a printed code, not a sentence.
	s, _ = Verify(reply(t, map[string]any{"reference": "INV-2026/0912"}), b)
	if s.Reference != "INV-2026/0912" {
		t.Fatalf("reference = %q, want kept", s.Reference)
	}
	s, _ = Verify(reply(t, map[string]any{"reference": "the number is on\nthe second page"}), b)
	if s.Reference != "" {
		t.Fatal("a narrated reference was kept")
	}
}

// ---------------------------------------------------------------------------
// The contract as a whole
// ---------------------------------------------------------------------------

func TestVerify_FieldsNamesOnlyWhatSurvived(t *testing.T) {
	b := testBill(t)
	// A good vendor, an unreadable amount, a future date, a fine reference.
	s, err := Verify(reply(t, map[string]any{
		"vendor":    "Fresh Foods",
		"amount":    "twelve hundred",
		"paid_at":   "2026-12-25",
		"reference": "INV-99",
	}), b)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if s.AmountCents != nil {
		t.Fatal("an unreadable amount produced a value")
	}
	if s.PaidAt != nil {
		t.Fatal("a future date produced a value")
	}
	want := map[string]bool{"vendor": true, "reference": true}
	if len(s.Fields) != 2 {
		t.Fatalf("fields = %v, want exactly the two that survived", s.Fields)
	}
	for _, f := range s.Fields {
		if !want[f] {
			t.Fatalf("fields contains %q, which did not survive", f)
		}
	}
}

func TestVerify_LineItemsAreAdvisoryAndBounded(t *testing.T) {
	b := testBill(t)
	items := make([]map[string]any, 80)
	for i := range items {
		items[i] = map[string]any{"description": "Item", "qty_text": "2 kg", "amount": "100.00"}
	}
	// One line the model could not read the amount of.
	items[0] = map[string]any{"description": "Smudged line", "qty_text": "?", "amount": "~~~"}

	s, err := Verify(reply(t, map[string]any{"line_items": items}), b)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(s.LineItems) != MaxLineItems {
		t.Fatalf("line items = %d, want capped at %d", len(s.LineItems), MaxLineItems)
	}
	if s.LineItems[0].AmountCents != nil {
		t.Fatal("an unreadable line amount produced a value")
	}
	if s.LineItems[0].Description != "Smudged line" {
		t.Fatal("the description was dropped along with the amount — it is the useful half")
	}
	// Rule 3: line items are never summed into anything.
	if s.AmountCents != nil {
		t.Fatal("line items were reconciled into a total — they must never be")
	}
}

func TestVerify_LineItemsKeepQtyAsText(t *testing.T) {
	b := testBill(t)
	s, _ := Verify(reply(t, map[string]any{
		"line_items": []map[string]any{{"description": "Flour", "qty_text": "2.5 kg", "amount": "250"}},
	}), b)
	if len(s.LineItems) != 1 || s.LineItems[0].QtyText != "2.5 kg" {
		t.Fatalf("qty = %+v, want the printed text kept verbatim", s.LineItems)
	}
}

func TestVerify_AcceptsAFencedReply(t *testing.T) {
	b := testBill(t)
	s, err := Verify("```json\n{\"vendor\":\"Fresh Foods\",\"amount\":\"100\"}\n```", b)
	if err != nil {
		t.Fatalf("a fenced reply was rejected: %v", err)
	}
	if s.Vendor != "Fresh Foods" || s.AmountCents == nil || *s.AmountCents != 10000 {
		t.Fatalf("fenced reply parsed wrong: %+v", s)
	}
}

func TestVerify_RejectsNonJSON(t *testing.T) {
	b := testBill(t)
	_, err := Verify("I could not read this bill, sorry!", b)
	if err == nil {
		t.Fatal("prose was accepted as a reply")
	}
	if !IsRejected(err) {
		t.Fatalf("err = %v, want a RejectedError so the caller can tell it from an outage", err)
	}
}

func TestVerify_EmptyReplyYieldsNothingAndNoError(t *testing.T) {
	// An honest "I could not read any of it" is a normal outcome, not an error:
	// the form simply prefills nothing.
	b := testBill(t)
	s, err := Verify(`{"vendor":"","amount":"","paid_at":"","reference":""}`, b)
	if err != nil {
		t.Fatalf("an all-blank reply errored: %v", err)
	}
	if len(s.Fields) != 0 {
		t.Fatalf("fields = %v, want empty", s.Fields)
	}
}

// ---------------------------------------------------------------------------
// The off switch
// ---------------------------------------------------------------------------

func TestNilClientIsAValidNoOp(t *testing.T) {
	var c *Client
	if c.Enabled() {
		t.Fatal("a nil client reported itself enabled")
	}
	if c.Model() != "" || c.BudgetMicros() != 0 {
		t.Fatal("a nil client reported a model or a budget")
	}
	if _, err := c.Extract(t.Context(), Bill{Data: []byte("x"), MimeType: "image/png"}); err != ErrDisabled {
		t.Fatalf("Extract on a nil client = %v, want ErrDisabled", err)
	}
}

func TestNewReturnsNilWithoutAKey(t *testing.T) {
	if New(Config{}) != nil {
		t.Fatal("New returned a client with no API key — the feature must be off by default")
	}
	c := New(Config{APIKey: "k"})
	if c == nil || c.Model() != DefaultModel {
		t.Fatal("New did not apply the default model")
	}
}

func TestExtract_RefusesAnOversizeBill(t *testing.T) {
	c := New(Config{APIKey: "k"})
	if _, err := c.Extract(t.Context(), Bill{Data: make([]byte, MaxBillBytes+1), MimeType: "image/png"}); err != ErrTooLarge {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}
