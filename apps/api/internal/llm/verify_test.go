package llm

import (
	"encoding/json"
	"strings"
	"testing"
)

// These tests ARE the guarantee. Everything else in the insight feature rests on
// the claim that a language model cannot put a number in front of a café owner,
// and this file is where that claim is either true or isn't.

func reply(t *testing.T, order []string, headline, body string) string {
	t.Helper()
	b, err := json.Marshal(modelReply{Order: order, Headline: headline, Body: body})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

var allowed = []string{"void_rate", "cost_coverage", "unallocated_spend"}

func TestVerify_AcceptsCleanProse(t *testing.T) {
	raw := reply(t, []string{"unallocated_spend", "void_rate"},
		"A quiet week, with one thing to tidy",
		"Most of the week went smoothly. The one thing worth an hour of your time is "+
			"tagging last month's spending, which is what turns your category margins from a "+
			"guess into a figure. Voids are also worth a glance.")

	got, err := Verify(raw, allowed)
	if err != nil {
		t.Fatalf("clean prose rejected: %v", err)
	}
	if len(got.Order) != 2 || got.Order[0] != "unallocated_spend" {
		t.Errorf("order = %v", got.Order)
	}
	if got.Headline == "" || got.Body == "" {
		t.Error("headline and body must survive verification")
	}
}

// THE rule. Any digit at all, anywhere in the prose.
func TestVerify_RejectsAnyDigitInProse(t *testing.T) {
	cases := []struct{ name, headline, body string }{
		{"a figure in the body", "A quiet week", "Voids ran at 4.6% of takings, which is high."},
		{"a figure in the headline", "Rs 91,570 is untagged", "Worth tidying up."},
		{"a bare year", "A quiet week", "Better than the same week in 2025."},
		{"a single digit", "A quiet week", "There is 1 thing to look at."},
		{"a digit inside a word", "A quiet week", "Check the T2 terminal float."},
		// Devanagari digits are digits. An ASCII-only check would let exactly the
		// locale this product serves through the gap — and it would be the harder
		// bug to notice, because it only appears in Nepali output.
		{"devanagari digits", "A quiet week", "बिक्री ४ प्रतिशत घट्यो।"},
		{"arabic-indic digits", "A quiet week", "Sales fell ٤ percent."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Verify(reply(t, []string{"void_rate"}, tc.headline, tc.body), allowed)
			if err == nil {
				t.Fatal("a digit in the prose must be rejected")
			}
			if !strings.Contains(err.Error(), "digit") {
				t.Errorf("error should name the problem, got %q", err)
			}
		})
	}
}

// Spelled-out quantities are fine — that is the whole point of the trade. The
// model says "noticeably"; the line beneath says by how much.
func TestVerify_AllowsSpelledOutQuantities(t *testing.T) {
	raw := reply(t, []string{"void_rate"}, "Voids are worth a look this week",
		"Voids ran noticeably higher than usual — closer to one in twenty items than one in "+
			"fifty. The figure below is the exact share.")
	if _, err := Verify(raw, allowed); err != nil {
		t.Fatalf("prose without digits must pass: %v", err)
	}
}

// "The model never selects" — enforced, not requested.
func TestVerify_RejectsAKeyItWasNotGiven(t *testing.T) {
	_, err := Verify(reply(t, []string{"void_rate", "margin_slip"}, "x", "y"), allowed)
	if err == nil {
		t.Fatal("promoting an unknown key must be rejected")
	}
	if !strings.Contains(err.Error(), "margin_slip") {
		t.Errorf("error should name the offending key, got %q", err)
	}
}

func TestVerify_AllowsReorderingAndDropping(t *testing.T) {
	// Reordering is the model's whole remit; dropping is allowed because it may
	// legitimately decide two findings are one story.
	for _, order := range [][]string{
		{"cost_coverage", "void_rate", "unallocated_spend"},
		{"void_rate"},
		{},
	} {
		if _, err := Verify(reply(t, order, "x", "some prose"), allowed); err != nil {
			t.Errorf("order %v must be allowed: %v", order, err)
		}
	}
}

func TestVerify_RejectsARepeatedKey(t *testing.T) {
	// A duplicate would render the same finding twice in one email.
	if _, err := Verify(reply(t, []string{"void_rate", "void_rate"}, "x", "y"), allowed); err == nil {
		t.Fatal("a repeated key must be rejected")
	}
}

