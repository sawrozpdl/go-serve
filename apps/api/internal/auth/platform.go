package auth

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// platformAllowlist is the env-configured bootstrap set of super-admin emails
// (PLATFORM_ADMIN_EMAILS). Set once at startup via SetPlatformAllowlist. Used
// by SyncPlatformAdmin (to upsert on login) and as a live fallback in
// RequirePlatformAdmin so a freshly-added allowlist email works before its
// next login has run the upsert.
var (
	platformAllowlistMu sync.RWMutex
	platformAllowlist   []string
)

// SetPlatformAllowlist installs the env allowlist. Emails are lower-cased.
func SetPlatformAllowlist(emails []string) {
	platformAllowlistMu.Lock()
	defer platformAllowlistMu.Unlock()
	platformAllowlist = platformAllowlist[:0]
	for _, e := range emails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			platformAllowlist = append(platformAllowlist, e)
		}
	}
}

func inAllowlist(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	platformAllowlistMu.RLock()
	defer platformAllowlistMu.RUnlock()
	for _, e := range platformAllowlist {
		if e == email {
			return true
		}
	}
	return false
}

// SyncPlatformAdmin upserts the user into platform_admins when their email is
// in the env allowlist. Called from the login post-process (Google / OTP /
// dev) alongside AcceptPendingInvites. Best-effort and idempotent: a failure
// must never block login.
func SyncPlatformAdmin(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, email string) {
	if userID == uuid.Nil || !inAllowlist(email) {
		return
	}
	_, _ = pool.Exec(ctx, `
		INSERT INTO platform_admins (user_id, source)
		VALUES ($1, 'env_allowlist')
		ON CONFLICT (user_id) DO NOTHING
	`, userID)
}

// RequirePlatformAdmin gates the /super console. NOT tenant-scoped: there is
// no tenant.Middleware or RequireMember in the chain, and tenant RBAC
// permissions do not apply — super-admin authority comes solely from
// platform_admins (or the live env allowlist). Mount after RequireAuth.
func RequirePlatformAdmin(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := appctx.UserFromContext(r.Context())
			if !ok {
				writeErr(w, http.StatusUnauthorized, "unauthenticated", "session required")
				return
			}
			var isAdmin bool
			if err := pool.QueryRow(r.Context(), `SELECT is_platform_admin($1)`, user.ID).Scan(&isAdmin); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", "platform admin check failed")
				return
			}
			// Live fallback: an allowlisted email is an admin even if its login
			// upsert hasn't run yet this process.
			if !isAdmin && inAllowlist(user.Email) {
				isAdmin = true
			}
			if !isAdmin {
				writeErr(w, http.StatusForbidden, "platform_admin_required", "super-admin access required")
				return
			}
			next.ServeHTTP(w, r.WithContext(appctx.WithPlatformAdmin(r.Context(), true)))
		})
	}
}
