package api

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// Keeping the staff roster honest about its own end dates.
//
// staff.ended_on has existed since 0033 and nothing read it: a cafe would set a
// leaving date, the date would pass, and the person stayed on the active roster
// until somebody remembered. See migration 0083 for the full reasoning; the two
// rules that matter are repeated here because this is where they are enforced.

// tenantToday returns the tenant's local calendar date as YYYY-MM-DD.
//
// Computed IN POSTGRES rather than in Go. time.Now() in the API container is
// UTC, and the database session's TimeZone is whatever the server was built
// with — on a dev box that often happens to BE the tenant's own zone, which is
// exactly what hides this class of bug until production. The expression is the
// same one history.go already uses for "today", so the product has one
// definition of the word.
//
// The zone is read from the tenant ROW rather than taken from the request
// context. The context's copy is a snapshot taken when the request was
// authenticated, and a handler that changes the workspace timezone in the same
// transaction would then reconcile against the old one. Reading it here costs
// nothing — this is already a query — and removes the question entirely.
func tenantToday(ctx context.Context) (string, error) {
	var d string
	err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT (now() AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'Asia/Kathmandu'))::date::text
		FROM tenants t WHERE t.id = current_tenant_id()
	`).Scan(&d)
	return d, err
}

// reconcileStaffStatus brings every staff row in the current tenant into line
// with its end date, as of `today` (a tenant-local YYYY-MM-DD).
//
// Idempotent: running it twice on the same day changes nothing the second time,
// which is what makes it safe to call from a request handler AND from a nightly
// job without either having to know about the other.
//
// Returns how many people it deactivated and reactivated, so the caller can say
// so in an audit line rather than the change appearing from nowhere.
func reconcileStaffStatus(ctx context.Context, tx pgx.Tx, today string) (deactivated, reactivated int, err error) {
	// Leavers. Strictly `<`: somebody whose last working day is today is still
	// working today, and `<=` would deactivate them mid-shift.
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

	// Returners — and ONLY those this reconciler deactivated itself. The marker
	// is the whole safety property: without it, every manually deactivated
	// person with a blank end date (suspended, on leave, mid-dispute) would be
	// silently reactivated the next time this ran.
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
	reactivated = int(tag.RowsAffected())

	return deactivated, reactivated, nil
}