func TestVerify_RejectsEmptyOrOverlongProse(t *testing.T) {
	if _, err := Verify(reply(t, nil, "x", "   "), allowed); err == nil {
		t.Error("empty body must be rejected")
	}
	if _, err := Verify(reply(t, nil, strings.Repeat("a", MaxHeadlineLen+1), "ok"), allowed); err == nil {
		t.Error("an overlong headline must be rejected")
	}
	if _, err := Verify(reply(t, nil, "x", strings.Repeat("a", MaxBodyLen+1)), allowed); err == nil {
		t.Error("an overlong body must be rejected")
	}
}

func TestVerify_RejectsNonJSON(t *testing.T) {
	for _, raw := range []string{"", "not json at all", "{unclosed"} {
		if _, err := Verify(raw, allowed); err == nil {
			t.Errorf("%q must be rejected", raw)
		}
	}
}

// Providers sometimes fence JSON even when asked for application/json.
// Tolerating that is robustness, not laxity — the strict rules still apply
// inside.
func TestVerify_ToleratesAMarkdownFence(t *testing.T) {
	inner := reply(t, []string{"void_rate"}, "A quiet week", "Nothing much happened.")
	fenced := "```json\n" + inner + "\n```"
	if _, err := Verify(fenced, allowed); err != nil {
		t.Fatalf("a fenced response must still parse: %v", err)
	}
	// …and a fenced response with a digit is still rejected.
	bad := "```json\n" + reply(t, nil, "x", "Sales fell 4 percent.") + "\n```"
	if _, err := Verify(bad, allowed); err == nil {
		t.Fatal("fencing must not smuggle a digit past the guard")
	}
}

func TestIsRejected_DistinguishesGuardFromOutage(t *testing.T) {
	// The caller records these differently: a timeout is an outage, a rejection
	// is the guard working.
	if !IsRejected(&RejectedError{Reason: "digit"}) {
		t.Error("a RejectedError must report as rejected")
	}
	if IsRejected(ErrDisabled) || IsRejected(ErrBudget) {
		t.Error("disabled and budget are not verification failures")
	}
}

// --- the nil-client contract ---------------------------------------------

// A nil *Client is the DEFAULT state in dev, in CI, and in prod until a key is
// set. It must be safe to call, so no caller ever has to gate.
func TestNilClient_IsASafeNoOp(t *testing.T) {
	var c *Client
	if c.Enabled() {
		t.Error("a nil client is not enabled")
	}
	if c.Model() != "" {
		t.Error("a nil client has no model")
	}
	if c.BudgetMicros() != 0 {
		t.Error("a nil client has no budget")
	}
	if _, err := c.Write(nil, Request{}); err != ErrDisabled {
		t.Errorf("Write on a nil client = %v, want ErrDisabled", err)
	}
}

func TestNew_WithoutAKeyReturnsNil(t *testing.T) {
	if New(Config{}) != nil {
		t.Fatal("no key must mean no client — that is what makes the fallback the default path")
	}
	c := New(Config{APIKey: "k"})
	if c == nil || c.Model() != DefaultModel {
		t.Fatalf("a configured client should default its model, got %v", c)
	}
}

// --- pricing --------------------------------------------------------------

func TestCostMicros_ChargesForBothDirections(t *testing.T) {
	// 1M in + 1M out on flash-lite = 0.075 + 0.30 USD.
	got := CostMicros("gemini-2.0-flash-lite", 1_000_000, 1_000_000)
	if want := int64(375_000); got != want {
		t.Errorf("cost = %d micros, want %d", got, want)
	}
}

// An unknown model must cost the MOST expensive known rate. A missing entry has
// to overstate spend and trip the cap early — never understate it and let a
// runaway through.
func TestCostMicros_UnknownModelIsChargedAtTheTopRate(t *testing.T) {
	unknown := CostMicros("some-future-model", 1_000_000, 1_000_000)
	cheapest := CostMicros("gemini-2.0-flash-lite", 1_000_000, 1_000_000)
	if unknown <= cheapest {
		t.Errorf("unknown model cost %d must exceed the cheapest known %d", unknown, cheapest)
	}
}

func TestCostMicros_NeverRoundsARealChargeToZero(t *testing.T) {
	// A thousand calls each rounded to zero would make a real bill look free.
	if got := CostMicros("gemini-2.0-flash-lite", 1, 1); got < 1 {
		t.Errorf("a tiny charge rounded to %d, want at least 1 micro", got)
	}
	if got := CostMicros("gemini-2.0-flash-lite", 0, 0); got != 0 {
		t.Errorf("no tokens must cost nothing, got %d", got)
	}
}

func TestBudgetMicros_DefaultsWhenUnset(t *testing.T) {
	c := New(Config{APIKey: "k"})
	if got, want := c.BudgetMicros(), int64(DefaultMonthlyBudgetUSD*1e6); got != want {
		t.Errorf("budget = %d, want %d", got, want)
	}
}
