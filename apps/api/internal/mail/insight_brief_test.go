package mail

import (
	"strings"
	"testing"
	"time"
)

func sampleBrief() Brief {
	c := 0.63
	return Brief{
		CafeName:      "Sahan Cafe",
		Day:           time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC),
		Confidence:    &c,
		AppURL:        "https://app.test/",
		To:            []string{"owner@test.local"},
		UnsubscribeTo: "stop@goserve.test",
		Items: []BriefItem{
			{Severity: "bad", Label: "Unallocated spend", Detail: "None of it is tagged.", Link: "https://app.test/admin/expenses"},
			{Severity: "warn", Label: "Voided sales", Detail: "4.6% of takings."},
		},
		More: 5,
	}
}

// Nothing to say means nothing sent. This is the single most important property
// of the brief: "a digest that arrives every morning saying nothing happened is
// a digest people stop reading."
func TestBrief_EmptyWhenThereIsNothingToSay(t *testing.T) {
	if !(Brief{CafeName: "X"}).Empty() {
		t.Error("a brief with no items and no follow-ups must be empty")
	}
	if sampleBrief().Empty() {
		t.Error("a brief with items is not empty")
	}
	// Follow-ups alone are worth sending: the owner asked to be reminded.
	only := Brief{FollowUps: []BriefFollowUp{{Label: "x"}}}
	if only.Empty() {
		t.Error("a brief with only follow-ups must still send")
	}
}

func TestBrief_SubjectNamesTheCount(t *testing.T) {
	b := sampleBrief()
	if got := b.briefSubject(); !strings.Contains(got, "2 things to look at") {
		t.Errorf("subject = %q", got)
	}
	b.Items = b.Items[:1]
	if got := b.briefSubject(); !strings.Contains(got, "1 thing to look at") {
		t.Errorf("singular subject = %q", got)
	}
	// Follow-ups only get their own wording rather than "0 things to look at".
	b.Items = nil
	b.FollowUps = []BriefFollowUp{{Label: "a"}}
	if got := b.briefSubject(); !strings.Contains(got, "1 decision to review") {
		t.Errorf("follow-up subject = %q", got)
	}
}

// Scheduled bulk mail needs headers that transactional mail does not, or it
// lands in spam and auto-responders reply to it forever.
func TestBriefMessage_CarriesBulkHeaders(t *testing.T) {
	m := BriefMessage(sampleBrief())
	for k, want := range map[string]string{
		"Precedence":       "bulk",
		"Auto-Submitted":   "auto-generated",
		"List-Unsubscribe": "<mailto:stop@goserve.test?subject=unsubscribe>",
	} {
		if m.Headers[k] != want {
			t.Errorf("header %s = %q, want %q", k, m.Headers[k], want)
		}
	}
}

func TestBriefMessage_OmitsUnsubscribeWhenUnset(t *testing.T) {
	b := sampleBrief()
	b.UnsubscribeTo = ""
	if _, ok := BriefMessage(b).Headers["List-Unsubscribe"]; ok {
		t.Error("an empty address must omit the header rather than emit a broken mailto")
	}
}

// The remainder is always stated. A truncated list that does not say it was
// truncated pretends it was complete.
func TestBrief_StatesTheRemainder(t *testing.T) {
	txt := renderBriefText(sampleBrief())
	if !strings.Contains(txt, "and 5 more findings not listed here") {
		t.Errorf("text body must state the remainder:\n%s", txt)
	}
	one := sampleBrief()
	one.More = 1
	if !strings.Contains(renderBriefText(one), "and 1 one more finding") &&
		!strings.Contains(renderBriefText(one), "1 one more finding") {
		// Guard against "1 more findings"; the exact phrasing is asserted loosely
		// because it is copy, but the plural must agree.
		if strings.Contains(renderBriefText(one), "more findings") {
			t.Error("singular remainder rendered as plural")
		}
	}
}

// Books Confidence is the honest alternative to a made-up confidence interval,
// so its absence must read as "not enough recorded" and never as 0%.
func TestBrief_ConfidenceLineNeverImpliesZero(t *testing.T) {
	b := sampleBrief()
	b.Confidence = nil
	line := confidenceLine(b)
	if strings.Contains(line, "0%") {
		t.Errorf("a missing figure must not render as 0%%: %q", line)
	}
	if !strings.Contains(line, "not enough recorded yet") {
		t.Errorf("line = %q", line)
	}
}

// A follow-up with no comparison must say so rather than implying progress.
func TestBrief_FollowUpWithoutAComparisonSaysSo(t *testing.T) {
	got := followUpLine(BriefFollowUp{Label: "Voided sales", Moved: false, Improved: true,
		AcceptedOn: time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)})
	if !strings.Contains(got, "nothing to compare") {
		t.Errorf("got %q", got)
	}
	worse := followUpLine(BriefFollowUp{Label: "Voided sales", Moved: true, Improved: false,
		AcceptedOn: time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)})
	if !strings.Contains(worse, "has not improved") {
		t.Errorf("got %q", worse)
	}
}

// Header injection: a value with a newline would let anything downstream inject
// arbitrary headers or a body.
func TestSanitiseHeader_StripsNewlines(t *testing.T) {
	if got := sanitiseHeader("ok\r\nBcc: attacker@evil.test"); strings.Contains(got, "\n") ||
		strings.Contains(got, "\r") {
		t.Fatalf("newlines survived sanitisation: %q", got)
	}
}
