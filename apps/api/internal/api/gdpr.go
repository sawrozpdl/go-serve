package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

// ExportMyData — GET /v1/me/export
//
// Returns the personal data we hold about the requesting user as a single
// JSON document. Covers the user row, all tenant memberships, and a
// pointer to audit-log activity by tenant. The response is sent with a
// Content-Disposition header so the browser saves it directly.
//
// The export is bounded to data tied to the user's identity. Operational
// records (orders this user opened, shifts they ran) include the user as
// "actor" but are owned by the workspace — they're enumerated as audit
// pointers, not exported in full. The user can request a fuller export
// from each workspace's owner if needed.
func ExportMyData(w http.ResponseWriter, r *http.Request) {
	user, ok := appctx.UserFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
		return
	}
	tx := appctx.Tx(r.Context())
	ctx := r.Context()

	// User row.
	type userRow struct {
		ID            uuid.UUID  `json:"id"`
		Email         string     `json:"email"`
		Name          string     `json:"name"`
		AvatarURL     *string    `json:"avatar_url"`
		GoogleSub     *string    `json:"google_sub"`
		CreatedAt     time.Time  `json:"created_at"`
		UpdatedAt     time.Time  `json:"updated_at"`
		DeletedAt     *time.Time `json:"deleted_at"`
		AnonymizedAt  *time.Time `json:"anonymized_at"`
	}
	var u userRow
	if err := tx.QueryRow(ctx, `
		SELECT id, email::text, name, avatar_url, google_sub,
		       created_at, updated_at, deleted_at, anonymized_at
		FROM users WHERE id = $1
	`, user.ID).Scan(
		&u.ID, &u.Email, &u.Name, &u.AvatarURL, &u.GoogleSub,
		&u.CreatedAt, &u.UpdatedAt, &u.DeletedAt, &u.AnonymizedAt,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Memberships. RLS on tenant_members has a user-scoped branch when no
	// tenant context is set — which is the case for this handler — so the
	// query returns rows for every tenant this user belongs to.
	type memberRow struct {
		TenantID   uuid.UUID `json:"tenant_id"`
		TenantSlug string    `json:"tenant_slug"`
		TenantName string    `json:"tenant_name"`
		Roles      []string  `json:"roles"`
		Status     string    `json:"status"`
		JoinedAt   time.Time `json:"joined_at"`
	}
	memberRows, err := tx.Query(ctx, `
		SELECT tm.tenant_id, t.slug, t.name, tm.roles::text[], tm.status::text, tm.joined_at
		FROM tenant_members tm
		JOIN tenants t ON t.id = tm.tenant_id
		WHERE tm.user_id = $1
		ORDER BY tm.joined_at
	`, user.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer memberRows.Close()
	memberships := []memberRow{}
	for memberRows.Next() {
		var m memberRow
		if err := memberRows.Scan(&m.TenantID, &m.TenantSlug, &m.TenantName, &m.Roles, &m.Status, &m.JoinedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		memberships = append(memberships, m)
	}

	// Active sessions count (no tokens, no IPs — those are server-only).
	var activeSessions int
	_ = tx.QueryRow(ctx, `
		SELECT count(*) FROM sessions
		WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
	`, user.ID).Scan(&activeSessions)

	export := map[string]any{
		"export_format":   "cafe-mgmt/v1",
		"exported_at":     time.Now().UTC(),
		"user":            u,
		"memberships":     memberships,
		"active_sessions": activeSessions,
		"notes": []string{
			"This document contains the personal data we hold about you.",
			"Operational records (orders, shifts, audit log) that reference you are owned by each workspace; ask its owner for a full export.",
			"To request deletion, send DELETE /v1/me — see the privacy docs.",
		},
	}

	filename := fmt.Sprintf("cafe-mgmt-export-%s-%s.json",
		user.ID.String()[:8],
		time.Now().UTC().Format("2006-01-02"),
	)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(export)
}

// DeleteMyAccount — DELETE /v1/me
//
// Soft-deletes the requesting user:
//
//   1. revokes all active sessions
//   2. drops every tenant_members row (so historical records remain valid
//      but the user disappears from rosters)
//   3. anonymizes email + name + google_sub + avatar with sentinel values
//   4. stamps deleted_at + anonymized_at
//
// The user account row is preserved so foreign keys from audit_log,
// orders, shifts, etc. don't break.
//
// Guard: refuse if the user is the sole active owner of any workspace.
// They must transfer ownership (or delete the workspace) before deleting
// themselves.
func DeleteMyAccount(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := appctx.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
			return
		}
		log := appctx.Logger(r.Context())
		ctx := r.Context()

		// Sole-owner guard. We use the user-scoped tenant_members branch via
		// the request tx so we see all memberships, then count active owners
		// per workspace using a join. If any workspace where the user is an
		// active owner has owner_count <= 1, reject.
		tx := appctx.Tx(ctx)
		rows, err := tx.Query(ctx, `
			WITH my_owner AS (
			  SELECT tenant_id FROM tenant_members
			  WHERE user_id = $1 AND 'owner' = ANY(roles) AND status = 'active'
			),
			counts AS (
			  SELECT tm.tenant_id, count(*) AS active_owner_count
			  FROM tenant_members tm
			  JOIN my_owner mo ON mo.tenant_id = tm.tenant_id
			  WHERE 'owner' = ANY(tm.roles) AND tm.status = 'active'
			  GROUP BY tm.tenant_id
			)
			SELECT t.slug FROM counts c
			JOIN tenants t ON t.id = c.tenant_id
			WHERE c.active_owner_count <= 1
		`, user.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		var soleOwnerSlugs []string
		for rows.Next() {
			var slug string
			if err := rows.Scan(&slug); err == nil {
				soleOwnerSlugs = append(soleOwnerSlugs, slug)
			}
		}
		rows.Close()
		if len(soleOwnerSlugs) > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{
				"code":    "sole_owner",
				"message": "you are the only active owner of one or more workspaces — transfer ownership or delete the workspace before deleting your account",
				"workspaces": soleOwnerSlugs,
			})
			return
		}

		// Drop memberships through the request tx (RLS user-scoped branch
		// accepts these deletes — verified by the policy in 0001_initial).
		if _, err := tx.Exec(ctx, `DELETE FROM tenant_members WHERE user_id = $1`, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Sessions + users are global tables (no RLS) — write outside the
		// request tx via the admin pool so the deletes survive even if a
		// later step rolls back.
		if _, err := pool.Exec(ctx, `
			UPDATE sessions
			SET revoked_at = now()
			WHERE user_id = $1 AND revoked_at IS NULL
		`, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Bump token_version so any still-valid stateless access JWT is
		// rejected at the next request (BearerMiddleware tv check) — revoking
		// sessions alone would leave access tokens live until they expire.
		if _, err := auth.BumpTokenVersion(ctx, pool, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		anonEmail := fmt.Sprintf("anonymized-%s@deleted.local", uuid.New().String())
		if _, err := pool.Exec(ctx, `
			UPDATE users SET
			  email = $2,
			  name = '[deleted user]',
			  avatar_url = NULL,
			  google_sub = NULL,
			  deleted_at = now(),
			  anonymized_at = now()
			WHERE id = $1
		`, user.ID, anonEmail); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		log.WarnContext(ctx, "gdpr.account_deleted",
			"user_id", user.ID.String(),
			"original_email", user.Email,
		)

		writeJSON(w, http.StatusOK, map[string]any{
			"deleted":         true,
			"deleted_at":      time.Now().UTC(),
			"anonymized":      true,
			"sessions_revoked": true,
			"memberships_dropped": true,
		})
	}
}
