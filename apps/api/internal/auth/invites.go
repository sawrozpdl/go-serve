package auth

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AcceptPendingInvites finds every pending tenant_invites row for `email`
// and turns each one into an active tenant_members row for `userID`. Called
// right after a user authenticates (Google or dev), so multi-tenant
// invitations land automatically — no link, no token.
//
// Idempotent: a duplicate (tenant_id, user_id) is treated as already
// accepted (the invite is still stamped accepted_at so it stops appearing
// in pending lists).
//
// Runs in a single transaction. Each invite needs `app.tenant_id` set to
// its own tenant_id (FORCE RLS on tenant_members + tenant_invites), so we
// loop and reset the GUC per row.
func AcceptPendingInvites(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, email string) (int, error) {
	if email == "" || userID == uuid.Nil {
		return 0, nil
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	// No tenant context yet, so RLS would hide every row. The SECURITY
	// DEFINER helper installed in migration 0010 does the bounded
	// cross-tenant read on our behalf.
	rows, err := tx.Query(ctx, `SELECT id, tenant_id, roles FROM accept_invites_lookup($1)`, email)
	if err != nil {
		return 0, err
	}
	type row struct {
		id     uuid.UUID
		tenant uuid.UUID
		roles  []string
	}
	var pending []row
	for rows.Next() {
		var rr row
		if err := rows.Scan(&rr.id, &rr.tenant, &rr.roles); err != nil {
			rows.Close()
			return 0, err
		}
		pending = append(pending, rr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(pending) == 0 {
		return 0, tx.Commit(ctx)
	}

	accepted := 0
	for _, p := range pending {
		// Scope this iteration to the invite's tenant so RLS on
		// tenant_members + tenant_invites accepts the writes.
		if _, err := tx.Exec(ctx,
			"SELECT set_config('app.tenant_id', $1, true)", p.tenant.String()); err != nil {
			return accepted, err
		}
		// Insert membership. ON CONFLICT DO NOTHING handles the case where
		// the user was already added manually after the invite was created.
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_members (tenant_id, user_id, roles, status)
			VALUES ($1, $2, $3::tenant_role[], 'active')
			ON CONFLICT (tenant_id, user_id) DO NOTHING
		`, p.tenant, userID, p.roles); err != nil {
			// Foreign-key races (tenant deleted mid-flow) shouldn't crash login.
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				continue
			}
			return accepted, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE tenant_invites
			SET accepted_at = now(), accepted_by_user_id = $2
			WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
		`, p.id, userID); err != nil {
			return accepted, err
		}
		accepted++
	}
	return accepted, tx.Commit(ctx)
}

