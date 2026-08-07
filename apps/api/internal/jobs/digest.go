package jobs

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// The digest is the transport that billing.NotifyAttention was a placeholder
// for: a no-op stub with no callers, whose doc comment said "when a scheduler +
// transport exist, drive the notifications from here". They now exist, so the
// stub is gone and the three states it named — trials ending, trials expired,
// paid subscriptions past due — are sections of this email instead.

// Digest is everything the morning email reports.
type Digest struct {
	Day time.Time

	NewSignups   []DigestCafe
	TrialsEnding []DigestCafe
	PastDue      []DigestCafe
	// WentQuiet is the whole reason the snapshot exists: cafés whose status got
	// WORSE since yesterday. A static "here is everyone who is at risk" list
	// gets ignored within a week; a change list stays actionable.
	WentQuiet []DigestChange
	Recovered []DigestChange

	// FollowUps is the one section that is not about a café at all: leads
	// somebody promised to chase and hasn't. A booked follow-up that nobody is
	// reminded of is just a note in a database, so this is where the pipeline
	// reaches outside the console.
	FollowUps []DigestLead

	CashCollectedCents int64
}

type DigestCafe struct {
	TenantID uuid.UUID
	Name     string
	Slug     string
	Manager  string
	// Detail is a short human clause — the trial date, the lapse, whatever
	// makes this row worth a line.
	Detail string
}

type DigestChange struct {
	DigestCafe
	From string
	To   string
}

// DigestLead is a lead whose follow-up date has arrived or passed. Kept as its
// own type rather than reusing DigestCafe: the id links to /super/leads, not
// /super/tenants, and a lead has no slug.
type DigestLead struct {
	LeadID uuid.UUID
	Name   string
	Owner  string
	Detail string
}

// Empty reports whether there is nothing worth mailing about. A digest that
// arrives every morning saying "nothing happened" trains people to ignore it,
// so we simply don't send one.
func (d Digest) Empty() bool {
	return len(d.NewSignups) == 0 && len(d.TrialsEnding) == 0 && len(d.PastDue) == 0 &&
		len(d.WentQuiet) == 0 && len(d.Recovered) == 0 && len(d.FollowUps) == 0
}

// maxPerSection caps how many cafés any one section lists. A digest is a
// prompt to act, not a report: past twenty rows nobody reads it, and one noisy
// section would bury the others. The overflow is always STATED rather than
// silently dropped — "and 16 more" sends you to the console, a truncated list
// pretends it was complete.
const maxPerSection = 20

// statusRank orders usage statuses from best to worst so "did this get worse"
// is a comparison rather than a pile of special cases.
var statusRank = map[string]int{
	"healthy": 0, "onboarding": 1, "watch": 2, "at_risk": 3, "dormant": 4,
}

