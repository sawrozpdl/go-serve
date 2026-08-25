package jobs

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/insight"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// The morning brief: a per-café, timezone-aware fan-out.
//
// This job is shaped differently from the other two in this package, and every
// difference is forced by something real.
//
// ITS OWN ADVISORY LOCK. Not 0x...01. A fan-out across many cafés, each running
// a dozen indexed queries, takes far longer than the snapshot or the digest.
// Sharing the lock would mean one slow brief run blocks the platform digest for
// the day.
//
// CHECKED EVERY TICK, NOT AT ONE PLATFORM HOUR. jobs.Config.Hour is a single
// hour in a single Location, which is right for an email to the platform team.
// Cafés have their own tenants.timezone — every report already respects it — so
// 07:00 platform time is not morning for a café in another zone. The due check
// is therefore per café, in its own local time.
//
// IDEMPOTENCE IS A ROW, NOT A MARKER. digest.go can use a single platform_audit
// marker because it sends one email for the whole platform. Here a crash halfway
// through must not re-brief the cafés already done, and the API runs as one ECS
// task with minimumHealthyPercent 0 — so any push to main kills this mid-run.
//
// RLS IS DONE PER CAFÉ, NOT BY BORROWING AN ADMIN. snapshot.go's gradeAll
// borrows a platform admin's identity, which works there ONLY because
// platform_tenant_usage() is SECURITY DEFINER and self-gates on
// is_platform_admin(). A borrowed identity does NOT open the plain
// tenant_id = current_tenant_id() policies on orders, expenses or findings. So
// every café's real work happens inside its own transaction with app.tenant_id
// set, exactly as db.TxMiddleware does for a request. The borrowed identity is
// used for one thing only: asking which cafés are due, which needs no tenant
// context by definition.

// briefLockKey is deliberately distinct from advisoryLockKey. See above.
const briefLockKey int64 = 0x60_5e_47_e_02

// briefCatchUpHours is how long after the target hour a café can still get its
// brief. Wide enough that a deploy or a restart inside the target hour does not
// cost the day; narrow enough that a brief never arrives in the afternoon
// calling itself the morning's.
const briefCatchUpHours = 3

// defaultMaxBriefsPerRun bounds one pass. Overridable via Config so a busy
// platform can raise it and tests can make a seeded café reliably visible.
//
// A backlog drains rather than starving: every café briefed this tick carries a
// marker that excludes it from the next one, so successive passes see a
// different set. What this does NOT do is skip cafés that have never traded —
// they still cost a transaction each before the dormant guard stops the email.
// A cheap cross-tenant "has this café ever traded" filter would need
// tenant_health_daily to be trustworthy, and its per-day counts are currently
// written as zeros (jobs/snapshot.go reads orders cross-tenant as app_user,
// where RLS returns nothing).
const defaultMaxBriefsPerRun = 50

// dueCafe is one café whose brief has not been produced for its local date.
type dueCafe struct {
	TenantID uuid.UUID
	Name     string
	Slug     string
	TZ       string
	LocalDay time.Time
}

// RunBriefs produces every due café's brief. Returns how many were written.
//
// force ignores the target hour, so the manual trigger can produce today's brief
// at any time of day. It does NOT ignore the per-café row marker: re-running is
// meant to fill gaps, not to send a café a second copy.
func (r *Runner) RunBriefs(ctx context.Context, force bool) (int, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, briefLockKey).Scan(&got); err != nil {
		return 0, err
	}
	if !got {
		r.log.Info("jobs.briefs_skipped", "reason", "another instance holds the brief lock")
		return 0, nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, briefLockKey)
	}()

	due, err := r.dueCafes(ctx, conn.Conn(), force)
	if err != nil {
		return 0, err
	}
	if len(due) == 0 {
		return 0, nil
	}
	r.log.Info("jobs.briefs_due", "cafes", len(due))

	// ONE instant for the whole run, threaded down explicitly rather than each
	// café calling time.Now(). Same reasoning as health.Compute taking `now` as a
	// parameter: every window boundary and every day count in a run then agrees
	// with every other, and the whole thing is testable at a fixed instant.
	now := time.Now()

	written := 0
	for _, c := range due {
		// One café failing must not cost every other café its brief. This is the
		// same reasoning as snapshot.go guarding on EXISTS rather than letting a
		// foreign key abort the run.
		if err := r.briefFor(ctx, c, now); err != nil {
			alert.Fire(ctx, slog.LevelError, "insight.brief_failed", err,
				"tenant", c.Slug, "day", c.LocalDay.Format("2006-01-02"))
			continue
		}
		written++
	}
	return written, nil
}

