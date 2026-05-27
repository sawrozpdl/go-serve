package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// Member is the wire shape returned by /v1/members. `roles` is the list of
// role keys this user holds on the active tenant.
type Member struct {
	UserID uuid.UUID `json:"user_id"`
	Email  string    `json:"email"`
	Name   string    `json:"name"`
	Roles  []string  `json:"roles"`
	Status string    `json:"status"`
}

// ListMembers — GET /v1/members. Tenant scoping is enforced by RLS on
// tenant_members.
func ListMembers(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "members.list")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT u.id, u.email, u.name,
		       COALESCE(
		         (SELECT array_agg(r.key ORDER BY r.key)
		            FROM tenant_member_roles tmr
		            JOIN roles r ON r.id = tmr.role_id
		           WHERE tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id),
		         '{}'::text[]
		       ) AS role_keys,
		       tm.status::text
		FROM tenant_members tm
		JOIN users u ON u.id = tm.user_id
		ORDER BY tm.joined_at
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []Member{}
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Email, &m.Name, &m.Roles, &m.Status); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": out})
}

// UpdateMemberRoles — PATCH /v1/members/{userId}/roles
// Body accepts either role keys (legacy) or role ids:
//
//	{ "role_keys": ["waiter","kitchen"] }
//	{ "role_ids":  ["uuid1","uuid2"] }
//
// At least one role is required. The "last owner" invariant is enforced
// by both a DB trigger and a defensive check here for a cleaner 409.
func UpdateMemberRoles(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := uuid.Parse(chi.URLParam(r, "userId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid user id")
			return
		}
		var body struct {
			RoleKeys []string `json:"role_keys"`
			RoleIDs  []string `json:"role_ids"`
			// Backwards compat: legacy clients still post {"roles":[...]} with
			// system role keys. We accept it.
			Roles []string `json:"roles"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		t, _ := appctx.TenantFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		// Resolve requested roles to role rows. Accept role_ids first, then
		// role_keys, then legacy "roles" (keys).
		var roleIDs []uuid.UUID
		var roleKeysForLog []string
		switch {
		case len(body.RoleIDs) > 0:
			for _, s := range body.RoleIDs {
				id, err := uuid.Parse(s)
				if err != nil {
					writeErr(w, http.StatusBadRequest, "bad_request", "invalid role id: "+s)
					return
				}
				roleIDs = append(roleIDs, id)
			}
		default:
			keys := body.RoleKeys
			if len(keys) == 0 {
				keys = body.Roles
			}
			seen := map[string]bool{}
			for _, k := range keys {
				k = strings.ToLower(strings.TrimSpace(k))
				if k == "" || seen[k] {
					continue
				}
				seen[k] = true
				role, err := repo.LookupRoleByKey(r.Context(), tx, t.ID, k)
				if errors.Is(err, rbac.ErrNotFound) {
					writeErr(w, http.StatusBadRequest, "bad_role", "no role with key: "+k)
					return
				}
				if err != nil {
					writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
				roleIDs = append(roleIDs, role.ID)
				roleKeysForLog = append(roleKeysForLog, k)
			}
		}
		if len(roleIDs) == 0 {
			writeErr(w, http.StatusBadRequest, "roles_required",
				"at least one role is required — to remove a member, suspend them instead")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "members.update_roles",
			"user_id", userID, "role_ids", roleIDs)

		// Defensive last-owner check before the DB trigger fires.
		var targetHadOwner bool
		var activeOwnerCount int
		if err := tx.QueryRow(r.Context(), `
			SELECT
			  EXISTS (
			    SELECT 1 FROM tenant_member_roles tmr
			    JOIN roles r ON r.id = tmr.role_id
			    JOIN tenant_members tm ON tm.tenant_id = tmr.tenant_id AND tm.user_id = tmr.user_id
			    WHERE tmr.user_id = $1
			      AND r.is_system AND r.key = 'owner'
			      AND tm.status = 'active'
			  ) AS target_had_owner,
			  (
			    SELECT count(*) FROM tenant_member_roles tmr
			    JOIN roles r ON r.id = tmr.role_id
			    JOIN tenant_members tm ON tm.tenant_id = tmr.tenant_id AND tm.user_id = tmr.user_id
			    WHERE r.is_system AND r.key = 'owner' AND tm.status = 'active'
			  ) AS active_owner_count
		`, userID).Scan(&targetHadOwner, &activeOwnerCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Will the new grant set still include owner for this user?
		hasOwnerInPatch := false
		for _, rid := range roleIDs {
			role, err := repo.Get(r.Context(), tx, t.ID, rid)
			if err == nil && role.IsSystem && role.Key == "owner" {
				hasOwnerInPatch = true
				break
			}
		}
		if targetHadOwner && !hasOwnerInPatch && activeOwnerCount <= 1 {
			writeErr(w, http.StatusConflict, "last_owner",
				"a workspace must always have at least one owner — promote someone else first")
			return
		}

		// Verify the member row exists (a non-existent user is a 404, not a
		// "successful replace 0 rows").
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text FROM tenant_members WHERE user_id = $1`, userID,
		).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "member not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := repo.AssignMemberRoles(r.Context(), tx, t.ID, userID, roleIDs); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		auditEvent(r.Context(), "member.roles_updated", "user", userID.String(), map[string]any{
			"role_ids":  roleIDs,
			"role_keys": roleKeysForLog,
		})
		var targetEmail string
		_ = tx.QueryRow(r.Context(),
			`SELECT email::text FROM users WHERE id = $1`, userID).Scan(&targetEmail)
		target := targetEmail
		if target == "" {
			target = userID.String()
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "member", EntityID: &userID,
			Summary: fmt.Sprintf("updated roles for %s", target),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// RemoveMember — DELETE /v1/members/{userId}
// Drops the membership entirely and revokes any active sessions this user
// holds against this tenant. The user account itself stays untouched so
// audit-log/order/shift FKs to user_id stay valid.
func RemoveMember(w http.ResponseWriter, r *http.Request) {
	userID, err := uuid.Parse(chi.URLParam(r, "userId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid user id")
		return
	}
	actor, ok := appctx.UserFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "missing user")
		return
	}
	if actor.ID == userID {
		writeErr(w, http.StatusConflict, "self_remove",
			"you cannot remove yourself — transfer ownership first")
		return
	}

	tx := appctx.Tx(r.Context())

	// Last-owner protection via the junction table.
	var targetHasOwner bool
	var activeOwnerCount int
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  EXISTS (
		    SELECT 1 FROM tenant_member_roles tmr
		    JOIN roles r ON r.id = tmr.role_id
		    JOIN tenant_members tm ON tm.tenant_id = tmr.tenant_id AND tm.user_id = tmr.user_id
		    WHERE tmr.user_id = $1 AND r.is_system AND r.key = 'owner' AND tm.status = 'active'
		  ) AS target_has_owner,
		  (
		    SELECT count(*) FROM tenant_member_roles tmr
		    JOIN roles r ON r.id = tmr.role_id
		    JOIN tenant_members tm ON tm.tenant_id = tmr.tenant_id AND tm.user_id = tmr.user_id
		    WHERE r.is_system AND r.key = 'owner' AND tm.status = 'active'
		  ) AS active_owner_count
	`, userID).Scan(&targetHasOwner, &activeOwnerCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if targetHasOwner && activeOwnerCount <= 1 {
		writeErr(w, http.StatusConflict, "last_owner",
			"a workspace must always have at least one owner — promote someone else first")
		return
	}

	var targetEmail, targetName string
	_ = tx.QueryRow(r.Context(),
		`SELECT email::text, name FROM users WHERE id = $1`, userID).
		Scan(&targetEmail, &targetName)

	tenantInfo, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusInternalServerError, "internal_error", "missing tenant context")
		return
	}

	cmd, err := tx.Exec(r.Context(), `
		DELETE FROM tenant_members WHERE user_id = $1
	`, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cmd.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "member not found")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE sessions
		SET revoked_at = now()
		WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL
	`, userID, tenantInfo.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	target := targetName
	if target == "" {
		target = targetEmail
	}
	if target == "" {
		target = userID.String()
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "remove", Entity: "member", EntityID: &userID,
		Summary: fmt.Sprintf("removed %s from workspace", target),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
