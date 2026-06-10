// Package tenant resolves the active tenant for a request.
//
// Resolution precedence (first hit wins):
//  1. The `X-Tenant-ID` header carries a tenant slug.
//  2. The leading subdomain of the Host header is a tenant slug
//     (only when the host has at least two labels and the trailing
//     suffix matches the configured root domain).
package tenant

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

const HeaderName = "X-Tenant-ID"

// slug→tenant cache. The slug→(id,name,tz) mapping is effectively static for
// the life of a workspace, but this lookup runs on EVERY request before the
// request transaction is even begun — so without a cache it's a dedicated pool
// acquisition per request, multiplying connection pressure. A short TTL bounds
// staleness (e.g. a rename/deactivation propagates within the TTL).
var (
	tenantCacheMu  sync.RWMutex
	tenantCache    = map[string]cachedTenant{}
	tenantCacheTTL = 60 * time.Second
)

type cachedTenant struct {
	t   appctx.Tenant
	exp time.Time
}

// Middleware resolves the tenant from header/subdomain and attaches it to
// the request context. Returns 400 if no tenant could be resolved, 404 if
// the slug doesn't match any tenant.
func Middleware(pool *pgxpool.Pool, rootDomain string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			slug := ExtractSlug(r, rootDomain)
			if slug == "" {
				writeErr(w, http.StatusBadRequest, "tenant_required",
					"tenant must be provided via subdomain or X-Tenant-ID header")
				return
			}

			t, err := LookupBySlug(r.Context(), pool, slug)
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "tenant_not_found",
					"no tenant with slug "+slug)
				return
			}
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", "tenant lookup failed")
				return
			}

			next.ServeHTTP(w, r.WithContext(appctx.WithTenant(r.Context(), t)))
		})
	}
}

// OptionalMiddleware is like Middleware but does not 400 on miss — used on
// auth routes where the tenant may not be known yet.
func OptionalMiddleware(pool *pgxpool.Pool, rootDomain string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			slug := ExtractSlug(r, rootDomain)
			if slug == "" {
				next.ServeHTTP(w, r)
				return
			}
			if t, err := LookupBySlug(r.Context(), pool, slug); err == nil {
				r = r.WithContext(appctx.WithTenant(r.Context(), t))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SlugParamMiddleware resolves the tenant from the chi `{slug}` URL param.
// It is for PUBLIC, unauthenticated routes (e.g. the customer QR menu): the
// slug is explicit in the path so a printed link is self-contained — it does
// NOT read the X-Tenant-ID header or the host subdomain. 400 if the param is
// empty, 404 if no active tenant matches. RLS still scopes every downstream
// query once db.TxMiddleware sets app.tenant_id from the resolved tenant.
func SlugParamMiddleware(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "slug")))
			if slug == "" {
				writeErr(w, http.StatusBadRequest, "tenant_required", "menu slug required")
				return
			}
			t, err := LookupBySlug(r.Context(), pool, slug)
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "tenant_not_found", "no menu for "+slug)
				return
			}
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", "tenant lookup failed")
				return
			}
			next.ServeHTTP(w, r.WithContext(appctx.WithTenant(r.Context(), t)))
		})
	}
}

// ExtractSlug returns the tenant slug from the X-Tenant-ID header or the
// host's leading subdomain. Returns "" if neither yields a candidate.
func ExtractSlug(r *http.Request, rootDomain string) string {
	if v := strings.TrimSpace(r.Header.Get(HeaderName)); v != "" {
		return strings.ToLower(v)
	}
	host := r.Host
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	if rootDomain == "" || host == "" {
		return ""
	}
	host = strings.ToLower(host)
	root := strings.ToLower(rootDomain)
	if !strings.HasSuffix(host, "."+root) {
		return ""
	}
	prefix := strings.TrimSuffix(host, "."+root)
	if prefix == "" || strings.Contains(prefix, ".") || prefix == "www" {
		return ""
	}
	return prefix
}

// LookupBySlug runs OUTSIDE any tenant-scoped transaction (uses the pool
// directly) since we don't yet know which tenant we're in. Successful lookups
// are cached for tenantCacheTTL to avoid a pool acquisition on every request;
// misses (unknown/inactive slug) are not cached.
func LookupBySlug(ctx context.Context, pool *pgxpool.Pool, slug string) (appctx.Tenant, error) {
	tenantCacheMu.RLock()
	c, ok := tenantCache[slug]
	tenantCacheMu.RUnlock()
	if ok && time.Now().Before(c.exp) {
		return c.t, nil
	}

	var t appctx.Tenant
	row := pool.QueryRow(ctx, `
		SELECT id, slug, name, timezone
		FROM tenants
		WHERE slug = $1 AND deleted_at IS NULL AND status = 'active'
	`, slug)
	if err := row.Scan(&t.ID, &t.Slug, &t.Name, &t.Timezone); err != nil {
		return appctx.Tenant{}, err
	}

	tenantCacheMu.Lock()
	tenantCache[slug] = cachedTenant{t: t, exp: time.Now().Add(tenantCacheTTL)}
	tenantCacheMu.Unlock()
	return t, nil
}

// InvalidateByID drops any cached entry for the tenant so a status flip
// (suspend/reactivate) takes effect on the next request instead of after the
// cache TTL. Per-process only — other instances converge within the TTL.
func InvalidateByID(id uuid.UUID) {
	tenantCacheMu.Lock()
	for slug, c := range tenantCache {
		if c.t.ID == id {
			delete(tenantCache, slug)
		}
	}
	tenantCacheMu.Unlock()
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