// dueCafes asks which cafés have no brief for their own local date yet.
//
// Runs on ONE connection with a borrowed platform-admin identity, because
// insight_briefs' platform policy (0070) is what makes this cross-tenant read
// possible without a SECURITY DEFINER function. The GUC is set non-local and
// reset in a defer — the connection goes back to the pool, so leaving an
// identity on it would hand platform authority to the next unrelated query.
func (r *Runner) dueCafes(ctx context.Context, conn *pgx.Conn, force bool) ([]dueCafe, error) {
	var adminID uuid.UUID
	if err := conn.QueryRow(ctx,
		`SELECT user_id FROM platform_admins ORDER BY created_at LIMIT 1`).Scan(&adminID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Same failure mode snapshot.go names explicitly: without an admin to
			// run as, this would silently look like "no cafés are due" forever.
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

	hour := r.cfg.BriefHour
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
		         EXTRACT(HOUR FROM (now() AT TIME ZONE c.tz))::int AS local_hour
		  FROM cafe c
		)
		SELECT l.id, l.name, l.slug, l.tz, l.local_day
		FROM localised l
		WHERE ($1 OR (l.local_hour >= $2 AND l.local_hour < $2 + $3))
		  AND NOT EXISTS (
		    SELECT 1 FROM insight_briefs b
		    WHERE b.tenant_id = l.id AND b.day = l.local_day AND b.kind = 'daily'
		  )
		ORDER BY l.slug
		LIMIT $4
	`, force, hour, briefCatchUpHours, r.cfg.MaxBriefsPerRun)
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

// briefResult is what one café's run produced, carried out of the transaction so
// the email is sent AFTER the commit.
type briefResult struct {
	BriefID    uuid.UUID
	Lead       []insight.Finding
	More       int
	Confidence *float64
	FollowUps  []insight.FollowUp
	// Traded is the window's closed-order count. Zero means the shop did not
	// open at all, which changes whether a brief should be sent; see emailBrief.
	Traded int
	// OptedOut is the café's dailyBriefEmail preference, read in the same
	// transaction as everything else. An unsubscribe that the sender does not
	// actually honour is worse than no unsubscribe link at all.
	OptedOut bool
	// Recipients is resolved INSIDE the café transaction. tenant_members' RLS
	// policy is (tenant_id = current_tenant_id() OR user_id = current_user_id()),
	// so a lookup with neither GUC set returns zero rows — silently, which is how
	// the first version of this shipped a brief that could never find anybody.
	Recipients []string
	Skipped    bool // the row was already there: another tick beat us to it
}

// briefFor produces one café's brief, then sends it.
//
// The transaction covers reserving the marker, gathering, detecting and storing.
// The EMAIL is deliberately outside it: SMTP is slow and can fail, and a failed
// send must not roll back the findings — they are the café's data, and the
// findings page should show them whether or not the email got through.
func (r *Runner) briefFor(ctx context.Context, c dueCafe, now time.Time) error {
	var res briefResult

	if err := r.withTenant(ctx, c.TenantID, func(tx pgx.Tx) error {
		var err error
		res, err = r.computeBrief(ctx, tx, c, now)
		return err
	}); err != nil {
		return err
	}
	if res.Skipped {
		return nil
	}

	sent, recipients, err := r.emailBrief(ctx, c, res)
	if err != nil {
		// The brief itself stands; only delivery failed. Alert and move on rather
		// than leaving the marker unstamped, which would re-send tomorrow.
		alert.Fire(ctx, slog.LevelError, "insight.brief_email_failed", err, "tenant", c.Slug)
		return nil
	}
	if !sent {
		return nil
	}
	return r.withTenant(ctx, c.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE insight_briefs SET emailed_at = now(), email_recipients = $2
			WHERE id = $1`, res.BriefID, recipients)
		return err
	})
}

