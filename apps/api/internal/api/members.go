package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// Member is the wire shape returned by /v1/members. Surfaces both the
// legacy `role` (primary) and the new multi-role `roles` array so a UI
// can show e.g. "waiter + cook" without joining anywhere else.
type Member struct {
	UserID uuid.UUID `json:"user_id"`
	Email  string    `json:"email"`
	Name   string    `json:"name"`
	Role   string    `json:"role"`
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
		       tm.role::text,
		       COALESCE(tm.roles, ARRAY[tm.role])::text[],
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
		if err := rows.Scan(&m.UserID, &m.Email, &m.Name, &m.Role, &m.Roles, &m.Status); err != nil {
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
// The list must be non-empty and contain only known role values. The
// `role` column auto-syncs to roles[0] via the migration trigger so
// legacy reads keep working without a separate write here.
func UpdateMemberRoles(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Tenant-Role") != "owner" {
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
	w.WriteHeader(http.StatusNoContent)
}
