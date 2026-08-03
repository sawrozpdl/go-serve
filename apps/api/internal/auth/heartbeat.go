package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// heartbeatEvery throttles the per-member last_seen_at write. A busy waiter
// fires dozens of requests a minute and we only need to know "was this person
// around today", so at most one write per member per window is plenty.
const heartbeatEvery = 30 * time.Minute

// Heartbeat stamps tenant_members.last_seen_at for the acting member.
//
// This is what makes the console's `engagement` usage signal real. The
// alternative sources don't work: sessions.last_seen_at has existed since 0001
// but nothing ever wrote it and it's user-global rather than per-tenant, and
// audit_log is a default-off feature (0051) so it's empty for most workspaces.
// Without a per-member stamp there is no way to tell "only the owner ever logs
// in" from "the whole team is in here every day".
//
// Mount AFTER db.TxMiddleware: it rides the request's own transaction, so the
// stamp commits with the request and costs no extra round-trip beyond the
// UPDATE itself.
//
// The whole thing runs inside a SAVEPOINT. A heartbeat is bookkeeping — if it
// fails it must not abort the transaction and take the actual request down
// with it. Without the savepoint a failed statement leaves pgx's tx in the
// aborted state (SQLSTATE 25P02) and every subsequent handler query dies.
func Heartbeat(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stampLastSeen(r.Context())
		next.ServeHTTP(w, r)
	})
}

func stampLastSeen(ctx context.Context) {
	tenant, ok := appctx.TenantFromContext(ctx)
	if !ok {
		return
	}
	user, ok := appctx.UserFromContext(ctx)
	if !ok {
		return
	}
	tx := appctx.Tx(ctx)
	if tx == nil {
		return
	}

	sp, err := tx.Begin(ctx) // nested Begin == SAVEPOINT in pgx
	if err != nil {
		return
	}
	// The throttle lives in the WHERE clause, so the common case is a single
	// indexed statement that matches nothing — no read round-trip first.
	if _, err := sp.Exec(ctx, `
		UPDATE tenant_members
		SET last_seen_at = now()
		WHERE tenant_id = $1 AND user_id = $2
		  AND (last_seen_at IS NULL OR last_seen_at < now() - $3::interval)
	`, tenant.ID, user.ID, heartbeatEvery.String()); err != nil {
		_ = sp.Rollback(ctx)
		return
	}
	if err := sp.Commit(ctx); err != nil && err != pgx.ErrTxClosed {
		_ = sp.Rollback(ctx)
	}
}
