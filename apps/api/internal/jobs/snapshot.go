package jobs

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/platform/health"
)

// SnapshotDay writes one tenant_health_daily row per live tenant for the given
// day. Returns how many rows it wrote.
//
// Idempotent by primary key: re-running for the same day updates in place, so a
// restart mid-run, a manual re-trigger, or two overlapping ticks all converge
// on the same result rather than duplicating or erroring.
//
// The per-day COUNTS come from the orders/shifts tables directly (they're a
// property of that specific day), but the STATUS is the live grade at the time
// of the run. That's deliberate: the digest diffs "what did we think yesterday"
// against "what do we think now", and re-deriving a historical grade would need
// a historical rollup we don't keep.
func (r *Runner) SnapshotDay(ctx context.Context, day time.Time) (int, error) {
	d := day.Format("2006-01-02")

	// Per-day activity, in each café's own timezone so a day boundary means
	// what the café thinks it means.
	rows, err := r.pool.Query(ctx, `
		SELECT t.id,
		       (SELECT count(*)::int FROM orders o
		          WHERE o.tenant_id = t.id AND o.status = 'closed'
		            AND (o.closed_at AT TIME ZONE t.timezone)::date = $1::date),
		       (SELECT COALESCE(SUM(o.total_cents - o.tax_cents), 0)::bigint FROM orders o
		          WHERE o.tenant_id = t.id AND o.status = 'closed'
		            AND (o.closed_at AT TIME ZONE t.timezone)::date = $1::date),
		       (SELECT count(*)::int FROM shifts sh
		          WHERE sh.tenant_id = t.id
		            AND (sh.opened_at AT TIME ZONE t.timezone)::date = $1::date),
		       (SELECT count(*)::int FROM shifts sh
		          WHERE sh.tenant_id = t.id AND sh.closed_at IS NOT NULL
		            AND (sh.closed_at AT TIME ZONE t.timezone)::date = $1::date),
		       (SELECT count(*)::int FROM tenant_members tm
		          WHERE tm.tenant_id = t.id AND tm.status = 'active'
		            AND (tm.last_seen_at AT TIME ZONE t.timezone)::date = $1::date)
		FROM tenants t
		WHERE t.deleted_at IS NULL
	`, d)
	if err != nil {
		return 0, err
	}

	type daily struct {
		orders, shiftsOpened, shiftsClosed, activeMembers int
		grossCents                                        int64
	}
	perDay := map[uuid.UUID]daily{}
	for rows.Next() {
		var id uuid.UUID
		var v daily
		if err := rows.Scan(&id, &v.orders, &v.grossCents, &v.shiftsOpened, &v.shiftsClosed, &v.activeMembers); err != nil {
			rows.Close()
			return 0, err
		}
		perDay[id] = v
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	graded, err := r.gradeAll(ctx)
	if err != nil {
		return 0, err
	}

	written := 0
	for id, v := range perDay {
		g, ok := graded[id]
		if !ok {
			continue
		}
		signals, err := json.Marshal(g.Signals)
		if err != nil {
			return written, err
		}
		if _, err := r.pool.Exec(ctx, `
			INSERT INTO tenant_health_daily
				(tenant_id, day, orders, gross_cents, shifts_opened, shifts_closed,
				 active_members, status, signals, computed_at)
			VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, now())
			ON CONFLICT (tenant_id, day) DO UPDATE SET
				orders = EXCLUDED.orders, gross_cents = EXCLUDED.gross_cents,
				shifts_opened = EXCLUDED.shifts_opened, shifts_closed = EXCLUDED.shifts_closed,
				active_members = EXCLUDED.active_members, status = EXCLUDED.status,
				signals = EXCLUDED.signals, computed_at = now()
		`, id, d, v.orders, v.grossCents, v.shiftsOpened, v.shiftsClosed,
			v.activeMembers, string(g.Status), signals); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// gradeAll runs the live rollup and grades every tenant.
//
// The job pool connects as app_user, which is NOBYPASSRLS and has no
// app.user_id GUC set — and platform_tenant_usage() self-gates on
// is_platform_admin(current_user_id()). So the connection borrows a platform
// admin's identity for the read. That's the same authority the console would
// use; the alternative (a second, ungated copy of the function) would be a
// standing hole with no caller.
func (r *Runner) gradeAll(ctx context.Context) (map[uuid.UUID]health.Result, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()

	var adminID uuid.UUID
	if err := conn.QueryRow(ctx, `SELECT user_id FROM platform_admins ORDER BY created_at LIMIT 1`).Scan(&adminID); err != nil {
		// No platform admin exists yet — nothing to snapshot for, and nobody to
		// mail. Not an error worth paging anyone about.
		return map[uuid.UUID]health.Result{}, nil
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.user_id', $1, false)`, adminID.String()); err != nil {
		return nil, err
	}
	// Reset the GUC before the connection goes back in the pool: a pooled
	// connection carrying a stale app.user_id would silently grant the next
	// borrower that admin's identity.
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT set_config('app.user_id', '', false)`)
	}()

	ages := map[uuid.UUID]int{}
	ageRows, err := conn.Query(ctx, `
		SELECT id, GREATEST(0, EXTRACT(day FROM now() - created_at)::int)
		FROM tenants WHERE deleted_at IS NULL
	`)
	if err != nil {
		return nil, err
	}
	for ageRows.Next() {
		var id uuid.UUID
		var age int
		if err := ageRows.Scan(&id, &age); err != nil {
			ageRows.Close()
			return nil, err
		}
		ages[id] = age
	}
	ageRows.Close()
	if err := ageRows.Err(); err != nil {
		return nil, err
	}

	rows, err := conn.Query(ctx, `SELECT * FROM platform_tenant_usage(NULL)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now()
	out := map[uuid.UUID]health.Result{}
	for rows.Next() {
		var (
			id                                 uuid.UUID
			lastOrder, lastShift, openShift    *time.Time
			orders7d, prev28d                  int
			gross                              int64
			operatingDays, closedDays, members int
			menuItems                          int
			adoption                           health.Adoption
		)
		if err := rows.Scan(&id, &lastOrder, &orders7d, &prev28d, &gross, &lastShift,
			&openShift, &operatingDays, &closedDays, &members, &menuItems, &adoption); err != nil {
			return nil, err
		}
		out[id] = health.Compute(now, health.Signals{
			TenantAgeDays:     ages[id],
			LastOrderClosedAt: lastOrder,
			Orders7d:          orders7d,
			OrdersPrev28d:     prev28d,
			OperatingDays7d:   operatingDays,
			ShiftClosedDays7d: closedDays,
			OpenShiftSince:    openShift,
			ActiveMembers7d:   members,
			MenuItemCount:     menuItems,
			Adoption:          adoption,
		})
	}
	return out, rows.Err()
}