// SendDigest builds and sends today's digest. Returns whether an email went
// out. Skips (returning false) when there's nothing to report, when no mailer
// is configured, or when today's digest already went — unless force.
func (r *Runner) SendDigest(ctx context.Context, force bool) (bool, error) {
	today := time.Now().In(r.cfg.Location).Format("2006-01-02")

	if !force {
		var already bool
		if err := r.pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM platform_audit
			              WHERE action = 'platform.digest_sent' AND target_id = $1)
		`, today).Scan(&already); err != nil {
			return false, err
		}
		if already {
			return false, nil
		}
	}

	d, err := r.buildDigest(ctx)
	if err != nil {
		return false, err
	}
	if d.Empty() {
		r.log.Info("jobs.digest_skipped", "reason", "nothing to report")
		return false, nil
	}

	to, err := r.recipients(ctx)
	if err != nil {
		return false, err
	}
	if len(to) == 0 {
		r.log.Warn("jobs.digest_skipped", "reason", "no platform admins with an email")
		return false, nil
	}

	subject := fmt.Sprintf("Go Serve · %d need attention · %s",
		len(d.WentQuiet)+len(d.TrialsEnding)+len(d.PastDue), d.Day.Format("2 Jan"))
	msg := mail.Message{
		To:      to,
		Subject: subject,
		HTML:    renderDigestHTML(d, r.cfg.ConsoleURL),
		Text:    renderDigestText(d),
	}

	if r.mailer == nil {
		// Dev: no relay configured. Log the body so the digest can be developed
		// and eyeballed without SMTP creds — same courtesy the OTP flow gives.
		r.log.Info("jobs.digest_preview", "to", strings.Join(to, ","), "subject", subject,
			"body", msg.Text)
		return false, nil
	}
	if err := r.mailer.Send(msg); err != nil {
		alert.Fire(ctx, slog.LevelError, "platform.digest_send_failed", err, "recipients", len(to))
		return false, err
	}

	// Mark it sent so a restart or a second instance can't double-send. Written
	// to platform_audit rather than a bespoke table: it IS an action taken by
	// the platform, and it shows up in the console's audit trail for free.
	if _, err := r.pool.Exec(ctx, `
		INSERT INTO platform_audit (actor_email, action, target_id, summary, meta)
		VALUES ('system', 'platform.digest_sent', $1, $2, $3)
	`, today, fmt.Sprintf("sent the daily digest to %d admin(s)", len(to)),
		map[string]any{"recipients": len(to), "went_quiet": len(d.WentQuiet)}); err != nil {
		return true, err
	}
	return true, nil
}

func (r *Runner) recipients(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT u.email::text FROM platform_admins pa
		JOIN users u ON u.id = pa.user_id
		WHERE u.email IS NOT NULL
		ORDER BY u.email
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (r *Runner) buildDigest(ctx context.Context) (Digest, error) {
	d := Digest{Day: time.Now().In(r.cfg.Location)}

	// New signups in the last 24h.
	if err := r.collect(ctx, &d.NewSignups, `
		SELECT t.id, t.name, t.slug, COALESCE(pp.name, ''), ''
		FROM tenants t
		LEFT JOIN platform_people pp ON pp.id = t.relationship_manager_id
		WHERE t.deleted_at IS NULL AND t.created_at >= now() - interval '1 day'
		ORDER BY t.created_at DESC
	`); err != nil {
		return d, err
	}

	// Trials ending within a week — early enough to act, late enough to matter.
	if err := r.collect(ctx, &d.TrialsEnding, `
		SELECT t.id, t.name, t.slug, COALESCE(pp.name, ''),
		       'trial ends ' || to_char(t.trial_ends_at, 'FMDay DD Mon')
		FROM tenants t
		LEFT JOIN platform_people pp ON pp.id = t.relationship_manager_id
		WHERE t.deleted_at IS NULL AND t.status = 'active'
		  AND t.trial_ends_at IS NOT NULL
		  AND t.trial_ends_at >= now() AND t.trial_ends_at < now() + interval '7 days'
		ORDER BY t.trial_ends_at
	`); err != nil {
		return d, err
	}

	// Paid subscriptions that have lapsed. Flag-only in the product (writes
	// stay open), which is exactly why they need chasing by a human.
	if err := r.collect(ctx, &d.PastDue, `
		SELECT t.id, t.name, t.slug, COALESCE(pp.name, ''),
		       'lapsed ' || to_char(t.paid_through_at, 'FMDD Mon')
		FROM tenants t
		LEFT JOIN platform_people pp ON pp.id = t.relationship_manager_id
		WHERE t.deleted_at IS NULL AND t.status = 'active'
		  AND t.paid_through_at IS NOT NULL AND t.paid_through_at < now()
		ORDER BY t.paid_through_at
	`); err != nil {
		return d, err
	}

	// The diff. Compares the two most recent snapshots per tenant, so a café
	// only appears the day its status actually moves.
	rows, err := r.pool.Query(ctx, `
		WITH ranked AS (
			SELECT tenant_id, status, day,
			       row_number() OVER (PARTITION BY tenant_id ORDER BY day DESC) AS rn
			FROM tenant_health_daily
			WHERE day >= CURRENT_DATE - 7
		),
		pairs AS (
			SELECT c.tenant_id, p.status AS was, c.status AS now
			FROM ranked c JOIN ranked p ON p.tenant_id = c.tenant_id AND p.rn = 2
			WHERE c.rn = 1
		)
		SELECT t.id, t.name, t.slug, COALESCE(pp.name, ''), pairs.was, pairs.now
		FROM pairs
		JOIN tenants t ON t.id = pairs.tenant_id AND t.deleted_at IS NULL
		LEFT JOIN platform_people pp ON pp.id = t.relationship_manager_id
		WHERE pairs.was <> pairs.now
	`)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var c DigestChange
		if err := rows.Scan(&c.TenantID, &c.Name, &c.Slug, &c.Manager, &c.From, &c.To); err != nil {
			return d, err
		}
		c.Detail = c.From + " → " + c.To
		if statusRank[c.To] > statusRank[c.From] {
			d.WentQuiet = append(d.WentQuiet, c)
		} else {
			d.Recovered = append(d.Recovered, c)
		}
	}
	if err := rows.Err(); err != nil {
		return d, err
	}

	// Leads whose follow-up date has arrived or gone by. Overdue first, and the
	// day count is computed in Postgres against CURRENT_DATE so it matches what
	// the console's "due" filter shows rather than drifting by a timezone.
	lRows, err := r.pool.Query(ctx, `
		SELECT l.id, l.cafe_name, COALESCE(pp.name, ''),
		       CASE
		         WHEN l.next_follow_up_at = CURRENT_DATE THEN 'due today'
		         ELSE (CURRENT_DATE - l.next_follow_up_at) || ' days overdue'
		       END
		FROM platform_leads l
		LEFT JOIN platform_people pp ON pp.id = l.owner_person_id
		WHERE l.stage NOT IN ('won', 'lost')
		  AND l.next_follow_up_at IS NOT NULL
		  AND l.next_follow_up_at <= CURRENT_DATE
		ORDER BY l.next_follow_up_at
	`)
	if err != nil {
		return d, err
	}
	defer lRows.Close()
	for lRows.Next() {
		var l DigestLead
		if err := lRows.Scan(&l.LeadID, &l.Name, &l.Owner, &l.Detail); err != nil {
			return d, err
		}
		d.FollowUps = append(d.FollowUps, l)
	}
	if err := lRows.Err(); err != nil {
		return d, err
	}

	// Yesterday's cash take, so the morning email answers "did money come in".
	if err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM tenant_payments
		WHERE created_at >= now() - interval '1 day'
	`).Scan(&d.CashCollectedCents); err != nil {
		return d, err
	}
	return d, nil
}

