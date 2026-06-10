// Package api wires HTTP handlers for the v1 surface.
package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// Membership describes one tenant the current user belongs to.
type Membership struct {
	TenantID   uuid.UUID `json:"tenant_id"`
	TenantSlug string    `json:"tenant_slug"`
	TenantName string    `json:"tenant_name"`
	Roles      []string  `json:"roles"`
	Status     string    `json:"status"`
}

// BillingInfo is the active tenant's plan snapshot, included on /me so the
// SPA can render the /super nav and the trial/lock banners without an extra
// request or tripping a 402.
type BillingInfo struct {
	PlanKey     string     `json:"plan_key"`
	Phase       string     `json:"phase"`
	TrialEndsAt *time.Time `json:"trial_ends_at,omitempty"`
	WriteLocked bool       `json:"write_locked"`
	MemberLimit *int       `json:"member_limit"` // nil = unlimited
	SeatsUsed   int        `json:"seats_used"`   // active members + pending invites
	Features    []string   `json:"features"`
}

// MeResponse is what GET /v1/me returns.
type MeResponse struct {
	UserID            uuid.UUID    `json:"user_id"`
	Email             string       `json:"email"`
	Name              string       `json:"name"`
	ActiveTenant      *string      `json:"active_tenant_slug,omitempty"`
	Memberships       []Membership `json:"memberships"`
	ActiveRoles       []string     `json:"active_roles,omitempty"`
	ActiveRoleKeys    []string     `json:"active_role_keys,omitempty"`
	ActivePermissions []string     `json:"active_permissions,omitempty"`
	IsPlatformAdmin   bool         `json:"is_platform_admin"`
	Billing           *BillingInfo `json:"billing,omitempty"`
}

// Me handles GET /v1/me. Returns the current user's identity plus all
// tenant memberships. If a tenant is resolved on the request, the active
// role + permission set are included so the SPA can gate UI on first
// paint without an extra round-trip.
func Me(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := appctx.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "me.get")
		tx := appctx.Tx(r.Context())

		// Aggregate role keys per (tenant, user) via tenant_member_roles → roles.
		rows, err := tx.Query(r.Context(), `
			SELECT
				tm.tenant_id, t.slug, t.name,
				COALESCE(
					(SELECT array_agg(r.key ORDER BY r.key)
					   FROM tenant_member_roles tmr
					   JOIN roles r ON r.id = tmr.role_id
					  WHERE tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id),
					'{}'::text[]
				) AS role_keys,
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
			if err := rows.Scan(&m.TenantID, &m.TenantSlug, &m.TenantName, &m.Roles, &m.Status); err != nil {
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
					resp.ActiveRoles = m.Roles
					resp.ActiveRoleKeys = m.Roles
					break
				}
			}
			// Load the flattened permission set for the active tenant so the
			// SPA can drive can(perm) checks immediately.
			if ps, err := repo.LoadForMember(r.Context(), tx, t.ID, user.ID); err == nil {
				perms := make([]string, 0, len(ps.Set))
				for k := range ps.Set {
					perms = append(perms, k)
				}
				sort.Strings(perms)
				resp.ActivePermissions = perms
			} else {
				log.WarnContext(r.Context(), "me.load_permissions_failed", "err", err.Error())
			}

			// Plan snapshot for the active tenant.
			if st, err := billing.LoadStateTx(r.Context(), tx, t.ID); err == nil {
				var active, pending int
				_ = tx.QueryRow(r.Context(), `
					SELECT
						(SELECT count(*) FROM tenant_members WHERE status = 'active'),
						(SELECT count(*) FROM tenant_invites WHERE accepted_at IS NULL AND revoked_at IS NULL)
				`).Scan(&active, &pending)
				resp.Billing = &BillingInfo{
					PlanKey:     st.PlanKey,
					Phase:       st.Phase,
					TrialEndsAt: st.TrialEndsAt,
					WriteLocked: st.WriteLocked,
					MemberLimit: st.EffectiveLimit,
					SeatsUsed:   active + pending,
					Features:    st.FeatureList(),
				}
			} else {
				log.WarnContext(r.Context(), "me.load_billing_failed", "err", err.Error())
			}
		}

		// Platform-admin flag — drives the /super nav. Cheap STABLE function;
		// platform_admins is global so this works with or without a tenant.
		_ = tx.QueryRow(r.Context(), `SELECT is_platform_admin($1)`, user.ID).Scan(&resp.IsPlatformAdmin)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
