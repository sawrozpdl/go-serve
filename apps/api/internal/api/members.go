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
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

// Member is the wire shape returned by /v1/members. `roles` is the full
// multi-role array (one person can wear several hats on the same tenant).
type Member struct {
	UserID uuid.UUID `json:"user_id"`
	Email  string    `json:"email"`
	Name   string    `json:"name"`
	Roles  []string  `json:"roles"`
	Status string    `json:"status"`
}

// ListMembers — GET /v1/members. Any active member can read the team
// roster (it's not sensitive — they see each other on shift sheets
// already). Tenant scoping is enforced by RLS on tenant_members.
func ListMembers(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "members.list")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT u.id, u.email, u.name,
		       tm.roles::text[],
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
// Owner-only. Body: { "roles": ["waiter", "kitchen"] }
//
// The list must be non-empty and contain only known role values.
func UpdateMemberRoles(w http.ResponseWriter, r *http.Request) {
	if !auth.HasRole(r, "owner") {
		writeErr(w, http.StatusForbidden, "owner_only", "only the workspace owner can change roles")
		return
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid user id")
		return
	}
	var body struct {
		Roles []string `json:"roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	cleaned := []string{}
	seen := map[string]bool{}
	for _, ro := range body.Roles {
		ro = strings.ToLower(strings.TrimSpace(ro))
		switch ro {
		case "owner", "manager", "waiter", "kitchen":
			if !seen[ro] {
				cleaned = append(cleaned, ro)
				seen[ro] = true
			}
		default:
			writeErr(w, http.StatusBadRequest, "bad_role",
				"role must be one of owner|manager|waiter|kitchen")
			return
		}
	}
	if len(cleaned) == 0 {
		writeErr(w, http.StatusBadRequest, "roles_required",
			"at least one role is required — to remove a member, suspend them instead")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "members.update_roles",
		"user_id", userID, "roles", cleaned)

	tx := appctx.Tx(r.Context())

	// Last-owner protection. Every workspace must always have at least
	// one active member with the `owner` role. Two scenarios to block:
	//   (a) target currently has 'owner' and the new role-set drops it
	//   (b) target is the only active owner regardless of intent
	// We collapse both checks into one query: read the target's current
	// roles + the workspace owner count in a single shot, then compare.
	var targetHadOwner bool
	var activeOwnerCount int
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  EXISTS (
		    SELECT 1 FROM tenant_members
		    WHERE user_id = $1 AND 'owner' = ANY(roles) AND status = 'active'
		  ) AS target_had_owner,
		  (
		    SELECT count(*) FROM tenant_members
		    WHERE 'owner' = ANY(roles) AND status = 'active'
		  ) AS active_owner_count
	`, userID).Scan(&targetHadOwner, &activeOwnerCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	hasOwnerInPatch := false
	for _, ro := range cleaned {
		if ro == "owner" {
			hasOwnerInPatch = true
			break
		}
	}
	if targetHadOwner && !hasOwnerInPatch && activeOwnerCount <= 1 {
		writeErr(w, http.StatusConflict, "last_owner",
			"a workspace must always have at least one owner — promote someone else first")
		return
	}

	cmd, err := tx.Exec(r.Context(), `
		UPDATE tenant_members
		SET roles = $2::tenant_role[]
		WHERE user_id = $1
	`, userID, cleaned)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "member not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cmd.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "member not found")
		return
	}
	auditEvent(r.Context(), "member.roles_updated", "user", userID.String(), map[string]any{
		"roles": cleaned,
	})
	// Fetch the target's email for a friendly summary in the activity feed.
	var targetEmail string
	_ = tx.QueryRow(r.Context(),
		`SELECT email::text FROM users WHERE id = $1`, userID).Scan(&targetEmail)
	target := targetEmail
	if target == "" {
		target = userID.String()
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "member", EntityID: &userID,
		Summary: fmt.Sprintf("updated roles for %s → %s",
			target, strings.Join(cleaned, ", ")),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
