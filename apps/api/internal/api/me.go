// Package api wires HTTP handlers for the v1 surface.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// Membership describes one tenant the current user belongs to. `Roles`
// is the new multi-role array; `Role` is the legacy primary role and is
// kept for back-compat with older client builds.
type Membership struct {
	TenantID   uuid.UUID `json:"tenant_id"`
	TenantSlug string    `json:"tenant_slug"`
	TenantName string    `json:"tenant_name"`
	Role       string    `json:"role"`
	Roles      []string  `json:"roles"`
	Status     string    `json:"status"`
}

// MeResponse is what GET /v1/me returns.
type MeResponse struct {
	UserID       uuid.UUID    `json:"user_id"`
	Email        string       `json:"email"`
	Name         string       `json:"name"`
	ActiveTenant *string      `json:"active_tenant_slug,omitempty"`
	Memberships  []Membership `json:"memberships"`
	ActiveRole   *string      `json:"active_role,omitempty"`
	ActiveRoles  []string     `json:"active_roles,omitempty"`
}

// Me handles GET /v1/me. Returns the current user's identity plus all
// tenant memberships. If a tenant is resolved on the request, the active
// role is included.
//
// Reads tenant_members via the request-scoped tx (RLS uses the user-scoped
// branch when no tenant context is set; the active-tenant branch when one
// is set).
func Me(w http.ResponseWriter, r *http.Request) {
	user, ok := appctx.UserFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "me.get")
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), `
		SELECT
			tm.tenant_id, t.slug, t.name, tm.role::text,
			COALESCE(tm.roles, ARRAY[tm.role])::text[],
			tm.status::text
		FROM tenant_members tm
		JOIN tenants t ON t.id = tm.tenant_id
		WHERE tm.user_id = $1 AND t.deleted_at IS NULL
		ORDER BY tm.joined_at
	`, user.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	resp := MeResponse{
		UserID:      user.ID,
		Email:       user.Email,
		Name:        user.Name,
		Memberships: []Membership{},
	}
	for rows.Next() {
		var m Membership
		if err := rows.Scan(&m.TenantID, &m.TenantSlug, &m.TenantName, &m.Role, &m.Roles, &m.Status); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		resp.Memberships = append(resp.Memberships, m)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if t, ok := appctx.TenantFromContext(r.Context()); ok {
		slug := t.Slug
		resp.ActiveTenant = &slug
		for _, m := range resp.Memberships {
			if m.TenantID == t.ID {
				role := m.Role
				resp.ActiveRole = &role
				resp.ActiveRoles = m.Roles
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
