package mail

import (
	"strings"
	"testing"
	"time"
)

func wrapFixture() Wrap {
	c := 0.65
	return Wrap{
		CafeName:      "Sahan Cafe",
		WeekEnding:    time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC),
		Confidence:    &c,
		AppURL:        "https://app.test",
		To:            []string{"owner@test.local"},
		UnsubscribeTo: "stop@goserve.test",
		Items: []BriefItem{
			{Severity: "bad", Label: "Unallocated spend", Detail: "None of Rs 91,570 is tagged."},
			{Severity: "warn", Label: "Voided sales", Detail: "84 items, 4.6% of takings."},
		},
	}
}

// The fallback IS the email until somebody sets a key, so it has to read as
// written prose rather than as a placeholder. A fallback that reads like one
// would make the feature feel broken every time the model was unavailable.
func TestWrap_FallbackReadsAsRealProse(t *testing.T) {
	w := wrapFixture() // no Headline, no Narrative
	headline, body := w.resolved()

	if headline == "" || body == "" {
		t.Fatal("the deterministic opening must always produce something")
	}
	if strings.Contains(strings.ToLower(headline+body), "unavailable") ||
		strings.Contains(strings.ToLower(headline+body), "could not") {
		t.Errorf("the fallback must not apologise for itself: %q / %q", headline, body)
	}
	if !strings.Contains(headline, "worth your time") {
		t.Errorf("headline = %q", headline)
	}
}

func TestWrap_FallbackAdaptsToTheFindingCount(t *testing.T) {
	w := wrapFixture()

	w.Items = nil
	if h, _ := w.resolved(); h != "A quiet week" {
		t.Errorf("no findings = %q, want a plainly good-news headline", h)
	}
	w.Items = wrapFixture().Items[:1]
	if h, _ := w.resolved(); !strings.Contains(h, "One thing") {
		t.Errorf("one finding = %q", h)
	}
	w.Items = wrapFixture().Items
	if h, _ := w.resolved(); !strings.Contains(h, "2 things") {
		t.Errorf("two findings = %q", h)
	}
}

// When the model DID write, its prose wins — and the reader cannot tell which
// path produced the email.
func TestWrap_ModelProseWinsWhenPresent(t *testing.T) {
	w := wrapFixture()
	w.Headline = "A steady week with one loose thread"
	w.Narrative = "Most of the week was unremarkable. The one thing worth an hour is tagging " +
		"last month's spending, which is what turns your category margins into real figures."

	headline, body := w.resolved()
	if headline != w.Headline || body != w.Narrative {
		t.Error("model prose must be used verbatim when it verified")
	}
}

// A headline without a body is not usable prose; fall back rather than ship a
// bare title.
func TestWrap_HeadlineAloneFallsBack(t *testing.T) {
	w := wrapFixture()
	w.Headline = "Something"
	_, body := w.resolved()
	_, want := w.deterministicOpening()
	if body != want {
		t.Error("a headline with no narrative must fall back to the deterministic body")
	}
}

// A body without a headline borrows the deterministic one rather than shipping
// an untitled email.
func TestWrap_NarrativeWithoutHeadlineBorrowsOne(t *testing.T) {
	w := wrapFixture()
	w.Narrative = "Real prose here."
	headline, body := w.resolved()
	if headline == "" {
		t.Error("a wrap must always have a headline")
	}
	if body != "Real prose here." {
		t.Errorf("body = %q", body)
	}
}

// Unlike the brief, the wrap sends on a quiet week — so it must render one.
func TestWrap_RendersAQuietWeek(t *testing.T) {
	w := wrapFixture()
	w.Items = nil
	txt := renderWrapText(w)
	if !strings.Contains(txt, "A QUIET WEEK") {
		t.Errorf("a quiet week must still produce a readable email:\n%s", txt)
	}
	if strings.Contains(txt, "Rs ") {
		t.Error("no findings means no figures")
	}
}

// The FIGURES still come from the detector's sentence, printed beneath whatever
// prose was used. That is what makes forbidding digits in the prose costless.
func TestWrap_FiguresComeFromTheFindings(t *testing.T) {
	w := wrapFixture()
	w.Headline = "A word about spending"
	w.Narrative = "Nothing here contains a numeral, deliberately."
	txt := renderWrapText(w)

	if !strings.Contains(txt, "Rs 91,570") || !strings.Contains(txt, "4.6%") {
		t.Errorf("the detector's own figures must survive into the email:\n%s", txt)
	}
}

func TestWrapMessage_CarriesBulkHeadersAndSubject(t *testing.T) {
	m := WrapMessage(wrapFixture())
	if !strings.Contains(m.Subject, "your week") {
		t.Errorf("subject = %q", m.Subject)
	}
	if m.Headers["Precedence"] != "bulk" {
		t.Error("scheduled mail needs Precedence: bulk")
	}
	if m.Headers["List-Unsubscribe"] == "" {
		t.Error("List-Unsubscribe must be set when an address is configured")
	}
}
