package api

import (
	"context"
	"encoding/json"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// auditEvent inserts a row into the legacy audit_events table inside the
// current request tx. Quiet on failure — auditing is best-effort, not
// blocking. The richer audit/audit.go layer covers structured rows; this
// helper preserves the older lightweight call sites until they migrate.
func auditEvent(ctx context.Context, action, entityType, entityID string, meta map[string]any) {
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		return
	}
	user, _ := appctx.UserFromContext(ctx)
	tx := appctx.Tx(ctx)
	metaJSON, _ := json.Marshal(meta)
	if metaJSON == nil {
		metaJSON = []byte("{}")
	}
	_, _ = tx.Exec(ctx, `
		INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, t.ID, user.ID, action, entityType, entityID, metaJSON)
}
