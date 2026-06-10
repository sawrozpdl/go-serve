package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// BearerMiddleware validates the "Authorization: Bearer <jwt>" access token
// statelessly (no DB hit for the signature/claims), then enforces the user's
// token_version against the in-process cache so a global logout / GDPR delete
// takes effect within the cache TTL even though access tokens are stateless.
// It populates appctx.User (from sub/email/name) and appctx.Session (from sid)
// — the same shape the cookie middleware produced, which RLS GUC setup and
// select-tenant depend on. Missing/invalid tokens are silently dropped; route
// protection is RequireAuth.
func BearerMiddleware(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := bearerToken(r)
			if raw == "" {
				next.ServeHTTP(w, r)
				return
			}
			claims, err := ParseAccessToken(raw)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			userID, err := uuid.Parse(claims.Subject)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			// Global-logout / GDPR enforcement: a stale token_version means the
			// token was minted before a revoke-everything event.
			if tv, terr := GetTokenVersion(r.Context(), pool, userID); terr == nil && tv != claims.TV {
				next.ServeHTTP(w, r)
				return
			}
			sid, _ := uuid.Parse(claims.SID)

			ctx := appctx.WithUser(r.Context(), appctx.User{ID: userID, Email: claims.Email, Name: claims.Name})
			sess := appctx.Session{ID: sid, UserID: userID}
			if claims.ExpiresAt != nil {
				sess.ExpiresAt = claims.ExpiresAt.Unix()
			}
			ctx = appctx.WithSession(ctx, sess)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireAuth enforces an authenticated user. Mount AFTER BearerMiddleware.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := appctx.UserFromContext(r.Context()); !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireMember enforces that the authenticated user is an active member
// of the resolved tenant AND loads their permission set into the context
// so HasPermission can answer without further DB round-trips.
//
// The cache lives in rbac.Repo and is keyed by (tenant_id, user_id,
// roles_version); the roles_version column on tenants is bumped by DB
// trigger on every RBAC mutation, so a stale entry is simply ignored.
func RequireMember(pool *pgxpool.Pool, repo *rbac.Repo) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := appctx.UserFromContext(r.Context())
			if !ok {
				writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
				return
			}
			t, ok := appctx.TenantFromContext(r.Context())
			if !ok {
				writeErr(w, http.StatusBadRequest, "tenant_required", "tenant context required")
				return
			}
			ps, bill, status, err := loadMemberContext(r.Context(), pool, repo, t.ID, user.ID)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && status != "active") {
				writeErr(w, http.StatusForbidden, "not_a_member", "user is not an active member of this tenant")
				return
			}
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", "membership lookup failed")
				return
			}

			ctx := appctx.WithRoles(r.Context(), ps.Roles)
			ctx = appctx.WithPermissions(ctx, ps.Set)
			ctx = billing.WithState(ctx, bill)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// HasPermission reports whether the active member has been granted `want`.
// The grant set is loaded once per request by RequireMember; this is a
// pure in-memory check.
func HasPermission(r *http.Request, want string) bool {
	set, ok := appctx.Permissions(r.Context())
	if !ok {
		return false
	}
	return rbac.PermissionSet{Set: set}.Has(want)
}

// Require is the per-route permission gate. Mount via chi's `With(...)`:
//
//	r.With(auth.Require("menu:create")).Post("/menu/items", api.CreateMenuItem)
//
// Reads the permission set populated by RequireMember. Returns 403 if the
// caller lacks the grant.
func Require(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !HasPermission(r, perm) {
				writeErr(w, http.StatusForbidden, "forbidden", "missing "+perm+" permission")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireAny is the per-route gate for endpoints that accept any of
// several permissions. Returns 403 if none are held.
func RequireAny(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !HasAnyPermission(r, perms...) {
				writeErr(w, http.StatusForbidden, "forbidden", "missing one of permissions: "+strings.Join(perms, ", "))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// HasAnyPermission reports whether the active member has been granted at
// least one of `wants`.
func HasAnyPermission(r *http.Request, wants ...string) bool {
	set, ok := appctx.Permissions(r.Context())
	if !ok {
		return false
	}
	ps := rbac.PermissionSet{Set: set}
	for _, w := range wants {
		if ps.Has(w) {
			return true
		}
	}
	return false
}

// loadMemberContext opens a short tx, sets RLS GUCs, loads the member's
// status, and (if active) loads their permission set via the rbac repo plus
// the tenant's billing state. The grant set is cached by repo internally;
// billing state is loaded fresh every request (it must never be served from
// the 60s tenant cache).
func loadMemberContext(ctx context.Context, pool *pgxpool.Pool, repo *rbac.Repo, tenantID, userID uuid.UUID) (rbac.PermissionSet, billing.State, string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return rbac.PermissionSet{}, billing.State{}, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err = tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
		tenantID.String(), userID.String(),
	); err != nil {
		return rbac.PermissionSet{}, billing.State{}, "", err
	}
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status::text FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
		tenantID, userID,
	).Scan(&status); err != nil {
		return rbac.PermissionSet{}, billing.State{}, "", err
	}
	if status != "active" {
		return rbac.PermissionSet{}, billing.State{}, status, nil
	}
	ps, err := repo.LoadForMember(ctx, tx, tenantID, userID)
	if err != nil {
		return rbac.PermissionSet{}, billing.State{}, status, err
	}
	bill, err := billing.LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		return rbac.PermissionSet{}, billing.State{}, status, err
	}
	return ps, bill, status, nil
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
