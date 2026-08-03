package super

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// PlatformAdmin is the wire shape for a super-admin entry.
type PlatformAdmin struct {
	UserID    uuid.UUID `json:"user_id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

// ListPlatformAdmins — GET /v1/super/admins.
func ListPlatformAdmins(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT pa.user_id, u.email::text, u.name, pa.source, pa.created_at
		FROM platform_admins pa JOIN users u ON u.id = pa.user_id
		ORDER BY pa.created_at
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []PlatformAdmin{}
	for rows.Next() {
		var a PlatformAdmin
		if err := rows.Scan(&a.UserID, &a.Email, &a.Name, &a.Source, &a.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"admins": out})
}

// AddPlatformAdmin — POST /v1/super/admins  body: {email}. The user must
// already exist (i.e. have logged in at least once); we don't pre-create users.
func AddPlatformAdmin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
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
	var userID uuid.UUID
	var name string
	err := tx.QueryRow(r.Context(), `SELECT id, name FROM users WHERE email = $1`, body.Email).Scan(&userID, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "user_not_found", "that email has not signed in yet — ask them to log in once first")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	actor, _ := appctx.UserFromContext(r.Context())
	var actorID any
	if actor.ID != uuid.Nil {
		actorID = actor.ID
	}
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO platform_admins (user_id, added_by, source)
		VALUES ($1, $2, 'manual') ON CONFLICT (user_id) DO NOTHING
	`, userID, actorID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "admin.add", TargetID: body.Email, Summary: "granted super-admin to " + body.Email})
	writeJSON(w, http.StatusCreated, map[string]any{"user_id": userID, "email": body.Email, "name": name})
}

// RemovePlatformAdmin — DELETE /v1/super/admins/{userId}. Guards against
// removing the last admin and against self-removal (lockout protection).
func RemovePlatformAdmin(w http.ResponseWriter, r *http.Request) {
	userID, err := uuid.Parse(chi.URLParam(r, "userId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid user id")
		return
	}
	actor, _ := appctx.UserFromContext(r.Context())
	if userID == actor.ID {
		writeErr(w, http.StatusBadRequest, "self_removal", "you can't remove your own super-admin access")
		return
	}
	tx := appctx.Tx(r.Context())
	var count int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM platform_admins`).Scan(&count); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if count <= 1 {
		writeErr(w, http.StatusConflict, "last_admin", "can't remove the only super admin")
		return
	}
	ct, err := tx.Exec(r.Context(), `DELETE FROM platform_admins WHERE user_id = $1`, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "not a super admin")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "admin.remove", TargetID: userID.String(), Summary: "revoked super-admin"})
	w.WriteHeader(http.StatusNoContent)
}

// ListPlatformAudit — GET /v1/super/audit?limit=100&before=RFC3339.
// Keyset-paginated platform actions: pass the oldest created_at from the
// previous page as `before` to walk further back.
func ListPlatformAudit(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 200 {
				n = 200
			}
			limit = n
		}
	}
	before := time.Now().Add(time.Hour) // future sentinel = first page
	if v := r.URL.Query().Get("before"); v != "" {
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			before = t
		}
	}
	// Optional filters. `action` matches a prefix so "tenant." narrows to every
	// tenant action without listing them; `q` searches the actor and the human
	// summary, which is how you actually look for something ("who deleted X").
	var actorEmail, actionPrefix, search string
	var tenantID *uuid.UUID
	if v := strings.TrimSpace(r.URL.Query().Get("actor")); v != "" {
		actorEmail = strings.ToLower(v)
	}
	if v := strings.TrimSpace(r.URL.Query().Get("action")); v != "" {
		actionPrefix = v
	}
	if v := strings.TrimSpace(r.URL.Query().Get("q")); v != "" {
		search = v
	}
	if v := r.URL.Query().Get("tenant_id"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "tenant_id must be a uuid")
			return
		}
		tenantID = &id
	}

	rows, err := tx.Query(r.Context(), `
		SELECT pa.actor_email, pa.action, pa.target_tenant_id, t.slug, pa.target_id,
		       pa.summary, pa.created_at
		FROM platform_audit pa
		LEFT JOIN tenants t ON t.id = pa.target_tenant_id
		WHERE pa.created_at < $1
		  AND ($3::text  IS NULL OR lower(pa.actor_email) = $3)
		  AND ($4::text  IS NULL OR pa.action LIKE $4 || '%')
		  AND ($5::uuid  IS NULL OR pa.target_tenant_id = $5)
		  AND ($6::text  IS NULL OR pa.summary ILIKE '%' || $6 || '%'
		                         OR pa.actor_email ILIKE '%' || $6 || '%')
		ORDER BY pa.created_at DESC
		LIMIT $2
	`, before, limit, nilIfEmpty(actorEmail), nilIfEmpty(actionPrefix), tenantID, nilIfEmpty(search))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	type entry struct {
		ActorEmail string     `json:"actor_email"`
		Action     string     `json:"action"`
		TenantID   *uuid.UUID `json:"tenant_id,omitempty"`
		TenantSlug *string    `json:"tenant_slug,omitempty"`
		TargetID   string     `json:"target_id"`
		Summary    string     `json:"summary"`
		CreatedAt  time.Time  `json:"created_at"`
	}
	out := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.ActorEmail, &e.Action, &e.TenantID, &e.TenantSlug, &e.TargetID, &e.Summary, &e.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// The keyset cursor for the next page, and whether there IS one. A "Load
	// more" button that does nothing is worse than no button.
	var nextBefore *time.Time
	if len(out) == limit {
		nextBefore = &out[len(out)-1].CreatedAt
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"events": out, "next_before": nextBefore, "has_more": nextBefore != nil,
	})
}

// nilIfEmpty turns "" into a SQL NULL so a filter placeholder can mean
// "unfiltered" without building the query string conditionally.
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ListAuditFacets — GET /v1/super/audit/facets. The distinct actors and actions
// actually present, so the filter dropdowns offer real choices instead of a
// hardcoded list that drifts every time an action is added.
func ListAuditFacets(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	load := func(query string) ([]string, error) {
		rows, err := tx.Query(r.Context(), query)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []string{}
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				return nil, err
			}
			out = append(out, s)
		}
		return out, rows.Err()
	}
	// Most-recently-active first, capped: the dropdown is a shortcut for the
	// handful of people who actually act, not a directory. Anyone outside the
	// cap is still reachable through the free-text search, which matches the
	// actor column too.
	actors, err := load(`
		SELECT actor_email FROM platform_audit
		WHERE actor_email <> ''
		GROUP BY actor_email
		ORDER BY max(created_at) DESC
		LIMIT 50`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	actions, err := load(`SELECT DISTINCT action FROM platform_audit ORDER BY 1`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"actors": actors, "actions": actions})
}