func (r *Runner) collect(ctx context.Context, dst *[]DigestCafe, query string) error {
	rows, err := r.pool.Query(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var c DigestCafe
		if err := rows.Scan(&c.TenantID, &c.Name, &c.Slug, &c.Manager, &c.Detail); err != nil {
			return err
		}
		*dst = append(*dst, c)
	}
	return rows.Err()
}

// --- rendering -----------------------------------------------------------

// capSection trims a section to maxPerSection, returning what to show and how
// many were left out.
func capSection[T any](rows []T) (shown []T, extra int) {
	if len(rows) <= maxPerSection {
		return rows, 0
	}
	return rows[:maxPerSection], len(rows) - maxPerSection
}

// toCafes flattens status changes for the shared section renderers.
func toCafes(cs []DigestChange) []DigestCafe {
	out := make([]DigestCafe, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.DigestCafe)
	}
	return out
}

func renderDigestText(d Digest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Go Serve — %s\n\n", d.Day.Format("Monday 2 January 2006"))

	section := func(title string, cafes []DigestCafe) {
		if len(cafes) == 0 {
			return
		}
		fmt.Fprintf(&b, "%s (%d)\n", title, len(cafes))
		shown, extra := capSection(cafes)
		for _, c := range shown {
			line := "  · " + c.Name
			if c.Detail != "" {
				line += " — " + c.Detail
			}
			if c.Manager != "" {
				line += " [" + c.Manager + "]"
			}
			b.WriteString(line + "\n")
		}
		if extra > 0 {
			fmt.Fprintf(&b, "  … and %d more — see the console\n", extra)
		}
		b.WriteString("\n")
	}

	leadSection := func(title string, leads []DigestLead) {
		if len(leads) == 0 {
			return
		}
		fmt.Fprintf(&b, "%s (%d)\n", title, len(leads))
		shown, extra := capSection(leads)
		for _, l := range shown {
			line := "  · " + l.Name + " — " + l.Detail
			if l.Owner != "" {
				line += " [" + l.Owner + "]"
			}
			b.WriteString(line + "\n")
		}
		if extra > 0 {
			fmt.Fprintf(&b, "  … and %d more — see the console\n", extra)
		}
		b.WriteString("\n")
	}

	section("Went quiet", toCafes(d.WentQuiet))
	leadSection("Follow-ups due", d.FollowUps)
	section("Trials ending this week", d.TrialsEnding)
	section("Past due", d.PastDue)
	section("New sign-ups", d.NewSignups)
	section("Picked back up", toCafes(d.Recovered))
	fmt.Fprintf(&b, "Payments recorded in the last 24h: %s\n", audit.Money(d.CashCollectedCents))
	return b.String()
}