// withTenant runs fn in a transaction scoped to one café, exactly the way
// db.TxMiddleware scopes a request.
//
// set_config(..., true) makes the GUC TRANSACTION-LOCAL, so it cannot leak onto
// the next user of this pooled connection. That is a structural guarantee rather
// than the defer-and-hope that a session-level GUC needs.
func (r *Runner) withTenant(ctx context.Context, tenantID uuid.UUID, fn func(pgx.Tx) error) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// computeBrief does the work inside one café's transaction.
func (r *Runner) computeBrief(ctx context.Context, tx pgx.Tx, c dueCafe, now time.Time) (briefResult, error) {
	var res briefResult

	// Reserve the marker FIRST. If another tick got here already, ON CONFLICT
	// DO NOTHING returns no row and we stop — before spending a dozen queries.
	err := tx.QueryRow(ctx, `
		INSERT INTO insight_briefs (tenant_id, day, kind)
		VALUES (current_tenant_id(), $1, 'daily')
		ON CONFLICT (tenant_id, day, kind) DO NOTHING
		RETURNING id`, c.LocalDay).Scan(&res.BriefID)
	if errors.Is(err, pgx.ErrNoRows) {
		res.Skipped = true
		return res, nil
	}
	if err != nil {
		return res, err
	}

	in, err := insight.Gather(ctx, tx, now, c.TZ)
	if err != nil {
		return res, err
	}
	found := insight.RunAll(now, in)
	res.Traded = in.Window.OrderCount

	if _, err := insight.Store(ctx, tx, c.LocalDay, found); err != nil {
		return res, err
	}
	if _, err := insight.CloseStale(ctx, tx, c.LocalDay); err != nil {
		return res, err
	}

	muted, err := insight.MutedDetectors(ctx, tx)
	if err != nil {
		return res, err
	}
	// The brief goes to owners and managers, so it is built for somebody holding
	// everything. Per-recipient filtering of the EMAIL is a Stage-2 refinement;
	// the findings page already filters correctly per viewer.
	viewer := insight.Viewer{
		Can:        func(string) bool { return true },
		HasFeature: func(billing.FeatureKey) bool { return true },
		Muted:      muted,
	}
	res.Lead, res.More = insight.ForBrief(found, viewer)

	if res.FollowUps, err = insight.DueFollowUps(ctx, tx, c.LocalDay); err != nil {
		return res, err
	}
	if v, ok := in.BooksConfidence(); ok {
		res.Confidence = &v
	}
	if res.Recipients, err = briefRecipients(ctx, tx); err != nil {
		return res, err
	}
	// Default true: a café that has never touched the setting gets the brief.
	if err := tx.QueryRow(ctx, `
		SELECT NOT COALESCE((preferences->>'dailyBriefEmail')::boolean, true)
		FROM tenants WHERE id = current_tenant_id()
	`).Scan(&res.OptedOut); err != nil {
		return res, err
	}

	// Record what the brief actually led with, so "the email told me X on
	// Tuesday" stays answerable after the finding closes.
	for i, f := range res.Lead {
		if _, err := tx.Exec(ctx, `
			INSERT INTO insight_brief_items (tenant_id, brief_id, finding_id, rank)
			SELECT current_tenant_id(), $1, f.id, $2
			FROM insight_findings f
			WHERE f.detector_key = $3 AND f.subject_kind = $4 AND f.subject_key = $5
			  AND f.state <> 'closed'
			ON CONFLICT DO NOTHING`,
			res.BriefID, i, f.DetectorKey, string(f.SubjectKind), f.SubjectKey); err != nil {
			return res, err
		}
	}

	_, err = tx.Exec(ctx, `
		UPDATE insight_briefs
		SET finding_count = $2, lead_count = $3, more_count = $4, books_confidence = $5
		WHERE id = $1`,
		res.BriefID, len(found), len(res.Lead), res.More, res.Confidence)
	return res, err
}

