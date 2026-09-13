package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/insight"
	"github.com/pewssh/cafe-mgmt/api/internal/llm"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// The Monday wrap — the one place in this product a language model writes
// anything.
//
// WHY WEEKLY AND NOT DAILY
//
// The daily brief is templated and must stay reliable: it is the thing an owner
// reads every morning, and prose that varies for no reason reads as noise. A
// week, though, is where synthesis actually earns its keep — three findings that
// are separately unremarkable can be one story, and only a model spots that
// cheaply.
//
// It is also the safest possible place to put a model: once a week, one call,
// low volume, and a failure falls back to the deterministic text nobody would
// have known was a fallback.
//
// WHY IT ALWAYS SENDS
//
// The daily brief is deliberately conditional — silence is the healthy state.
// But a channel that only ever speaks when something is wrong trains people to
// dread it, and then to filter it. The wrap is the ritual: it arrives every
// Monday, and on a good week it says so. That is what keeps the daily brief
// legible as an exception.
//
// WHAT THE MODEL IS AND IS NOT ALLOWED TO DO
//
// It orders and phrases the findings it is handed. It does not choose them
// (insight/select.go does), and it cannot emit a number (llm/verify.go rejects
// any digit). Every figure the reader sees is rendered beneath the prose from
// the detector's own sentence. See internal/llm's package comment.

// wrapLockKey is distinct again: a wrap run makes network calls and must not be
// able to block either the digest or the daily briefs.
const wrapLockKey int64 = 0x60_5e_47_e_03

// WrapWeekday is when the wrap is due, in each café's own timezone. Monday: the
// week just ended is the subject, and the reader is about to plan the next one.
const WrapWeekday = time.Monday

// maxRawResponse caps what a rejection stores. Enough to see what the model
// actually wrote, not enough to matter on a db.t4g.micro.
const maxRawResponse = 2000

// wrapSystemPrompt is the standing instruction.
//
// It states the digit rule even though verify.go ENFORCES it. The enforcement is
// what makes the guarantee; saying it here is what makes compliance likely, so
// the fallback stays rare rather than routine.
const wrapSystemPrompt = `You write one short weekly note to the owner of a small cafe, about their own books.

You are given findings that have ALREADY been chosen and ranked. Your job is only to order and phrase them.

Rules:
- Write NO NUMBERS AND NO DIGITS of any kind. Not figures, not percentages, not dates, not years. The exact numbers are printed underneath your text, so you never need them. Say "noticeably higher" or "roughly a third", never a figure.
- You may reorder the findings and you may leave one out if it is part of the same story as another. You may NEVER add one.
- Connect findings into one story where they genuinely relate. If they do not relate, do not pretend they do.
- Plain, calm, specific. Write like a bookkeeper who likes this cafe, not like a marketer. No exclamation marks, no "exciting", no "leverage".
- If there is nothing much to report, say so plainly. A quiet week is good news.
- British English.

Reply with JSON only: {"order": ["<finding keys, in your order>"], "headline": "<max 10 words>", "body": "<2-4 sentences>"}`

// RunWraps produces every due café's weekly wrap. Returns how many were written.
func (r *Runner) RunWraps(ctx context.Context, force bool) (int, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, wrapLockKey).Scan(&got); err != nil {
		return 0, err
	}
	if !got {
		r.log.Info("jobs.wraps_skipped", "reason", "another instance holds the wrap lock")
		return 0, nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, wrapLockKey)
	}()

	due, err := r.dueWraps(ctx, conn.Conn(), force)
	if err != nil {
		return 0, err
	}
	if len(due) == 0 {
		return 0, nil
	}

	// The month's spend is read ONCE and decremented in memory across the
	// fan-out. Re-reading per café would be a query per café for a number that
	// only this loop changes.
	spent, err := r.spendThisMonth(ctx, conn.Conn())
	if err != nil {
		return 0, err
	}
	budget := r.llm.BudgetMicros()
	r.log.Info("jobs.wraps_due", "cafes", len(due),
		"spent_micros", spent, "budget_micros", budget)

	now := time.Now()
	written := 0
	for _, c := range due {
		remaining := budget - spent
		used, err := r.wrapFor(ctx, c, now, remaining)
		if err != nil {
			alert.Fire(ctx, slog.LevelError, "insight.wrap_failed", err, "tenant", c.Slug)
			continue
		}
		spent += used
		written++
	}
	return written, nil
}

