package jobs

import (
	"context"
	"errors"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
)

// Reconciling staff rosters against their end dates.
//
// The handlers already reconcile on create and update, so a manager who types
// an end date sees it take effect on that request. This exists for the case
// that actually motivated the feature: a date set weeks ago that simply arrives
// one morning with nobody editing anything. See migration 0083.
//
// NO MARKER TABLE, AND NO DAILY HOUR
//
// The brief and the wrap both reserve a per-cafe row before doing their work,
// because both of them send an email and neither can be repeated. This can be
// repeated: it is two UPDATEs whose WHERE clauses stop matching the moment they
// have run, so doing it twice is indistinguishable from doing it once.
//
// That means the due-query itself can be the idempotence. It asks for cafes
// that have at least one row needing a change RIGHT NOW, in that cafe's own
// timezone — so the overwhelming majority of ticks select nothing at all, and a
// cafe stops being selected the instant its roster is correct. No marker, no
// hour gate, and a leaving date takes effect within a tick rather than waiting
// for a nightly window.

// runStaffStatus reconciles every cafe whose roster is out of step with its own
// end dates. A failure on one cafe is reported and skipped: one bad timezone
// string must not leave every other roster stale.
func (r *Runner) runStaffStatus(ctx context.Context) (int, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	due, err := r.dueStaffStatusCafes(ctx, conn.Conn())
	if err != nil {
		return 0, err
	}

	changed := 0
	for _, c := range due {
		// Each cafe runs in its own transaction with app.tenant_id set exactly
		// as db.TxMiddleware sets it, so staff's plain
		// `tenant_id = current_tenant_id()` policy applies unchanged.
		cafe := c
		err := r.withTenant(ctx, cafe.TenantID, func(tx pgx.Tx) error {
			off, on, err := reconcileStaffForTenant(ctx, tx, cafe.LocalDay.Format("2006-01-02"))
			if err != nil {
				return err
			}
			if off > 0 || on > 0 {
				changed += off + on
				r.log.Info("jobs.staff_status",
					"cafe", cafe.Slug, "deactivated", off, "reactivated", on)
			}
			return nil
		})
		if err != nil {
			alert.Fire(ctx, slog.LevelError, "staff.status_reconcile_failed", err,
				"cafe", cafe.Slug)
		}
	}
	return changed, nil
}

// reconcileStaffForTenant mirrors api.reconcileStaffStatus.
//
// The two are deliberately not shared through a third package: this one is
// handed a transaction, the API one takes it from a request context, and the
// SQL is small enough that the indirection would cost more than the duplication.
// staff_status_test.go asserts both halves behave identically.
func reconcileStaffForTenant(ctx context.Context, tx pgx.Tx, today string) (deactivated, reactivated int, err error) {
	// Strictly `<`: somebody whose last working day is today is still working
	// today, and `<=` would deactivate them mid-shift.
	tag, err := tx.Exec(ctx, `
		UPDATE staff
		   SET status = 'inactive', auto_deactivated_on = $1::date
		 WHERE deleted_at IS NULL
		   AND status = 'active'
		   AND ended_on IS NOT NULL
		   AND ended_on < $1::date
	`, today)
	if err != nil {
		return 0, 0, err
	}
	deactivated = int(tag.RowsAffected())

	// Only rows this reconciler deactivated itself. Without the marker, every
	// manually deactivated person with a blank end date — suspended, on leave,
	// mid-dispute — would be silently reactivated the next time this ran.
	tag, err = tx.Exec(ctx, `
		UPDATE staff
		   SET status = 'active', auto_deactivated_on = NULL
		 WHERE deleted_at IS NULL
		   AND status = 'inactive'
		   AND auto_deactivated_on IS NOT NULL
		   AND (ended_on IS NULL OR ended_on >= $1::date)
	`, today)
	if err != nil {
		return deactivated, 0, err
	}
	return deactivated, int(tag.RowsAffected()), nil
}

// dueStaffStatusCafes returns only the cafes with at least one staff row that
// would change, each with its own local date. This is what makes the sweep
// cheap enough to run every tick and idempotent without a marker.
//
// It borrows a platform admin only to ask the question — which has no tenant
// context. The reconcile itself runs per-cafe under that cafe's own RLS, so the
// borrowed identity never widens what is touched.
func (r *Runner) dueStaffStatusCafes(ctx context.Context, conn *pgx.Conn) ([]dueCafe, error) {
	var adminID uuid.UUID
	if err := conn.QueryRow(ctx,
		`SELECT user_id FROM platform_admins ORDER BY created_at LIMIT 1`).Scan(&adminID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The same failure mode snapshot.go names explicitly: with no admin
			// to run as, this would silently look like "no cafes are due"
			// forever rather than like a broken job.
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

	rows, err := conn.Query(ctx, `
		WITH cafe AS (
		  SELECT t.id, t.name, t.slug,
		         COALESCE(NULLIF(t.timezone, ''), 'Asia/Kathmandu') AS tz
		  FROM tenants t
		  WHERE t.deleted_at IS NULL AND t.status = 'active'
		),
		localised AS (
		  SELECT c.*, (now() AT TIME ZONE c.tz)::date AS local_day FROM cafe c
		)
		SELECT l.id, l.name, l.slug, l.tz, l.local_day
		FROM localised l
		WHERE EXISTS (
		  SELECT 1 FROM staff s
		  WHERE s.tenant_id = l.id AND s.deleted_at IS NULL
		    AND (
		      (s.status = 'active'
		         AND s.ended_on IS NOT NULL AND s.ended_on < l.local_day)
		      OR
		      (s.status = 'inactive'
		         AND s.auto_deactivated_on IS NOT NULL
		         AND (s.ended_on IS NULL OR s.ended_on >= l.local_day))
		    )
		)
		ORDER BY l.slug
	`)
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
