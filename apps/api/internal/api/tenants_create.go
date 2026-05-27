package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// POST /v1/tenants
//
// Authenticated user creates a brand-new workspace and is added as its
// owner in a single transaction. Used by the post-login onboarding flow
// when the user has zero memberships.
//
//	body: { name: string, slug?: string, timezone?: string }
//
// Slug is derived from name when omitted. Returns the new tenant.
//
// The tx seeds the 4 system roles + permissions for the new tenant from
// the manifest, then grants the creator the owner role.
func CreateTenant(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := appctx.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
			return
		}

		var body struct {
			Name     string `json:"name"`
			Slug     string `json:"slug"`
			Timezone string `json:"timezone"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		body.Name = strings.TrimSpace(body.Name)
		if body.Name == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "name required")
			return
		}
		slug := strings.TrimSpace(strings.ToLower(body.Slug))
		if slug == "" {
			slug = slugify(body.Name)
		}
		if !slugRe.MatchString(slug) {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"slug must be lowercase alphanumeric or dashes, 2–63 chars")
			return
		}
		tz := strings.TrimSpace(body.Timezone)
		if tz == "" {
			tz = "Asia/Kathmandu"
		}

		tx := appctx.Tx(r.Context())

		var tenantID uuid.UUID
		err := tx.QueryRow(r.Context(), `
			INSERT INTO tenants (slug, name, timezone)
			VALUES ($1, $2, $3)
			RETURNING id
		`, slug, body.Name, tz).Scan(&tenantID)
		if err != nil {
			var pgErr *pgconn.PgError
			if asPg(err, &pgErr) && pgErr.Code == "23505" {
				writeErr(w, http.StatusConflict, "slug_taken", "that slug is already taken")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// tenant_members, roles, role_permissions, and tenant_member_roles
		// all FORCE RLS; INSERT requires app.tenant_id to match the row
		// we're writing. Override the request-scoped GUC for the rest of
		// this tx (the request started with no tenant context).
		if _, err := tx.Exec(r.Context(),
			"SELECT set_config('app.tenant_id', $1, true)", tenantID.String()); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Seed the 4 system roles + their grants from the manifest.
		roleIDs, err := repo.SeedSystemRoles(r.Context(), tx, tenantID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		ownerRoleID, ok := roleIDs["owner"]
		if !ok {
			writeErr(w, http.StatusInternalServerError, "internal_error", "owner role missing after seed")
			return
		}

		// Insert membership + grant the creator the owner role.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO tenant_members (tenant_id, user_id, status)
			VALUES ($1, $2, 'active')
		`, tenantID, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO tenant_member_roles (tenant_id, user_id, role_id)
			VALUES ($1, $2, $3)
		`, tenantID, user.ID, ownerRoleID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		log := appctx.Logger(r.Context())
		log.InfoContext(r.Context(), "tenant.created", "tenant_id", tenantID, "slug", slug, "owner", user.Email)

		// Write a tenant-scoped audit row by hand: this handler runs without a
		// tenant on appctx (it's the onboarding entry point), and audit.Log
		// would have nothing to attach the row to.
		reqID, _ := appctx.RequestID(r.Context())
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO audit_log (
				tenant_id, actor_id, actor_name, actor_email, role_snap,
				action, entity, entity_id, summary, request_id
			) VALUES ($1, $2, $3, $4, ARRAY['owner']::text[], 'create', 'tenant', $1, $5, $6)
		`,
			tenantID, user.ID, user.Name, user.Email,
			"created workspace "+slug, reqID,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"id":       tenantID,
			"slug":     slug,
			"name":     body.Name,
			"timezone": tz,
			"roles":    []string{"owner"},
		})
	}
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)

var nonSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = nonSlugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 63 {
		s = s[:63]
	}
	return s
}

// asPg is a small wrapper so we can errors.As without importing errors at
// every call site.
func asPg(err error, target **pgconn.PgError) bool {
	for e := err; e != nil; {
		if pe, ok := e.(*pgconn.PgError); ok {
			*target = pe
			return true
		}
		type unwrap interface{ Unwrap() error }
		u, ok := e.(unwrap)
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}
