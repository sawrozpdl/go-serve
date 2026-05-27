package api

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

// IssueWSTicket mints a short-lived, single-use WebSocket ticket for the
// authenticated member + resolved tenant. Mount in the tenant-scoped group so
// RequireMember has already confirmed active membership.
//
//	POST /v1/ws-ticket  →  { "ticket": "..." }
func IssueWSTicket(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := appctx.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "auth required")
			return
		}
		t, ok := appctx.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusBadRequest, "tenant_required", "tenant context required")
			return
		}
		ticket, err := auth.CreateWSTicket(r.Context(), pool, user.ID, t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "ticket mint failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ticket": ticket})
	}
}
