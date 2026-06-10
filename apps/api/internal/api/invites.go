package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
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
	tx := appctx.Tx(r.Context())
	// tenant_id filter is redundant with RLS but kept explicit as defense in
	// depth, matching the other tenant-scoped list handlers.
	rows, err := tx.Query(r.Context(), `
		SELECT id, email::text, roles::text[],
		       invited_at, invited_by_user_id
		FROM tenant_invites
		WHERE tenant_id = current_tenant_id()
		  AND accepted_at IS NULL AND revoked_at IS NULL
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
	tx := appctx.Tx(r.Context())
	roles, badKey, err := validateInviteRoles(r, tx, body.Roles)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if badKey != "" {
		writeErr(w, http.StatusBadRequest, "bad_role",
			"no role with key: "+badKey)
		return
	}
	if len(roles) == 0 {
		writeErr(w, http.StatusBadRequest, "roles_required",
			"at least one role key is required")
		return
	}

	// 409 if the email already belongs to an active member of this tenant.
	var existingUserID uuid.UUID
	err = tx.QueryRow(r.Context(), `
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

	// Seat limit: active members + pending invites + this new one must not
	// exceed the tenant's effective limit (nil = unlimited). Both counts run
	// under RLS scoped to the active tenant.
	if st, ok := billing.StateFromContext(r.Context()); ok && st.EffectiveLimit != nil {
		var active, pending int
		if err := tx.QueryRow(r.Context(), `
			SELECT
				(SELECT count(*) FROM tenant_members WHERE status = 'active'),
				(SELECT count(*) FROM tenant_invites WHERE accepted_at IS NULL AND revoked_at IS NULL)
		`).Scan(&active, &pending); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if active+pending+1 > *st.EffectiveLimit {
			writeErr(w, http.StatusForbidden, "seat_limit_reached",
				fmt.Sprintf("your plan allows %d members; contact us to add more seats", *st.EffectiveLimit))
			return
		}
	}

	var inv Invite
	err = tx.QueryRow(r.Context(), `
		INSERT INTO tenant_invites (tenant_id, email, roles, invited_by_user_id)
		VALUES (current_tenant_id(), $1, $2, $3)
		RETURNING id, email::text, roles,
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
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "invite", EntityID: &inv.ID,
		Summary: fmt.Sprintf("invited %s as %s", body.Email, strings.Join(roles, ", ")),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

// RevokeInvite — DELETE /v1/invites/{id}
//
// Owner-only. Marks the row revoked (rather than deleting) so the audit
// trail stays intact. A revoked invite can be re-issued — the partial
// unique index only constrains pending rows.
func RevokeInvite(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	var email string
	if err := tx.QueryRow(r.Context(), `
		UPDATE tenant_invites
		SET revoked_at = now()
		WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
		RETURNING email::text
	`, id).Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "no pending invite with that id")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	auditEvent(r.Context(), "invite.revoked", "invite", id.String(), nil)
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "invite", EntityID: &id,
		Summary: fmt.Sprintf("revoked invite to %s", email),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validateInviteRoles cleans + verifies each role key against the
// tenant's roles table. Returns the cleaned slice plus the first unknown
// key (if any) in badKey. The caller resolves error vs 400 from there.
func validateInviteRoles(r *http.Request, tx pgx.Tx, in []string) (out []string, badKey string, err error) {
	seen := map[string]bool{}
	for _, ro := range in {
		ro = strings.ToLower(strings.TrimSpace(ro))
		if ro == "" || seen[ro] {
			continue
		}
		seen[ro] = true
		var exists bool
		if err = tx.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM roles WHERE tenant_id = current_tenant_id() AND key = $1)`,
			ro,
		).Scan(&exists); err != nil {
			return nil, "", err
		}
		if !exists {
			return nil, ro, nil
		}
		out = append(out, ro)
	}
	return out, "", nil
}
