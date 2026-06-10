package audit

import (
	"context"
	"net"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// PlatformEntry is one super-admin action for the cross-tenant platform_audit
// log. Actor/ip/request_id are pulled from context; the rest is supplied by
// the caller.
type PlatformEntry struct {
	Action         string     // plan.create | tenant.change_plan | request.approve | admin.add | ...
	TargetTenantID *uuid.UUID // nil for non-tenant actions (plan CRUD, admin mgmt)
	TargetID       string     // free-form (plan key, request id, email)
	Summary        string
	Meta           map[string]any
}

// LogPlatform writes one platform_audit row inside the given tx. Unlike
// audit.Log, this is NOT tenant-scoped — platform_audit is a global table, so
// it works on the /super routes which carry no tenant context.
func LogPlatform(ctx context.Context, tx pgx.Tx, e PlatformEntry) error {
	user, _ := appctx.UserFromContext(ctx)
	reqID, _ := appctx.RequestID(ctx)
	ipStr, _ := appctx.IP(ctx)

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
	meta := e.Meta
	if meta == nil {
		meta = map[string]any{}
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO platform_audit (
			actor_user_id, actor_email, action, target_tenant_id,
			target_id, summary, meta, ip, request_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`,
		actorID, user.Email, e.Action, e.TargetTenantID,
		e.TargetID, e.Summary, meta, ipArg, reqID,
	)
	return err
}
