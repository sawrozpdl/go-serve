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
)

// SessionMiddleware reads the session cookie, looks up the row, and attaches
// the User + Session to the request context. Missing/invalid cookies are
// silently dropped — route protection is RequireAuth below.
func SessionMiddleware(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie(CookieName)
			if err != nil || c.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			sessID, userID, tenantID, expiresAt, err := LookupSession(r.Context(), pool, c.Value)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			email, name, err := LookupUserByID(r.Context(), pool, userID)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			TouchSession(r.Context(), pool, sessID, expiresAt)

			ctx := appctx.WithUser(r.Context(), appctx.User{ID: userID, Email: email, Name: name})
			sess := appctx.Session{ID: sessID, UserID: userID, ExpiresAt: expiresAt.Unix()}
			if tenantID != nil {
				sess.TenantID = *tenantID
			}
			ctx = appctx.WithSession(ctx, sess)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireAuth enforces an authenticated user. Mount AFTER SessionMiddleware.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := appctx.UserFromContext(r.Context()); !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireMember enforces that the authenticated user is an active member of
// the resolved tenant. Mount AFTER SessionMiddleware + tenant.Middleware.
//
// Every assigned role lands in the comma-separated X-Tenant-Roles header so
// downstream handlers can authorize via HasRole / HasAnyRole helpers.
func RequireMember(pool *pgxpool.Pool) func(http.Handler) http.Handler {
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
			roles, status, err := lookupMemberRoles(r.Context(), pool, t.ID, user.ID)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && status != "active") {
				writeErr(w, http.StatusForbidden, "not_a_member", "user is not an active member of this tenant")
				return
			}
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", "membership lookup failed")
				return
			}
			if len(roles) > 0 {
				r.Header.Set("X-Tenant-Roles", strings.Join(roles, ","))
			}
			// Also stash on the context so non-HTTP layers (e.g. audit
			// logging) can read roles without the *http.Request.
			r = r.WithContext(appctx.WithRoles(r.Context(), roles))
			next.ServeHTTP(w, r)
		})
	}
}

// HasRole reports whether the authenticated member holds `want` on the
// active tenant. Reads the X-Tenant-Roles header populated by RequireMember.
func HasRole(r *http.Request, want string) bool {
	for _, ro := range strings.Split(r.Header.Get("X-Tenant-Roles"), ",") {
		if ro == want {
			return true
		}
	}
	return false
}

// HasAnyRole reports whether the member holds at least one of `wants`.
func HasAnyRole(r *http.Request, wants ...string) bool {
	for _, w := range wants {
		if HasRole(r, w) {
			return true
		}
	}
	return false
}

// lookupMemberRoles runs in a short tx with both contexts set so RLS is satisfied.
func lookupMemberRoles(ctx context.Context, pool *pgxpool.Pool, tenantID, userID uuid.UUID) (roles []string, status string, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
		tenantID.String(), userID.String()); err != nil {
		return nil, "", err
	}
	row := tx.QueryRow(ctx, `
		SELECT roles::text[], status::text FROM tenant_members
		WHERE tenant_id = $1 AND user_id = $2
	`, tenantID, userID)
	err = row.Scan(&roles, &status)
	return
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