func renderDigestHTML(d Digest, consoleURL string) string {
	var b strings.Builder
	esc := html.EscapeString

	link := func(c DigestCafe) string {
		if consoleURL == "" {
			return esc(c.Name)
		}
		return fmt.Sprintf(`<a href="%s/super/tenants/%s" style="color:#7c5cff;text-decoration:none">%s</a>`,
			esc(strings.TrimRight(consoleURL, "/")), c.TenantID, esc(c.Name))
	}

	b.WriteString(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">`)
	fmt.Fprintf(&b, `<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8794;margin:0 0 4px">Go Serve</p>`)
	fmt.Fprintf(&b, `<h1 style="font-size:20px;margin:0 0 20px">%s</h1>`, esc(d.Day.Format("Monday 2 January")))

	section := func(title, accent string, rows []DigestCafe) {
		if len(rows) == 0 {
			return
		}
		fmt.Fprintf(&b, `<h2 style="font-size:14px;margin:20px 0 8px;color:%s">%s (%d)</h2><table style="width:100%%;border-collapse:collapse;font-size:13px">`,
			accent, esc(title), len(rows))
		shown, extra := capSection(rows)
		for _, c := range shown {
			fmt.Fprintf(&b, `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">%s`, link(c))
			if c.Detail != "" {
				fmt.Fprintf(&b, ` <span style="color:#6b7280">— %s</span>`, esc(c.Detail))
			}
			b.WriteString(`</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;color:#6b7280">`)
			if c.Manager != "" {
				b.WriteString(esc(c.Manager))
			} else {
				b.WriteString(`<em>unassigned</em>`)
			}
			b.WriteString(`</td></tr>`)
		}
		if extra > 0 {
			fmt.Fprintf(&b, `<tr><td colspan="2" style="padding:6px 0;color:#6b7280;font-style:italic">and %d more — see the console</td></tr>`, extra)
		}
		b.WriteString(`</table>`)
	}

	leadSection := func(title, accent string, leads []DigestLead) {
		if len(leads) == 0 {
			return
		}
		fmt.Fprintf(&b, `<h2 style="font-size:14px;margin:20px 0 8px;color:%s">%s (%d)</h2><table style="width:100%%;border-collapse:collapse;font-size:13px">`,
			accent, esc(title), len(leads))
		shown, extra := capSection(leads)
		for _, l := range shown {
			name := esc(l.Name)
			if consoleURL != "" {
				name = fmt.Sprintf(`<a href="%s/super/leads/%s" style="color:#7c5cff;text-decoration:none">%s</a>`,
					esc(strings.TrimRight(consoleURL, "/")), l.LeadID, esc(l.Name))
			}
			fmt.Fprintf(&b, `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">%s <span style="color:#6b7280">— %s</span></td>`,
				name, esc(l.Detail))
			b.WriteString(`<td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;color:#6b7280">`)
			if l.Owner != "" {
				b.WriteString(esc(l.Owner))
			} else {
				b.WriteString(`<em>unassigned</em>`)
			}
			b.WriteString(`</td></tr>`)
		}
		if extra > 0 {
			fmt.Fprintf(&b, `<tr><td colspan="2" style="padding:6px 0;color:#6b7280;font-style:italic">and %d more — see the console</td></tr>`, extra)
		}
		b.WriteString(`</table>`)
	}

	// Worst news first — the reader's attention is highest at the top. Overdue
	// follow-ups sit second: they are the only section where the reader is the
	// person who dropped the ball.
	section("Went quiet", "#b91c1c", toCafes(d.WentQuiet))
	leadSection("Follow-ups due", "#b45309", d.FollowUps)
	section("Trials ending this week", "#b45309", d.TrialsEnding)
	section("Past due", "#b45309", d.PastDue)
	section("New sign-ups", "#15803d", d.NewSignups)
	section("Picked back up", "#15803d", toCafes(d.Recovered))

	fmt.Fprintf(&b, `<p style="margin-top:24px;font-size:13px;color:#6b7280">Payments recorded in the last 24 hours: <strong>%s</strong></p>`,
		esc(audit.Money(d.CashCollectedCents)))
	b.WriteString(`</div>`)
	return b.String()
}
