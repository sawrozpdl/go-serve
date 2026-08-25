package mail

import (
	"fmt"
	"html"
	"strings"
	"time"
)

// The morning brief.
//
// Like ShiftSummary, this package owns a PLAIN DTO rather than importing the
// insight domain. The job maps its findings onto these fields. That keeps mail a
// rendering package with no domain dependencies, and it means the wording of an
// email can be changed without touching detector logic.
//
// The structure is the platform digest's, applied to one café: worst news first,
// nothing sent when there is nothing to say, and any remainder STATED rather
// than silently dropped.

// BriefItem is one finding as the email shows it.
type BriefItem struct {
	// Severity is "bad" or "warn". Drives the accent colour and the ordering is
	// already decided by the caller.
	Severity string
	Label    string
	Detail   string
	// Link is an absolute URL, or "" when there is nowhere useful to go.
	Link string
}

// BriefFollowUp is a decision whose review date has arrived.
type BriefFollowUp struct {
	Label string
	Note  string
	// Detail is TODAY's sentence, so a follow-up reads as the current situation
	// rather than a stale quote from the day it was accepted.
	Detail string
	// AcceptedOn is when the owner decided to act.
	AcceptedOn time.Time
	// Improved says which way the number moved. Only meaningful when Moved is
	// true; a follow-up with no comparison says so instead of implying progress.
	Improved bool
	Moved    bool
}

// Brief is everything one morning's email reports.
type Brief struct {
	CafeName string
	// Day is the café's own local date — what "this morning" means there.
	Day time.Time

	Items []BriefItem
	// More is how many findings did not make the cut. Always stated: a
	// truncated list that does not say it was truncated pretends it was complete.
	More int

	FollowUps []BriefFollowUp

	// Confidence is how much of the café's own numbers we can vouch for, 0..1.
	// Nil means it has recorded too little for the figure to mean anything —
	// which is a real answer, and printed as such rather than as 0%.
	Confidence *float64

	AppURL string
	To     []string
}

// Empty reports whether there is nothing worth mailing about.
//
// The rule is the digest's, and it is the single most important thing about this
// email: "a digest that arrives every morning saying nothing happened is a
// digest people stop reading." A well-run café should hear from us rarely.
func (b Brief) Empty() bool { return len(b.Items) == 0 && len(b.FollowUps) == 0 }

// briefSubject names the count, so the inbox line alone is useful.
func (b Brief) briefSubject() string {
	switch {
	case len(b.Items) == 0 && len(b.FollowUps) > 0:
		return fmt.Sprintf("%s · %s to review · %s",
			b.CafeName, plural(len(b.FollowUps), "decision", "decisions"), b.Day.Format("2 Jan"))
	case len(b.Items) == 1:
		return fmt.Sprintf("%s · 1 thing to look at · %s", b.CafeName, b.Day.Format("2 Jan"))
	default:
		return fmt.Sprintf("%s · %d things to look at · %s",
			b.CafeName, len(b.Items), b.Day.Format("2 Jan"))
	}
}

