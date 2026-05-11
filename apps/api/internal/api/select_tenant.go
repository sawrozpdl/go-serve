package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
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
		sess, ok := appctx.SessionFromContext(r.Context())
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

		// Verify membership using the user-scoped RLS branch.
		// (tenant context is whatever was resolved from URL — may differ.)
		var roles []string
		if err := tx.QueryRow(r.Context(), `
			SELECT roles::text[] FROM tenant_members
			WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
		`, tenantID, user.ID).Scan(&roles); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusForbidden, "not_a_member", "user is not a member of this tenant")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Persist on the session row (outside the request tx — sessions
		// is not RLS-scoped, so this is safe).
		if err := auth.SetTenant(r.Context(), pool, sess.ID, tenantID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tenant_slug": body.TenantSlug,
			"roles":       roles,
		})
	}
}
