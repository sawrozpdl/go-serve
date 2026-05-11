// Package audit writes append-only activity-log rows from inside handler
// transactions. Each mutating handler calls Log(ctx, tx, Entry{...}) so the
// audit row commits or rolls back with the mutation itself.
package audit

import (
	"context"
	"net"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// Entry is the per-call payload. tenant/actor/ip/request_id are pulled from
// the request context.
type Entry struct {
	Action   string     // create|update|delete|open|close|void|settle|login|...
	Entity   string     // expense|order|member|tenant|inventory|menu|shift|account|house_tab|session|...
	EntityID *uuid.UUID // nullable (e.g. login)
	Summary  string     // human-readable, e.g. `deleted expense "Coffee Beans" (Rs 2,400)`
}

// Log writes one audit_log row inside the given pgx.Tx. Errors propagate so
// the caller can return them and roll back the surrounding transaction.
func Log(ctx context.Context, tx pgx.Tx, e Entry) error {
	user, _ := appctx.UserFromContext(ctx)
	tenant, _ := appctx.TenantFromContext(ctx)

	var roles []string
	if rs, ok := appctx.Roles(ctx); ok {
		roles = rs
	}

	reqID, _ := appctx.RequestID(ctx)
	ipStr, _ := appctx.IP(ctx)

	// pgx accepts string for inet but a malformed address fails the row.
	// Strip the port that net.RemoteAddr gives us; on failure send NULL.
	var ipArg any
	if ipStr != "" {
		if host, _, err := net.SplitHostPort(ipStr); err == nil && host != "" {
			ipStr = host
		}
		if ip := net.ParseIP(strings.TrimSpace(ipStr)); ip != nil {
			ipArg = ip.String()
		}
	}

	var actorID any
	if user.ID != uuid.Nil {
		actorID = user.ID
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO audit_log (
			tenant_id, actor_id, actor_name, actor_email, role_snap,
			action, entity, entity_id, summary, ip, request_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`,
		tenant.ID,
		actorID,
		user.Name,
		user.Email,
		roles,
		e.Action,
		e.Entity,
		e.EntityID,
		e.Summary,
		ipArg,
		reqID,
	)
	return err
}
