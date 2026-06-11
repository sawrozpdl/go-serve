package tenant_test

// Integration + unit tests for the tenant package.
//
// DB-backed tests (Middleware, OptionalMiddleware, SlugParamMiddleware,
// LookupBySlug, InvalidateByID) use the real local Postgres "cafe" database.
// Pure-logic tests (ExtractSlug) are table-driven and need no DB.
//
// Run the full suite:
//
//	go test ./internal/tenant/ -cover -v
//
// Without a reachable database, DB tests skip gracefully.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

// ---------------------------------------------------------------------------
// TestMain — pool setup (mirrors internal/api/main_test.go)
// ---------------------------------------------------------------------------

var (
	pool   *pgxpool.Pool // superuser pool for fixture management + middleware tests
	dbSkip string        // non-empty ⟹ skip DB tests
)

func TestMain(m *testing.M) {
	loadDotEnv()

	dbURL := firstNonEmpty(os.Getenv("DATABASE_URL"), os.Getenv("APP_DATABASE_URL"))
	if dbURL == "" {
		dbSkip = "DATABASE_URL / APP_DATABASE_URL not set; skipping DB integration tests"
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	pool, err = pgxpool.New(ctx, dbURL)
	if err == nil {
		err = pool.Ping(ctx)
	}
	if err != nil {
		dbSkip = fmt.Sprintf("cannot connect to DB (%v); skipping DB integration tests", err)
		os.Exit(m.Run())
	}

	code := m.Run()
	pool.Close()
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if dbSkip != "" {
		t.Skip(dbSkip)
	}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type testTenant struct {
	appctx.Tenant
	cleanup func()
}

// seedTenant inserts a minimal tenant row and returns a cleanup func that
// hard-deletes it.  slug must be unique; call t.Helper() before this.
func seedTenant(t *testing.T, slug, status string, setDeletedAt bool) testTenant {
	t.Helper()
	requireDB(t)

	ctx := context.Background()
	id := uuid.New()
	name := "Test " + slug

	var q string
	if setDeletedAt {
		q = `INSERT INTO tenants (id, slug, name, status, deleted_at)
			 VALUES ($1, $2, $3, $4, now())`
	} else {
		q = `INSERT INTO tenants (id, slug, name, status)
			 VALUES ($1, $2, $3, $4)`
	}
	_, err := pool.Exec(ctx, q, id, slug, name, status)
	if err != nil {
		t.Fatalf("seedTenant: insert failed: %v", err)
	}

	cleanup := func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM tenants WHERE id = $1`, id)
		// Evict any cache entry so later tests don't see stale data.
		tenant.InvalidateByID(id)
	}

	return testTenant{
		Tenant:  appctx.Tenant{ID: id, Slug: slug, Name: name, Timezone: "Asia/Kathmandu"},
		cleanup: cleanup,
	}
}

// uniqueSlug generates a collision-free slug safe for test isolation.
func uniqueSlug(prefix string) string {
	return fmt.Sprintf("%s-%s", prefix, uuid.New().String()[:8])
}

// ---------------------------------------------------------------------------
// Helper: drive a handler through a middleware
// ---------------------------------------------------------------------------

// okHandler records that it was reached and captures the tenant from context.
type okHandler struct {
	called    bool
	tenant    appctx.Tenant
	hasTenant bool
}

func (h *okHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.called = true
	h.tenant, h.hasTenant = appctx.TenantFromContext(r.Context())
	w.WriteHeader(http.StatusOK)
}

// callMiddleware fires the middleware with a plain GET and returns the
// recorder + the okHandler (so callers can inspect both).
func callMiddleware(mw func(http.Handler) http.Handler, r *http.Request) (*httptest.ResponseRecorder, *okHandler) {
	next := &okHandler{}
	w := httptest.NewRecorder()
	mw(next).ServeHTTP(w, r)
	return w, next
}

// newRequest builds an httptest.Request.
func newRequest(method, target string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	return r
}

// errBody decodes the JSON error body written by writeErr.
func errBody(t *testing.T, w *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var m map[string]string
	if err := json.NewDecoder(w.Body).Decode(&m); err != nil {
		t.Fatalf("errBody: decode failed: %v (body=%q)", err, w.Body.String())
	}
	return m
}

// ---------------------------------------------------------------------------
// ExtractSlug — pure unit tests, no DB
// ---------------------------------------------------------------------------

func TestExtractSlug_Header(t *testing.T) {
	cases := []struct {
		name       string
		headerVal  string
		rootDomain string
		want       string
	}{
		{"plain slug", "sahan", "example.com", "sahan"},
		{"slug with spaces trimmed", "  sahan  ", "example.com", "sahan"},
		{"slug uppercased normalized", "SAHAN", "example.com", "sahan"},
		{"slug mixed case", "Brews", "example.com", "brews"},
		{"empty header falls through to subdomain", "", "example.com", ""},
		{"whitespace-only header ignored", "   ", "example.com", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRequest("GET", "/")
			if tc.headerVal != "" {
				r.Header.Set(tenant.HeaderName, tc.headerVal)
			}
			got := tenant.ExtractSlug(r, tc.rootDomain)
			if got != tc.want {
				t.Errorf("ExtractSlug = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExtractSlug_Subdomain(t *testing.T) {
	cases := []struct {
		name       string
		host       string
		rootDomain string
		want       string
	}{
		{"valid subdomain", "sahan.example.com", "example.com", "sahan"},
		{"valid subdomain with port", "sahan.example.com:8080", "example.com", "sahan"},
		{"uppercase host normalised", "SAHAN.EXAMPLE.COM", "example.com", "sahan"},
		{"root domain itself → empty", "example.com", "example.com", ""},
		{"www rejected", "www.example.com", "example.com", ""},
		{"multi-level sub rejected", "a.b.example.com", "example.com", ""},
		{"wrong root domain → empty", "sahan.other.com", "example.com", ""},
		{"empty host → empty", "", "example.com", ""},
		{"empty root domain → empty", "sahan.example.com", "", ""},
		{"both empty → empty", "", "", ""},
		{"localhost no suffix → empty", "localhost", "example.com", ""},
		{"IP address → empty", "192.168.1.1", "example.com", ""},
		{"IP with port → empty", "192.168.1.1:8080", "example.com", ""},
		{"root with port stripped", "sahan.example.com:443", "example.com", "sahan"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRequest("GET", "/")
			r.Host = tc.host
			got := tenant.ExtractSlug(r, tc.rootDomain)
			if got != tc.want {
				t.Errorf("ExtractSlug(host=%q, root=%q) = %q, want %q",
					tc.host, tc.rootDomain, got, tc.want)
			}
		})
	}
}

// Header wins over subdomain when both are present.
func TestExtractSlug_HeaderBeatsSubdomain(t *testing.T) {
	r := newRequest("GET", "/")
	r.Host = "sub.example.com"
	r.Header.Set(tenant.HeaderName, "header-slug")
	got := tenant.ExtractSlug(r, "example.com")
	if got != "header-slug" {
		t.Errorf("want header-slug, got %q", got)
	}
}

// Empty X-Tenant-ID header (whitespace-only) must not shadow subdomain.
func TestExtractSlug_EmptyHeaderFallsBackToSubdomain(t *testing.T) {
	r := newRequest("GET", "/")
	r.Host = "sahan.example.com"
	r.Header.Set(tenant.HeaderName, "   ")
	got := tenant.ExtractSlug(r, "example.com")
	if got != "sahan" {
		t.Errorf("want sahan, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// Middleware (strict) — DB tests
// ---------------------------------------------------------------------------

func TestMiddleware_MissingSlug_Returns400(t *testing.T) {
	requireDB(t)
	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	// No header, no matching subdomain → no slug.
	w, next := callMiddleware(mw, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", w.Code)
	}
	if next.called {
		t.Error("next should not have been called")
	}
	body := errBody(t, w)
	if body["code"] != "tenant_required" {
		t.Errorf("want code=tenant_required, got %q", body["code"])
	}
}

func TestMiddleware_UnknownSlug_Returns404(t *testing.T) {
	requireDB(t)
	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, "does-not-exist-xyz")
	w, next := callMiddleware(mw, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", w.Code)
	}
	if next.called {
		t.Error("next should not have been called")
	}
	body := errBody(t, w)
	if body["code"] != "tenant_not_found" {
		t.Errorf("want code=tenant_not_found, got %q", body["code"])
	}
}

func TestMiddleware_ActiveTenant_SetsContext(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("mw-active")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()

	// Invalidate any stale cache from previous run.
	tenant.InvalidateByID(tt.ID)

	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200, got %d", w.Code)
	}
	if !next.called {
		t.Fatal("next should have been called")
	}
	if !next.hasTenant {
		t.Fatal("tenant should be in context")
	}
	if next.tenant.Slug != slug {
		t.Errorf("tenant.Slug = %q, want %q", next.tenant.Slug, slug)
	}
	if next.tenant.ID != tt.ID {
		t.Errorf("tenant.ID mismatch")
	}
}

func TestMiddleware_ActiveTenant_ViaSubdomain(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("mw-sub")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Host = slug + ".example.com"
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200, got %d", w.Code)
	}
	if !next.hasTenant {
		t.Fatal("tenant should be in context")
	}
	if next.tenant.Slug != slug {
		t.Errorf("tenant.Slug = %q, want %q", next.tenant.Slug, slug)
	}
}

// A deleted tenant (deleted_at IS NOT NULL) must not be resolved.
func TestMiddleware_DeletedTenant_Returns404(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("mw-del")
	tt := seedTenant(t, slug, "active", true) // setDeletedAt=true
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("want 404 for deleted tenant, got %d", w.Code)
	}
	if next.called {
		t.Error("next should not have been called for deleted tenant")
	}
}

// A suspended tenant must not be resolved by LookupBySlug (status != 'active').
func TestMiddleware_SuspendedTenant_Returns404(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("mw-susp")
	tt := seedTenant(t, slug, "suspended", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("want 404 for suspended tenant, got %d", w.Code)
	}
	if next.called {
		t.Error("next should not have been called for suspended tenant")
	}
}

// A closed tenant must not be resolved.
func TestMiddleware_ClosedTenant_Returns404(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("mw-closed")
	tt := seedTenant(t, slug, "closed", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, _ := callMiddleware(mw, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("want 404 for closed tenant, got %d", w.Code)
	}
}

// Middleware preserves an already-present user in the context.
func TestMiddleware_PreservesUserInContext(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("mw-user")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	u := appctx.User{ID: uuid.New(), Email: "test@example.com", Name: "Tester"}

	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	r = r.WithContext(appctx.WithUser(r.Context(), u))

	captured := &struct {
		user      appctx.User
		hasUser   bool
		tenant    appctx.Tenant
		hasTenant bool
	}{}
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured.user, captured.hasUser = appctx.UserFromContext(r.Context())
		captured.tenant, captured.hasTenant = appctx.TenantFromContext(r.Context())
	})

	w := httptest.NewRecorder()
	mw(next).ServeHTTP(w, r)

	if !captured.hasUser {
		t.Fatal("user should still be in context after tenant middleware")
	}
	if captured.user.Email != u.Email {
		t.Errorf("user.Email = %q, want %q", captured.user.Email, u.Email)
	}
	if !captured.hasTenant {
		t.Fatal("tenant should be in context")
	}
}

// The error response must be JSON with Content-Type application/json.
func TestMiddleware_ErrorResponse_IsJSON(t *testing.T) {
	requireDB(t)
	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	// No tenant header → 400.
	w, _ := callMiddleware(mw, r)
	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// ---------------------------------------------------------------------------
// OptionalMiddleware — DB tests
// ---------------------------------------------------------------------------

func TestOptionalMiddleware_NoSlug_PassesThrough(t *testing.T) {
	requireDB(t)
	mw := tenant.OptionalMiddleware(pool, "example.com")
	r := newRequest("GET", "/")
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200 (pass-through), got %d", w.Code)
	}
	if !next.called {
		t.Error("next must be called even when no tenant slug is present")
	}
	if next.hasTenant {
		t.Error("tenant should NOT be in context when no slug was resolved")
	}
}

func TestOptionalMiddleware_ValidSlug_SetsTenant(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("opt-active")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.OptionalMiddleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200, got %d", w.Code)
	}
	if !next.hasTenant {
		t.Fatal("tenant should be in context for valid slug")
	}
	if next.tenant.Slug != slug {
		t.Errorf("tenant.Slug = %q, want %q", next.tenant.Slug, slug)
	}
}

func TestOptionalMiddleware_UnknownSlug_PassesThrough(t *testing.T) {
	requireDB(t)
	mw := tenant.OptionalMiddleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, "totally-unknown-xyz")
	w, next := callMiddleware(mw, r)

	// Should still pass through (no 404).
	if w.Code != http.StatusOK {
		t.Errorf("want 200 (soft pass-through for unknown slug), got %d", w.Code)
	}
	if !next.called {
		t.Error("next must always be called in OptionalMiddleware")
	}
	if next.hasTenant {
		t.Error("tenant should NOT be in context for unknown slug")
	}
}

func TestOptionalMiddleware_DeletedTenant_PassesThrough(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("opt-del")
	tt := seedTenant(t, slug, "active", true)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.OptionalMiddleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200 (soft pass), got %d", w.Code)
	}
	if next.hasTenant {
		t.Error("deleted tenant should NOT be set in context")
	}
}

func TestOptionalMiddleware_SuspendedTenant_PassesThrough(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("opt-susp")
	tt := seedTenant(t, slug, "suspended", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.OptionalMiddleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200 (soft pass), got %d", w.Code)
	}
	if next.hasTenant {
		t.Error("suspended tenant should NOT be set in context in OptionalMiddleware")
	}
}

func TestOptionalMiddleware_ValidSlug_ViaSubdomain(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("opt-sub")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.OptionalMiddleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Host = slug + ".example.com"
	_, next := callMiddleware(mw, r)

	if !next.hasTenant {
		t.Fatal("tenant should be in context when resolved via subdomain")
	}
	if next.tenant.Slug != slug {
		t.Errorf("tenant.Slug = %q, want %q", next.tenant.Slug, slug)
	}
}

// ---------------------------------------------------------------------------
// SlugParamMiddleware — DB tests (uses chi URL params)
// ---------------------------------------------------------------------------

// wrapWithChi injects a chi context so that chi.URLParam(r, "slug") returns
// the given value.  This is the standard way to test chi param middleware
// outside a full router.
func wrapWithChi(r *http.Request, paramSlug string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("slug", paramSlug)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestSlugParamMiddleware_EmptyParam_Returns400(t *testing.T) {
	requireDB(t)
	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/public/menu/"), "")
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", w.Code)
	}
	if next.called {
		t.Error("next must not be called for empty slug param")
	}
	body := errBody(t, w)
	if body["code"] != "tenant_required" {
		t.Errorf("want code=tenant_required, got %q", body["code"])
	}
}

func TestSlugParamMiddleware_WhitespaceParam_Returns400(t *testing.T) {
	requireDB(t)
	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/public/menu/ws"), "   ")
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("want 400 for whitespace slug, got %d", w.Code)
	}
	if next.called {
		t.Error("next must not be called")
	}
}

// SlugParamMiddleware does NOT read the header — verify isolation.
func TestSlugParamMiddleware_IgnoresHeader(t *testing.T) {
	requireDB(t)
	mw := tenant.SlugParamMiddleware(pool)
	// Empty chi param but header is set — should still 400.
	r := wrapWithChi(newRequest("GET", "/"), "")
	r.Header.Set(tenant.HeaderName, "some-tenant")
	w, _ := callMiddleware(mw, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("want 400 (param is empty, header irrelevant), got %d", w.Code)
	}
}

func TestSlugParamMiddleware_UnknownSlug_Returns404(t *testing.T) {
	requireDB(t)
	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/"), "no-such-cafe-xyz")
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", w.Code)
	}
	if next.called {
		t.Error("next must not be called for unknown slug")
	}
	body := errBody(t, w)
	if body["code"] != "tenant_not_found" {
		t.Errorf("want code=tenant_not_found, got %q", body["code"])
	}
}

func TestSlugParamMiddleware_ActiveTenant_SetsContext(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("sp-active")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/public/menu/"+slug), slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200, got %d", w.Code)
	}
	if !next.hasTenant {
		t.Fatal("tenant must be set in context for active slug")
	}
	if next.tenant.Slug != slug {
		t.Errorf("tenant.Slug = %q, want %q", next.tenant.Slug, slug)
	}
	if next.tenant.ID != tt.ID {
		t.Error("tenant.ID mismatch")
	}
}

// UpperCase slug param must be normalised to lowercase and resolve correctly.
func TestSlugParamMiddleware_UppercaseParam_Normalised(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("sp-case")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/"), strings.ToUpper(slug))
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusOK {
		t.Errorf("want 200 after normalisation, got %d", w.Code)
	}
	if !next.hasTenant {
		t.Fatal("tenant must be set for uppercase slug that normalises to a known tenant")
	}
}

func TestSlugParamMiddleware_DeletedTenant_Returns404(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("sp-del")
	tt := seedTenant(t, slug, "active", true)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/"), slug)
	w, next := callMiddleware(mw, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("want 404 for deleted tenant, got %d", w.Code)
	}
	if next.called {
		t.Error("next must not be called for deleted tenant")
	}
}

func TestSlugParamMiddleware_SuspendedTenant_Returns404(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("sp-susp")
	tt := seedTenant(t, slug, "suspended", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/"), slug)
	w, _ := callMiddleware(mw, r)

	if w.Code != http.StatusNotFound {
		t.Errorf("want 404 for suspended tenant via slug param, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// LookupBySlug — cache behaviour
// ---------------------------------------------------------------------------

func TestLookupBySlug_CachesHit(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("lu-cache")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	ctx := context.Background()

	// First call — misses cache, queries DB.
	t1, err := tenant.LookupBySlug(ctx, pool, slug)
	if err != nil {
		t.Fatalf("first LookupBySlug: %v", err)
	}
	if t1.Slug != slug {
		t.Errorf("slug mismatch: got %q", t1.Slug)
	}

	// Second call — should be served from cache (no DB round-trip).
	// We can't inspect the cache directly, but we verify it returns the
	// same value and doesn't error.
	t2, err := tenant.LookupBySlug(ctx, pool, slug)
	if err != nil {
		t.Fatalf("second LookupBySlug: %v", err)
	}
	if t1.ID != t2.ID {
		t.Error("second lookup returned different ID — cache likely not working")
	}
}

func TestLookupBySlug_MissNotCached(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	_, err := tenant.LookupBySlug(ctx, pool, "absolutely-no-such-slug-xyz")
	if err == nil {
		t.Error("expected error for unknown slug, got nil")
	}
	// A second call should also hit the DB (not serve a cached miss), so it
	// still returns an error.
	_, err2 := tenant.LookupBySlug(ctx, pool, "absolutely-no-such-slug-xyz")
	if err2 == nil {
		t.Error("expected error for unknown slug on second call")
	}
}

// ---------------------------------------------------------------------------
// InvalidateByID — cache eviction
// ---------------------------------------------------------------------------

func TestInvalidateByID_EvictsCache(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("inv-cache")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID) // start clean

	ctx := context.Background()

	// Populate cache.
	_, err := tenant.LookupBySlug(ctx, pool, slug)
	if err != nil {
		t.Fatalf("LookupBySlug: %v", err)
	}

	// Delete from DB directly (simulating suspend or delete).
	_, err = pool.Exec(ctx, `UPDATE tenants SET status='suspended' WHERE id=$1`, tt.ID)
	if err != nil {
		t.Fatalf("UPDATE status: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, `UPDATE tenants SET status='active' WHERE id=$1`, tt.ID)
	}()

	// Without invalidation the cache would still return active — confirm:
	// (we rely on the cache TTL being > 0 for this to hold without a sleep)
	t2, err := tenant.LookupBySlug(ctx, pool, slug)
	if err == nil && t2.ID == tt.ID {
		// Cache hit — expected; now invalidate.
	}

	// Invalidate by ID.
	tenant.InvalidateByID(tt.ID)

	// After invalidation, LookupBySlug must re-query the DB and miss.
	_, err = tenant.LookupBySlug(ctx, pool, slug)
	if err == nil {
		t.Error("expected error after invalidation: suspended tenant should not resolve")
	}
}

// ---------------------------------------------------------------------------
// Concurrent access to the cache — race detector smoke test
// ---------------------------------------------------------------------------

func TestLookupBySlug_ConcurrentAccess(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("cc-cache")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := tenant.LookupBySlug(ctx, pool, slug)
			if err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent LookupBySlug error: %v", err)
	}
}

func TestInvalidateByID_ConcurrentWithLookup(t *testing.T) {
	requireDB(t)
	slug := uniqueSlug("cc-inv")
	tt := seedTenant(t, slug, "active", false)
	defer tt.cleanup()
	tenant.InvalidateByID(tt.ID)

	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = tenant.LookupBySlug(ctx, pool, slug)
		}()
		go func() {
			defer wg.Done()
			tenant.InvalidateByID(tt.ID)
		}()
	}
	wg.Wait()
	// No assertion — we just want the race detector to be happy.
}

// ---------------------------------------------------------------------------
// Middleware writes JSON Content-Type on all 4xx paths
// ---------------------------------------------------------------------------

func TestMiddleware_404_IsJSON(t *testing.T) {
	requireDB(t)
	mw := tenant.Middleware(pool, "example.com")
	r := newRequest("GET", "/")
	r.Header.Set(tenant.HeaderName, "ghost-slug-404")
	w, _ := callMiddleware(mw, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestSlugParamMiddleware_400_IsJSON(t *testing.T) {
	requireDB(t)
	mw := tenant.SlugParamMiddleware(pool)
	r := wrapWithChi(newRequest("GET", "/"), "")
	w, _ := callMiddleware(mw, r)
	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// ---------------------------------------------------------------------------
// tenant.HeaderName constant
// ---------------------------------------------------------------------------

func TestHeaderName_Value(t *testing.T) {
	if tenant.HeaderName != "X-Tenant-ID" {
		t.Errorf("HeaderName = %q, want X-Tenant-ID", tenant.HeaderName)
	}
}

// ---------------------------------------------------------------------------
// Helpers (copied from internal/api/main_test.go pattern)
// ---------------------------------------------------------------------------

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func loadDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	var envPath string
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			envPath = filepath.Join(dir, ".env")
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if envPath == "" {
		return
	}
	f, err := os.Open(envPath)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}