// BriefMessage renders the morning brief.
func BriefMessage(b Brief) Message {
	return Message{
		To:      b.To,
		Subject: b.briefSubject(),
		Text:    renderBriefText(b),
		HTML:    renderBriefHTML(b),
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// confidenceLine explains how much of the café's own numbers we can vouch for.
// This is the honest alternative to attaching a made-up confidence interval to a
// forecast: it describes what we actually know, and it is impossible to fake.
func confidenceLine(b Brief) string {
	if b.Confidence == nil {
		return "There is not enough recorded yet to say how complete your books are."
	}
	pct := *b.Confidence * 100
	switch {
	case pct >= 90:
		return fmt.Sprintf("Your books are %.0f%% complete, so these numbers can be taken at face value.", pct)
	case pct >= 60:
		return fmt.Sprintf("Your books are %.0f%% complete — the gaps are listed below, and they make profit read higher than it is.", pct)
	default:
		return fmt.Sprintf("Your books are only %.0f%% complete, so treat any profit figure as a rough guide until the gaps below are filled.", pct)
	}
}

func followUpLine(f BriefFollowUp) string {
	verdict := "There is nothing to compare it against yet."
	if f.Moved {
		if f.Improved {
			verdict = "It has moved in the right direction."
		} else {
			verdict = "It has not improved."
		}
	}
	line := fmt.Sprintf("%s — you decided to act on %s. %s",
		f.Label, f.AcceptedOn.Format("2 Jan"), verdict)
	if f.Note != "" {
		line += fmt.Sprintf(" Your note: %q.", f.Note)
	}
	return line
}

func renderBriefText(b Brief) string {
	var s strings.Builder
	fmt.Fprintf(&s, "%s — %s\n\n", b.CafeName, b.Day.Format("Monday 2 January 2006"))
	fmt.Fprintf(&s, "%s\n\n", confidenceLine(b))

	if len(b.Items) > 0 {
		s.WriteString("WORTH A LOOK\n\n")
		for _, it := range b.Items {
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
		if b.More > 0 {
			fmt.Fprintf(&s, "  … and %s not listed here.\n\n",
				plural(b.More, "one more finding", "more findings"))
		}
	}

	if len(b.FollowUps) > 0 {
		s.WriteString("YOU ASKED TO REVIEW\n\n")
		for _, f := range b.FollowUps {
			fmt.Fprintf(&s, "  · %s\n    %s\n\n", followUpLine(f), f.Detail)
		}
	}

	if b.AppURL != "" {
		fmt.Fprintf(&s, "All findings: %s/admin/insights\n", strings.TrimRight(b.AppURL, "/"))
	}
	return s.String()
}

func renderBriefHTML(b Brief) string {
	var s strings.Builder
	esc := html.EscapeString
	// Severity colours reuse the app's own vocabulary rather than inventing a
	// second one: bad is the same red the reconciliation strip uses.
	accent := map[string]string{"bad": "#b91c1c", "warn": "#b45309"}

	s.WriteString(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;line-height:1.5">`)
	fmt.Fprintf(&s, `<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8794;margin:0 0 4px">%s</p>`,
		esc(b.CafeName))
	fmt.Fprintf(&s, `<h1 style="font-size:20px;margin:0 0 12px;font-weight:600">%s</h1>`,
		esc(b.Day.Format("Monday 2 January")))
	fmt.Fprintf(&s, `<p style="margin:0 0 24px;color:#4b5563;font-size:14px">%s</p>`,
		esc(confidenceLine(b)))

	if len(b.Items) > 0 {
		s.WriteString(`<h2 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:0 0 12px">Worth a look</h2>`)
		for _, it := range b.Items {
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
		if b.More > 0 {
			fmt.Fprintf(&s, `<p style="margin:0 0 24px;font-size:13px;color:#6b7280;font-style:italic">and %s not listed here.</p>`,
				esc(plural(b.More, "one more finding", "more findings")))
		}
	}

	if len(b.FollowUps) > 0 {
		s.WriteString(`<h2 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:24px 0 12px">You asked to review</h2>`)
		for _, f := range b.FollowUps {
			fmt.Fprintf(&s, `<div style="border-left:3px solid #15803d;padding:0 0 0 14px;margin:0 0 20px">`)
			fmt.Fprintf(&s, `<p style="margin:0 0 4px;font-size:14px">%s</p>`, esc(followUpLine(f)))
			fmt.Fprintf(&s, `<p style="margin:0;font-size:14px;color:#374151">%s</p></div>`, esc(f.Detail))
		}
	}

	if b.AppURL != "" {
		fmt.Fprintf(&s, `<p style="margin:28px 0 0;font-size:13px"><a href="%s/admin/insights" style="color:#7c5cff;text-decoration:none">See everything →</a></p>`,
			esc(strings.TrimRight(b.AppURL, "/")))
	}
	s.WriteString(`</div>`)
	return s.String()
}