// emailBrief sends the morning email, or reports that there was nothing worth
// sending. Returns (sent, recipients, error).
func (r *Runner) emailBrief(ctx context.Context, c dueCafe, res briefResult) (bool, int, error) {
	// digest.go's rule, applied per café: "a digest that arrives every morning
	// saying nothing happened is a digest people stop reading." A quiet café gets
	// silence — and the marker is still written, so it stays quiet rather than
	// being retried all morning.
	if len(res.Lead) == 0 && len(res.FollowUps) == 0 {
		r.log.Info("insight.brief_quiet", "tenant", c.Slug)
		return false, 0, nil
	}

	if res.OptedOut {
		r.log.Info("insight.brief_opted_out", "tenant", c.Slug)
		return false, 0, nil
	}

	// A café that has not traded at all in the window gets no MORNING brief.
	// Some detectors are timeless — a credit balance is stale whether or not the
	// shop opened — so a dormant café would otherwise be emailed "3 things to
	// look at" every single day about the same old debts, with no takings line to
	// put them next to. The findings still stand and stay on the findings page;
	// a café that has stopped trading is the platform's problem to notice (the
	// usage digest already flags dormancy), not something to nag the owner about
	// each morning.
	if res.Traded == 0 {
		r.log.Info("insight.brief_dormant", "tenant", c.Slug, "findings", len(res.Lead), "orders", res.Traded, "day", c.LocalDay.Format("2006-01-02"))
		return false, 0, nil
	}

	to := res.Recipients
	if len(to) == 0 {
		r.log.Warn("insight.brief_no_recipients", "tenant", c.Slug)
		return false, 0, nil
	}

	brief := mail.Brief{
		CafeName:   c.Name,
		Day:        c.LocalDay,
		More:       res.More,
		Confidence: res.Confidence,
		AppURL:     r.cfg.AppURL,
		To:         to,
		// A distinct sender from login codes, so a complaint about scheduled
		// mail cannot damage the reputation OTP delivery depends on.
		From:          r.cfg.BriefFrom,
		FromName:      r.cfg.BriefFromName,
		UnsubscribeTo: r.cfg.BriefUnsubscribeTo,
	}
	// Map the domain onto the mail package's plain DTO. mail deliberately owns
	// its own shape and imports nothing from insight, the same way it does for
	// ShiftSummary — so email wording can change without touching detectors.
	base := strings.TrimRight(r.cfg.AppURL, "/")
	for _, f := range res.Lead {
		item := mail.BriefItem{
			Severity: string(f.Severity),
			Label:    f.SubjectLabel,
			Detail:   f.Detail,
		}
		if d, ok := insight.ByKey(f.DetectorKey); ok {
			if item.Label == "" {
				item.Label = d.Label
			}
			// Only absolute links, and only when there is a base to build one
			// from — a relative href in an email goes nowhere.
			if base != "" {
				if path := d.Link(f); path != "" {
					item.Link = base + path
				}
			}
		}
		brief.Items = append(brief.Items, item)
	}
	for _, fu := range res.FollowUps {
		label := fu.SubjectLabel
		higherIsBetter := false
		if d, ok := insight.ByKey(fu.DetectorKey); ok {
			if label == "" {
				label = d.Label
			}
			// Coverage is the one family where a RISING number is the good news.
			higherIsBetter = d.Key == "cost_coverage" || d.Key == "unallocated_spend"
		}
		brief.FollowUps = append(brief.FollowUps, mail.BriefFollowUp{
			Label:      label,
			Note:       fu.Note,
			Detail:     fu.Detail,
			AcceptedOn: fu.AcceptedOn,
			Moved:      fu.Then != fu.Now,
			Improved:   fu.Improved(higherIsBetter),
		})
	}

	if brief.Empty() {
		return false, 0, nil
	}
	msg := mail.BriefMessage(brief)
	if r.mailer == nil {
		// Dev: no relay. Log the body so the brief can be developed and read
		// without SMTP creds — the same courtesy the OTP and digest flows give.
		r.log.Info("insight.brief_preview", "tenant", c.Slug, "subject", msg.Subject,
			"body", msg.Text)
		return false, 0, nil
	}
	if err := r.mailer.Send(msg); err != nil {
		return false, 0, err
	}
	return true, len(to), nil
}

// briefRecipients is every active owner and manager with an email.
//
// MUST run inside the café's transaction. tenant_members' policy is
//
//	(current_tenant_id() IS NOT NULL AND tenant_id = current_tenant_id())
//	OR (current_tenant_id() IS NULL AND user_id = current_user_id())
//
// so with neither GUC set it returns nothing at all. The first version of this
// ran on the bare pool and found no recipients for any café — no error, just an
// empty list and a warning, which is the worst possible failure shape.
//
// users is global (not tenant-scoped), so joining it from here is fine.
func briefRecipients(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT u.email::text
		FROM tenant_members tm
		JOIN users u ON u.id = tm.user_id
		JOIN tenant_member_roles tmr
		  ON tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id
		JOIN roles ro ON ro.id = tmr.role_id
		WHERE tm.status = 'active'
		  AND u.email IS NOT NULL AND u.deleted_at IS NULL
		  AND ro.key IN ('owner', 'manager')
		ORDER BY 1
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