// dueWraps lists cafés with no wrap for their own local date, on the wrap
// weekday. Borrows a platform admin for the cross-tenant read, exactly as
// dueCafes does — see 0070's header for why that is a policy rather than a
// SECURITY DEFINER function.
func (r *Runner) dueWraps(ctx context.Context, conn *pgx.Conn, force bool) ([]dueCafe, error) {
	var adminID uuid.UUID
	if err := conn.QueryRow(ctx,
		`SELECT user_id FROM platform_admins ORDER BY created_at LIMIT 1`).Scan(&adminID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNoPlatformAdmin
		}
		return nil, err
	}
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.user_id', $1, false)`, adminID.String()); err != nil {
		return nil, err
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT set_config('app.user_id', '', false)`)
	}()

	// Postgres ISODOW: Monday = 1.
	rows, err := conn.Query(ctx, `
		WITH cafe AS (
		  SELECT t.id, t.name, t.slug,
		         COALESCE(NULLIF(t.timezone, ''), 'Asia/Kathmandu') AS tz
		  FROM tenants t
		  WHERE t.deleted_at IS NULL AND t.status = 'active'
		),
		localised AS (
		  SELECT c.*,
		         (now() AT TIME ZONE c.tz)::date AS local_day,
		         EXTRACT(HOUR FROM (now() AT TIME ZONE c.tz))::int AS local_hour,
		         EXTRACT(ISODOW FROM (now() AT TIME ZONE c.tz))::int AS local_dow
		  FROM cafe c
		)
		SELECT l.id, l.name, l.slug, l.tz, l.local_day
		FROM localised l
		WHERE ($1 OR (l.local_dow = $2 AND l.local_hour >= $3 AND l.local_hour < $3 + $4))
		  AND NOT EXISTS (
		    SELECT 1 FROM insight_briefs b
		    WHERE b.tenant_id = l.id AND b.day = l.local_day AND b.kind = 'weekly'
		  )
		ORDER BY l.slug
		LIMIT $5
	`, force, int(WrapWeekday), r.cfg.BriefHour, briefCatchUpHours, r.cfg.MaxBriefsPerRun)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []dueCafe
	for rows.Next() {
		var c dueCafe
		if err := rows.Scan(&c.TenantID, &c.Name, &c.Slug, &c.TZ, &c.LocalDay); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// spendThisMonth sums the model ledger. insight_briefs.cost_micros IS the
// ledger — there is no separate usage table, because every charge is already
// attached to the thing it paid for.
func (r *Runner) spendThisMonth(ctx context.Context, conn *pgx.Conn) (int64, error) {
	var spent int64
	err := conn.QueryRow(ctx, `
		SELECT COALESCE(SUM(cost_micros), 0)::bigint FROM insight_briefs
		WHERE created_at >= date_trunc('month', now())
	`).Scan(&spent)
	return spent, err
}

// wrapResult is one café's wrap. Returns the micros it spent so the caller can
// decrement the budget without re-reading it.
type wrapResult struct {
	BriefID    uuid.UUID
	Lead       []insight.Finding
	More       int
	Confidence *float64
	Recipients []string
	OptedOut   bool
	Traded     int
	Skipped    bool

	Headline   string
	Narrative  string
	LLMStatus  string
	CostMicros int64

	// AIAllowed is this café's own answer to "may a model write my wrap?".
	// Resolved per tenant from the billing feature set, NOT from the global key:
	// a key configured on the platform must not opt every café in at once.
	AIAllowed bool
}

func (r *Runner) wrapFor(ctx context.Context, c dueCafe, now time.Time, budgetLeft int64) (int64, error) {
	var res wrapResult

	// Phase one, in a transaction: reserve the marker and gather the findings.
	if err := r.withTenant(ctx, c.TenantID, func(tx pgx.Tx) error {
		var err error
		res, err = r.computeWrap(ctx, tx, c, now)
		return err
	}); err != nil {
		return 0, err
	}
	if res.Skipped {
		return 0, nil
	}

	// Phase two, OUTSIDE any transaction: the model call. A twenty-second
	// network round trip must never be made with a database transaction open —
	// idle_in_transaction_session_timeout is 30s, and holding a connection for
	// an external call is how a pool of 25 becomes a pool of 0.
	prose := r.writeProse(ctx, c, res, budgetLeft)

	// Phase three: record what happened and send.
	if err := r.withTenant(ctx, c.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE insight_briefs
			SET headline = $2, narrative = $3, llm_status = $4, llm_model = $5,
			    prompt_sha256 = $6, raw_response = $7,
			    input_tokens = $8, output_tokens = $9, cost_micros = $10
			WHERE id = $1`,
			res.BriefID, prose.headline, prose.narrative, prose.status, prose.model,
			prose.promptHash, prose.raw,
			prose.usage.InputTokens, prose.usage.OutputTokens, prose.usage.CostMicros)
		return err
	}); err != nil {
		return prose.usage.CostMicros, err
	}

	sent, recipients, err := r.emailWrap(ctx, c, res, prose)
	if err != nil {
		alert.Fire(ctx, slog.LevelError, "insight.wrap_email_failed", err, "tenant", c.Slug)
		return prose.usage.CostMicros, nil
	}
	if !sent {
		return prose.usage.CostMicros, nil
	}
	return prose.usage.CostMicros, r.withTenant(ctx, c.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE insight_briefs SET emailed_at = now(), email_recipients = $2
			WHERE id = $1`, res.BriefID, recipients)
		return err
	})
}

func (r *Runner) computeWrap(ctx context.Context, tx pgx.Tx, c dueCafe, now time.Time) (wrapResult, error) {
	var res wrapResult

	err := tx.QueryRow(ctx, `
		INSERT INTO insight_briefs (tenant_id, day, kind)
		VALUES (current_tenant_id(), $1, 'weekly')
		ON CONFLICT (tenant_id, day, kind) DO NOTHING
		RETURNING id`, c.LocalDay).Scan(&res.BriefID)
	if errors.Is(err, pgx.ErrNoRows) {
		res.Skipped = true
		return res, nil
	}
	if err != nil {
		return res, err
	}

	// Does THIS café want a model writing its wrap? The job runs as a platform
	// admin and deliberately bypasses feature gating elsewhere (HasFeature below
	// returns true) because the findings themselves are core. Sending the café's
	// numbers to an outside model is not, so it gets its own default-off switch
	// resolved here, per tenant, while we still hold a transaction.
	billState, err := billing.LoadStateTx(ctx, tx, c.TenantID)
	if err != nil {
		return res, err
	}
	res.AIAllowed = billState.Has(billing.FeatureAIWeeklyWrap)

	// The wrap READS findings; it does not produce them. The daily job already
	// stored and closed them, so re-running detectors here would only race with
	// it for no gain.
	in, err := insight.Gather(ctx, tx, now, c.TZ)
	if err != nil {
		return res, err
	}
	res.Traded = in.Window.OrderCount
	found := insight.RunAll(now, in)

	muted, err := insight.MutedDetectors(ctx, tx)
	if err != nil {
		return res, err
	}
	viewer := insight.Viewer{
		Can:        func(string) bool { return true },
		HasFeature: func(billing.FeatureKey) bool { return true },
		Muted:      muted,
	}
	// A wrap carries more than a daily brief — it is the week's summary, and the
	// reader has more attention on a Monday than mid-service.
	ranked := insight.Rank(insight.Visible(found, viewer))
	if len(ranked) > WrapLimit {
		res.Lead, res.More = ranked[:WrapLimit], len(ranked)-WrapLimit
	} else {
		res.Lead = ranked
	}

	if v, ok := in.BooksConfidence(); ok {
		res.Confidence = &v
	}
	if res.Recipients, err = briefRecipients(ctx, tx); err != nil {
		return res, err
	}
	if err := tx.QueryRow(ctx, `
		SELECT NOT COALESCE((preferences->>'dailyBriefEmail')::boolean, true)
		FROM tenants WHERE id = current_tenant_id()
	`).Scan(&res.OptedOut); err != nil {
		return res, err
	}

	_, err = tx.Exec(ctx, `
		UPDATE insight_briefs
		SET finding_count = $2, lead_count = $3, more_count = $4, books_confidence = $5
		WHERE id = $1`, res.BriefID, len(found), len(res.Lead), res.More, res.Confidence)
	return res, err
}

// WrapLimit is how many findings the weekly wrap lists. More than the daily
// brief's three: a Monday reader has more attention than a mid-service one, and
// the week's story sometimes needs a fourth thread.
const WrapLimit = 5

// prose is the outcome of the model call, in every case including "there wasn't
// one".
type prose struct {
	headline   string
	narrative  string
	status     string
	model      string
	promptHash string
	raw        string
	usage      llm.Usage
	// order is the model's preferred ordering, applied only if it verified.
	order []string
}

// writeProse asks the model to phrase the week, and returns a deterministic
// fallback in every failure case. It NEVER returns an error: there is no failure
// here that should stop a café getting its wrap.
func (r *Runner) writeProse(ctx context.Context, c dueCafe, res wrapResult, budgetLeft int64) prose {
	out := prose{status: "disabled", model: r.llm.Model()}

	if !r.llm.Enabled() {
		return out
	}
	// The café has not turned this on. Same status as "no key configured" —
	// from the reader's side both mean the deterministic text is what shipped.
	if !res.AIAllowed {
		return out
	}
	if budgetLeft <= 0 {
		// Mirrors engage.budget_exhausted: a cap that is silently hit is a cap
		// nobody knows about.
		alert.Fire(ctx, slog.LevelWarn, "insight.llm_budget_exhausted", nil,
			"tenant", c.Slug, "budget_micros", r.llm.BudgetMicros())
		out.status = "budget"
		return out
	}

	keys := make([]string, 0, len(res.Lead))
	var b strings.Builder
	fmt.Fprintf(&b, "Cafe: %s\nWeek ending: the day before this note.\n\n", c.Name)
	if len(res.Lead) == 0 {
		b.WriteString("There are no findings this week. Nothing needs the owner's attention.\n")
	} else {
		b.WriteString("Findings, already ranked:\n")
		for _, f := range res.Lead {
			keys = append(keys, f.DetectorKey)
			// The detector's sentence goes in verbatim — including its numbers,
			// which the model may READ and must not REPEAT. Feeding it the
			// numbers is what lets it say "noticeably higher" accurately.
			fmt.Fprintf(&b, "- key=%s severity=%s: %s\n", f.DetectorKey, f.Severity, f.Detail)
		}
	}
	// Deliberately absent: the owner's own notes on accepted findings. Those are
	// written by a person — and, once the MCP connector can write them, possibly
	// by somebody else's AI assistant. Untrusted text does not go into a prompt.

	reqCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	resp, err := r.llm.Write(reqCtx, llm.Request{
		System: wrapSystemPrompt, User: b.String(), AllowedKeys: keys,
	})
	out.usage = resp.Usage
	out.promptHash = resp.PromptSHA256

	switch {
	case err == nil:
		out.status = "ok"
		out.headline, out.narrative, out.order = resp.Headline, resp.Body, resp.Order
	case llm.IsRejected(err):
		// The guard fired. Keep the evidence — it is about our prompt, not the
		// café — and ship the deterministic text.
		out.status = "rejected_numbers"
		var re *llm.RejectedError
		if errors.As(err, &re) {
			out.raw = re.Raw
			if len(out.raw) > maxRawResponse {
				out.raw = out.raw[:maxRawResponse]
			}
		}
		r.log.Warn("insight.wrap_prose_rejected", "tenant", c.Slug, "reason", err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		out.status = "timeout"
	default:
		out.status = "error"
		r.log.Warn("insight.wrap_prose_failed", "tenant", c.Slug, "err", err.Error())
	}
	return out
}

func (r *Runner) emailWrap(ctx context.Context, c dueCafe, res wrapResult, p prose) (bool, int, error) {
	if res.OptedOut {
		r.log.Info("insight.wrap_opted_out", "tenant", c.Slug)
		return false, 0, nil
	}
	// Unlike the daily brief, a wrap with nothing to report STILL SENDS: it is
	// the ritual that keeps the daily brief legible as an exception. But a café
	// that has not traded at all has no week to wrap.
	if res.Traded == 0 {
		r.log.Info("insight.wrap_dormant", "tenant", c.Slug)
		return false, 0, nil
	}
	if len(res.Recipients) == 0 {
		r.log.Warn("insight.wrap_no_recipients", "tenant", c.Slug)
		return false, 0, nil
	}

	wrap := mail.Wrap{
		CafeName:      c.Name,
		WeekEnding:    c.LocalDay.AddDate(0, 0, -1),
		Headline:      p.headline,
		Narrative:     p.narrative,
		More:          res.More,
		Confidence:    res.Confidence,
		AppURL:        r.cfg.AppURL,
		To:            res.Recipients,
		From:          r.cfg.BriefFrom,
		FromName:      r.cfg.BriefFromName,
		UnsubscribeTo: r.cfg.BriefUnsubscribeTo,
	}
	for _, f := range applyModelOrder(res.Lead, p.order) {
		item := mail.BriefItem{
			Severity: string(f.Severity),
			Label:    f.SubjectLabel,
			Detail:   f.Detail,
		}
		if d, ok := insight.ByKey(f.DetectorKey); ok {
			if item.Label == "" {
				item.Label = d.Label
			}
			if base := strings.TrimRight(r.cfg.AppURL, "/"); base != "" {
				if path := d.Link(f); path != "" {
					item.Link = base + path
				}
			}
		}
		wrap.Items = append(wrap.Items, item)
	}

	msg := mail.WrapMessage(wrap)
	if r.mailer == nil {
		r.log.Info("insight.wrap_preview", "tenant", c.Slug, "subject", msg.Subject,
			"llm", p.status, "body", msg.Text)
		return false, 0, nil
	}
	if err := r.mailer.Send(msg); err != nil {
		return false, 0, err
	}
	return true, len(res.Recipients), nil
}

// applyModelOrder reorders findings to the model's preference, dropping nothing.
//
// The model may omit a key (it is allowed to fold two findings into one story),
// but the READER must still see every finding that was selected — omitting one
// from the list would mean the model quietly decided what the owner sees, which
// is exactly the authority it does not have. So anything it left out is appended
// in the server's original order.
func applyModelOrder(lead []insight.Finding, order []string) []insight.Finding {
	if len(order) == 0 {
		return lead
	}
	byKey := map[string][]insight.Finding{}
	for _, f := range lead {
		byKey[f.DetectorKey] = append(byKey[f.DetectorKey], f)
	}
	out := make([]insight.Finding, 0, len(lead))
	used := map[string]bool{}
	for _, k := range order {
		if fs, ok := byKey[k]; ok && !used[k] {
			out = append(out, fs...)
			used[k] = true
		}
	}
	for _, f := range lead {
		if !used[f.DetectorKey] {
			out = append(out, f)
			used[f.DetectorKey] = true
		}
	}
	return out
}
