package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// SelectTenant binds the active session to a chosen workspace.
//
//	POST /v1/sessions/select-tenant
//	{ "tenant_slug": "sahan" }
//
// 403 if the user isn't a member of that tenant.
func SelectTenant(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := appctx.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
			return
		}

		var body struct {
			TenantSlug string `json:"tenant_slug"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TenantSlug == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "tenant_slug required")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "tenant.select", "tenant_slug", body.TenantSlug)

		tx := appctx.Tx(r.Context())
		var tenantID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id FROM tenants
			WHERE slug = $1 AND deleted_at IS NULL AND status = 'active'
		`, body.TenantSlug).Scan(&tenantID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "tenant_not_found", "no such tenant")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Verify membership using the user-scoped RLS branch and collect
		// the role keys (for the response — permissions are loaded on the
		// next request by RequireMember).
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT status::text FROM tenant_members
			WHERE tenant_id = $1 AND user_id = $2
		`, tenantID, user.ID).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusForbidden, "not_a_member", "user is not a member of this tenant")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "active" {
			writeErr(w, http.StatusForbidden, "not_a_member", "user is not an active member of this tenant")
			return
		}
		rolesRows, err := tx.Query(r.Context(), `
			SELECT r.key FROM tenant_member_roles tmr
			JOIN roles r ON r.id = tmr.role_id
			WHERE tmr.tenant_id = $1 AND tmr.user_id = $2
			ORDER BY r.key
		`, tenantID, user.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		roles := []string{}
		for rolesRows.Next() {
			var k string
			if err := rolesRows.Scan(&k); err != nil {
				rolesRows.Close()
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			roles = append(roles, k)
		}
		rolesRows.Close()

		// Promote the request tx into the chosen tenant scope so audit_log's
		// RLS policy accepts the row. The tx was opened by db.TxMiddleware
		// without tenant_id (this endpoint sits in the optional-tenant
		// group); setting app.tenant_id mid-tx is safe.
		if _, err := tx.Exec(r.Context(),
			`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
			tenantID.String(), user.ID.String()); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Build a Tenant in context so audit.Log can read tenant.ID. The
		// existing context likely has no tenant resolved (optional middleware).
		ctxWithTenant := appctx.WithTenant(r.Context(), appctx.Tenant{
			ID:   tenantID,
			Slug: body.TenantSlug,
		})
		if err := audit.Log(ctxWithTenant, tx, audit.Entry{
			Action:  "login",
			Entity:  "session",
			Summary: fmt.Sprintf("%s opened workspace", user.Email),
		}); err != nil {
			// Don't fail the workspace pick on an audit-write hiccup; tenant
			// activation is client-side (the X-Tenant-ID header on subsequent
			// requests), so there's nothing to roll back here.
			log.WarnContext(r.Context(), "audit.login.write_failed", "err", err.Error())
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tenant_slug": body.TenantSlug,
			"roles":       roles,
		})
	}
}
