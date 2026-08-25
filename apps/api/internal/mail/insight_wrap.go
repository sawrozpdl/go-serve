package mail

import (
	"fmt"
	"html"
	"strings"
	"time"
)

// The Monday wrap.
//
// Structurally the brief's sibling, with two differences that matter:
//
//  1. It ALWAYS sends. The daily brief is silent on a good day — silence is the
//     healthy state — but a channel that only ever speaks when something is
//     wrong trains people to dread it and then to filter it. The wrap is the
//     ritual, and on a quiet week it says the week was quiet.
//
//  2. It may carry PROSE written by a language model. When it does, the prose
//     sits ABOVE the findings and contains no numbers at all — every figure is
//     rendered underneath from the detector's own sentence. When it does not
//     (no key configured, budget spent, request timed out, or the verifier
//     rejected the answer) the deterministic opening is used and the reader
//     cannot tell the difference. That is the point: the model is an
//     improvement, never a dependency.

// Wrap is everything the weekly note reports.
type Wrap struct {
	CafeName string
	// WeekEnding is the last day the wrap covers, in the café's own timezone.
	WeekEnding time.Time

	// Headline / Narrative are the model's prose, or empty when it did not
	// write. Empty is a normal state, not a degraded one.
	Headline  string
	Narrative string

	Items []BriefItem
	More  int

	Confidence *float64

	AppURL        string
	To            []string
	From          string
	FromName      string
	UnsubscribeTo string
}

// deterministicOpening is what the reader sees when no model wrote anything.
//
// Written to be genuinely readable rather than a placeholder, because on any
// week with no key, no budget, or a rejected answer this IS the email. A
// fallback that reads as a fallback would make the whole feature feel broken
// whenever the model was unavailable.
func (w Wrap) deterministicOpening() (headline, body string) {
	switch {
	case len(w.Items) == 0:
		return "A quiet week",
			"Nothing in your books needs a decision this week. The nightly checks ran and " +
				"found nothing out of place — takings, drawer, margins, credit and stock."
	case len(w.Items) == 1:
		return "One thing worth your time",
			"A steady week, with a single thing worth looking at. It is below, with the " +
				"numbers behind it."
	default:
		return fmt.Sprintf("%s worth your time", plural(len(w.Items), "thing", "things")),
			"Here is what the nightly checks turned up over the week, worst first. Each one " +
				"links through to the screen where you can do something about it."
	}
}

// resolved returns the prose actually used, model-written or not.
func (w Wrap) resolved() (headline, body string) {
	if strings.TrimSpace(w.Narrative) != "" {
		h := strings.TrimSpace(w.Headline)
		if h == "" {
			h, _ = w.deterministicOpening()
		}
		return h, strings.TrimSpace(w.Narrative)
	}
	return w.deterministicOpening()
}

func (w Wrap) subject() string {
	return fmt.Sprintf("%s · your week · %s", w.CafeName, w.WeekEnding.Format("2 Jan"))
}

// WrapMessage renders the weekly wrap.
func WrapMessage(w Wrap) Message {
	h := map[string]string{
		"Precedence":               "bulk",
		"Auto-Submitted":           "auto-generated",
		"X-Auto-Response-Suppress": "All",
	}
	if w.UnsubscribeTo != "" {
		h["List-Unsubscribe"] = "<mailto:" + w.UnsubscribeTo + "?subject=unsubscribe>"
	}
	return Message{
		To:       w.To,
		Subject:  w.subject(),
		Text:     renderWrapText(w),
		HTML:     renderWrapHTML(w),
		From:     w.From,
		FromName: w.FromName,
		Headers:  h,
	}
}

func renderWrapText(w Wrap) string {
	headline, body := w.resolved()
	var s strings.Builder

	fmt.Fprintf(&s, "%s — week ending %s\n\n", w.CafeName, w.WeekEnding.Format("Monday 2 January"))
	fmt.Fprintf(&s, "%s\n\n%s\n\n", strings.ToUpper(headline), body)
	fmt.Fprintf(&s, "%s\n\n", confidenceLine(Brief{Confidence: w.Confidence}))

	for _, it := range w.Items {
		marker := "·"
		if it.Severity == "bad" {
			marker = "!"
		}
		fmt.Fprintf(&s, "  %s %s\n    %s\n", marker, it.Label, it.Detail)
		if it.Link != "" {
			fmt.Fprintf(&s, "    %s\n", it.Link)
		}
		s.WriteString("\n")
	}
	if w.More > 0 {
		fmt.Fprintf(&s, "  … and %s not listed here.\n\n",
			plural(w.More, "one more finding", "more findings"))
	}
	if w.AppURL != "" {
		fmt.Fprintf(&s, "All findings: %s/admin/insights\n", strings.TrimRight(w.AppURL, "/"))
	}
	s.WriteString("\nThis arrives every Monday. Turn it off under Settings → Notifications.\n")
	return s.String()
}

func renderWrapHTML(w Wrap) string {
	headline, body := w.resolved()
	var s strings.Builder
	esc := html.EscapeString
	accent := map[string]string{"bad": "#b91c1c", "warn": "#b45309"}

	s.WriteString(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;line-height:1.5">`)
	fmt.Fprintf(&s, `<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8794;margin:0 0 4px">%s · your week</p>`,
		esc(w.CafeName))
	fmt.Fprintf(&s, `<h1 style="font-size:21px;margin:0 0 12px;font-weight:600">%s</h1>`, esc(headline))
	fmt.Fprintf(&s, `<p style="margin:0 0 20px;font-size:15px;color:#374151">%s</p>`, esc(body))
	fmt.Fprintf(&s, `<p style="margin:0 0 24px;color:#6b7280;font-size:13px">%s</p>`,
		esc(confidenceLine(Brief{Confidence: w.Confidence})))

	for _, it := range w.Items {
		col := accent[it.Severity]
		if col == "" {
			col = "#6b7280"
		}
		fmt.Fprintf(&s, `<div style="border-left:3px solid %s;padding:0 0 0 14px;margin:0 0 20px">`, col)
		fmt.Fprintf(&s, `<p style="margin:0 0 4px;font-weight:600;font-size:15px">%s</p>`, esc(it.Label))
		fmt.Fprintf(&s, `<p style="margin:0;font-size:14px;color:#374151">%s</p>`, esc(it.Detail))
		if it.Link != "" {
			fmt.Fprintf(&s, `<p style="margin:8px 0 0;font-size:13px"><a href="%s" style="color:#7c5cff;text-decoration:none">Look at this →</a></p>`,
				esc(it.Link))
		}
		s.WriteString(`</div>`)
	}
	if w.More > 0 {
		fmt.Fprintf(&s, `<p style="margin:0 0 24px;font-size:13px;color:#6b7280;font-style:italic">and %s not listed here.</p>`,
			esc(plural(w.More, "one more finding", "more findings")))
	}
	if w.AppURL != "" {
		fmt.Fprintf(&s, `<p style="margin:28px 0 0;font-size:13px"><a href="%s/admin/insights" style="color:#7c5cff;text-decoration:none">See everything →</a></p>`,
			esc(strings.TrimRight(w.AppURL, "/")))
	}
	s.WriteString(`<p style="margin:20px 0 0;font-size:12px;color:#9ca3af">This arrives every Monday. You can turn it off under Settings → Notifications.</p>`)
	s.WriteString(`</div>`)
	return s.String()
}
