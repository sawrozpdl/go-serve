package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

// Invite is the wire shape for /v1/invites.
type Invite struct {
	ID        uuid.UUID  `json:"id"`
	Email     string     `json:"email"`
	Roles     []string   `json:"roles"`
	InvitedAt time.Time  `json:"invited_at"`
	InvitedBy *uuid.UUID `json:"invited_by_user_id,omitempty"`
}

// ListInvites — GET /v1/invites
//
// Returns pending invites for the active tenant. Owner-only — we don't
// want a waiter to see who's been invited but hasn't joined.
func ListInvites(w http.ResponseWriter, r *http.Request) {
	if !auth.HasRole(r, "owner") {
		writeErr(w, http.StatusForbidden, "owner_only", "only owners can manage invites")
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, email::text, roles::text[],
		       invited_at, invited_by_user_id
		FROM tenant_invites
		WHERE accepted_at IS NULL AND revoked_at IS NULL
		ORDER BY invited_at DESC
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		var inv Invite
		if err := rows.Scan(&inv.ID, &inv.Email, &inv.Roles, &inv.InvitedAt, &inv.InvitedBy); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, inv)
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": out})
}

// CreateInvite — POST /v1/invites
//
//	body: { email: string, roles: [tenant_role, ...] }
//
// Owner-only. If the email already maps to an active member, returns
// 409 already_member (owner should edit roles on the team page instead).
// If a pending invite already exists, returns 409 already_invited.
func CreateInvite(w http.ResponseWriter, r *http.Request) {
	if !auth.HasRole(r, "owner") {
		writeErr(w, http.StatusForbidden, "owner_only", "only owners can invite people")
		return
	}
	actor, _ := appctx.UserFromContext(r.Context())

	var body struct {
		Email string   `json:"email"`
		Roles []string `json:"roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	body.Email = strings.ToLower(strings.TrimSpace(body.Email))
	if body.Email == "" || !strings.Contains(body.Email, "@") {
		writeErr(w, http.StatusBadRequest, "bad_request", "valid email required")
		return
	}
	roles, ok := normalizeRoles(body.Roles)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_role",
			"roles must be a non-empty subset of owner|manager|waiter|kitchen")
		return
	}

	tx := appctx.Tx(r.Context())

	// 409 if the email already belongs to an active member of this tenant.
	var existingUserID uuid.UUID
	err := tx.QueryRow(r.Context(), `
		SELECT u.id FROM users u
		JOIN tenant_members tm ON tm.user_id = u.id
		WHERE u.email = $1
	`, body.Email).Scan(&existingUserID)
	if err == nil {
		writeErr(w, http.StatusConflict, "already_member",
			"that email already belongs to a member of this workspace")
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	var inv Invite
	err = tx.QueryRow(r.Context(), `
		INSERT INTO tenant_invites (tenant_id, email, roles, invited_by_user_id)
		VALUES (current_tenant_id(), $1, $2::tenant_role[], $3)
		RETURNING id, email::text, roles::text[],
		          invited_at, invited_by_user_id
	`, body.Email, roles, actor.ID).Scan(
		&inv.ID, &inv.Email, &inv.Roles, &inv.InvitedAt, &inv.InvitedBy,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeErr(w, http.StatusConflict, "already_invited",
				"there's already a pending invite for that email")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	auditEvent(r.Context(), "invite.created", "invite", inv.ID.String(),
		map[string]any{"email": body.Email, "roles": roles})
	writeJSON(w, http.StatusCreated, inv)
}

// RevokeInvite — DELETE /v1/invites/{id}
//
// Owner-only. Marks the row revoked (rather than deleting) so the audit
// trail stays intact. A revoked invite can be re-issued — the partial
// unique index only constrains pending rows.
func RevokeInvite(w http.ResponseWriter, r *http.Request) {
	if !auth.HasRole(r, "owner") {
		writeErr(w, http.StatusForbidden, "owner_only", "only owners can revoke invites")
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	cmd, err := tx.Exec(r.Context(), `
		UPDATE tenant_invites
		SET revoked_at = now()
		WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cmd.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no pending invite with that id")
		return
	}
	auditEvent(r.Context(), "invite.revoked", "invite", id.String(), nil)
	w.WriteHeader(http.StatusNoContent)
}

func normalizeRoles(in []string) ([]string, bool) {
	seen := map[string]bool{}
	out := []string{}
	for _, ro := range in {
		ro = strings.ToLower(strings.TrimSpace(ro))
		switch ro {
		case "owner", "manager", "waiter", "kitchen":
			if !seen[ro] {
				out = append(out, ro)
				seen[ro] = true
			}
		default:
			return nil, false
		}
	}
	return out, len(out) > 0
}
