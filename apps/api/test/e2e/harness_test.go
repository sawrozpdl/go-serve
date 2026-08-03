// Package e2e drives the API the way a client does: over HTTP, through the real
// router, with real tokens.
//
// WHY THIS EXISTS SEPARATELY FROM internal/api
//
// The ~1250 tests in internal/api call handler functions directly with a
// hand-built context. That is fast and it covers handler logic and RLS well — but
// it means an entire layer of the server has never been exercised by a test:
//
//   - the router: is a handler actually mounted where the client expects it?
//   - authentication: bearer parsing, expiry, token version, 401 shapes
//   - membership + RBAC: does `waiter` really lack report:read in production wiring?
//   - the tenant middleware: X-Tenant-ID resolution, cross-tenant refusal
//   - billing gates: trial expiry, write locks, per-plan feature gating
//   - middleware order: compression, timeouts, security headers, rate limits
//
// Every one of those is a way the app can be broken while every unit test passes.
// A route that isn't mounted, or a permission that isn't required, is invisible
// from inside the handler.
//
// These tests boot the same NewRouter production uses against the real database,
// mint tokens through /auth/dev-login, and then behave like the SPA.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/config"
	"github.com/pewssh/cafe-mgmt/api/internal/httpx"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// Two pools, deliberately — the same split internal/api's harness uses:
//
//   - pool     (DATABASE_URL, superuser) — fixture setup and verification. It
//     BYPASSES RLS, which is what makes it useful for arranging a tenant and for
//     reading rows back without a tenant context.
//   - appPool  (APP_DATABASE_URL, app_user, NOBYPASSRLS) — what the ROUTER runs
//     on, exactly as production does.
//
// Booting the router on the superuser pool looks fine and quietly disables every
// tenant boundary: reports then aggregate the whole database, and "expected cash"
// picks up another cafe's open shift. Both were observed while writing this file.
var (
	srv     *httptest.Server
	pool    *pgxpool.Pool // superuser — fixtures only
	appPool *pgxpool.Pool // app_user, RLS active — serves requests
	dbSkip  string
)

func TestMain(m *testing.M) {
	loadDotEnv()
	adminURL := firstNonEmpty(os.Getenv("DATABASE_URL"), os.Getenv("APP_DATABASE_URL"))
	appURL := firstNonEmpty(os.Getenv("APP_DATABASE_URL"), os.Getenv("DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		dbSkip = "DATABASE_URL / APP_DATABASE_URL not set; skipping HTTP e2e"
		requireDBOrFail(dbSkip)
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var err error
	if pool, err = openPool(ctx, adminURL); err != nil {
		dbSkip = fmt.Sprintf("cannot reach DB as admin (%v); skipping HTTP e2e", err)
		requireDBOrFail(dbSkip)
		os.Exit(m.Run())
	}
	if appPool, err = openPool(ctx, appURL); err != nil {
		dbSkip = fmt.Sprintf("cannot reach DB as app_user (%v); skipping HTTP e2e", err)
		requireDBOrFail(dbSkip)
		os.Exit(m.Run())
	}

	// A dev-shaped config: dev-login mounted, rate limits high enough not to
	// throttle a test run, CORS permissive. Everything else is production wiring.
	cfg := config.Config{
		Env:                 "dev",
		CORSOrigins:         []string{"http://localhost:5891"},
		SessionSecret:       "e2e-session-secret-that-is-long-enough-to-pass-validation",
		PlatformAdminEmails: []string{platformAdminEmail},
	}
	cfg.RateLimit.GlobalPerMin = 100000
	cfg.RateLimit.AuthPerMin = 100000
	cfg.RateLimit.PublicPerMin = 100000
	cfg.Storage.Driver = "local"
	cfg.Storage.LocalRoot = os.TempDir()
	cfg.Storage.LocalPublicBase = "/uploads"

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := realtime.New(logger)
	store, err := storage.NewLocal(cfg.Storage.LocalRoot, cfg.Storage.LocalPublicBase)
	if err != nil {
		fmt.Fprintf(os.Stderr, "storage: %v\n", err)
		os.Exit(1)
	}
	// nil job runner: the e2e suite exercises the HTTP surface, and the
	// /super/jobs endpoints answer 503 rather than panicking when it's absent.
	router := httpx.NewRouter(cfg, logger, appPool, hub, store, (*mail.Mailer)(nil), nil)

	srv = httptest.NewServer(router)
	code := m.Run()
	srv.Close()
	appPool.Close()
	pool.Close()
	os.Exit(code)
}

func openPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	p, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := p.Ping(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// requireDBOrFail mirrors internal/api: CI must not silently skip these.
func requireDBOrFail(reason string) {
	if os.Getenv("REQUIRE_DB") == "" {
		return
	}
	fmt.Fprintf(os.Stderr, "REQUIRE_DB is set but the database is unusable: %s\n", reason)
	os.Exit(1)
}

func requireDB(t *testing.T) {
	t.Helper()
	if dbSkip != "" {
		t.Skip(dbSkip)
	}
}

const platformAdminEmail = "e2e-platform-admin@test.local"

// =========================================================================
// client — an authenticated caller, as the SPA is
// =========================================================================

type client struct {
	t      *testing.T
	token  string
	tenant string // X-Tenant-ID
}

type resp struct {
	t    *testing.T
	Code int
	Body []byte
}

// login authenticates through the real /auth/dev-login route and returns a
// client. No shortcuts: the token is a genuine signed access token and every
// later request goes through the same auth middleware production uses.
func login(t *testing.T, email string) *client {
	t.Helper()
	requireDB(t)
	body, _ := json.Marshal(map[string]string{"email": email, "name": email})
	res, err := http.Post(srv.URL+"/auth/dev-login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("dev-login %s: %v", email, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("dev-login %s: status %d: %s", email, res.StatusCode, raw)
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		t.Fatalf("dev-login %s: no access token in %s", email, raw)
	}
	return &client{t: t, token: out.AccessToken}
}

// forTenant returns a copy of the client scoped to a tenant, the way the SPA
// sends X-Tenant-ID after workspace selection.
//
// Despite its name, that header carries the tenant SLUG (see the resolution
// order documented in internal/tenant/middleware.go) — sending a UUID gets a
// tenant_not_found. Worth knowing before writing a client against this API.
func (c *client) forTenant(slug string) *client {
	cp := *c
	cp.tenant = slug
	return &cp
}

// anonymous drops the token, for testing what an unauthenticated caller sees.
func (c *client) anonymous() *client {
	cp := *c
	cp.token = ""
	return &cp
}

func (c *client) do(method, path string, body any) *resp {
	c.t.Helper()
	code, raw, err := c.doQuiet(method, path, body)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	return &resp{t: c.t, Code: code, Body: raw}
}

// doQuiet is do without the test-failing: it returns an error instead. Use it
// from goroutines, where calling t.Fatalf is not allowed.
func (c *client) doQuiet(method, path string, body any) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("marshal body: %w", err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, srv.URL+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.tenant != "" {
		req.Header.Set("X-Tenant-ID", c.tenant)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, raw, nil
}

func (c *client) get(path string) *resp          { return c.do(http.MethodGet, path, nil) }
func (c *client) post(path string, b any) *resp  { return c.do(http.MethodPost, path, b) }
func (c *client) patch(path string, b any) *resp { return c.do(http.MethodPatch, path, b) }
func (c *client) del(path string) *resp          { return c.do(http.MethodDelete, path, nil) }

func (r *resp) expect(code int) *resp {
	r.t.Helper()
	if r.Code != code {
		r.t.Fatalf("status %d, want %d; body: %s", r.Code, code, string(r.Body))
	}
	return r
}

// expectDenied accepts any of the refusal codes the stack uses — the point of
// these tests is that access is refused, not the exact shade of refusal.
//
// It deliberately does NOT accept 405, nor chi's plain-text "404 page not
// found": both mean the test called a route that isn't there, so a genuinely
// missing guard would read as a pass. A JSON 404 IS a refusal (the tenant
// middleware answers an unknown or unreachable cafe that way).
func (r *resp) expectDenied() *resp {
	r.t.Helper()
	switch r.Code {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusPaymentRequired,
		http.StatusConflict:
		return r
	case http.StatusNotFound:
		if bytes.HasPrefix(bytes.TrimSpace(r.Body), []byte("{")) {
			return r
		}
		r.t.Fatalf("404 from the router, not the API (%q) — this route does not exist, "+
			"so the test proves nothing about access", bytes.TrimSpace(r.Body))
	case http.StatusMethodNotAllowed:
		r.t.Fatalf("405 — wrong verb for this path; the test is calling the wrong route")
	}
	r.t.Fatalf("status %d — expected the request to be refused; body: %s", r.Code, string(r.Body))
	return r
}

func (r *resp) json() map[string]any {
	r.t.Helper()
	m := map[string]any{}
	if err := json.Unmarshal(r.Body, &m); err != nil {
		r.t.Fatalf("decode %s: %v", string(r.Body), err)
	}
	return m
}

func (r *resp) decode(dst any) *resp {
	r.t.Helper()
	if err := json.Unmarshal(r.Body, dst); err != nil {
		r.t.Fatalf("decode %s: %v", string(r.Body), err)
	}
	return r
}

// money reads a paisa figure by dot-path, reporting the path and body on a miss.
func (r *resp) money(path string) int64 {
	r.t.Helper()
	cur := any(r.json())
	for _, key := range splitDots(path) {
		obj, ok := cur.(map[string]any)
		if !ok {
			r.t.Fatalf("money(%q): not an object at %q; body: %s", path, key, string(r.Body))
		}
		v, present := obj[key]
		if !present {
			r.t.Fatalf("money(%q): no key %q; body: %s", path, key, string(r.Body))
		}
		cur = v
	}
	f, ok := cur.(float64)
	if !ok {
		r.t.Fatalf("money(%q) = %v (%T), want a number", path, cur, cur)
	}
	return int64(f)
}

func splitDots(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

func assertMoney(t *testing.T, label string, got, want int64) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %d, want %d (off by %d)", label, got, want, got-want)
	}
}

// =========================================================================
// fixture — a throwaway tenant with members at every role
// =========================================================================

type fixture struct {
	t        *testing.T
	TenantID uuid.UUID
	Slug     string
	Owner    *client
	Manager  *client
	Waiter   *client
	Kitchen  *client
	// Emails, in case a test needs to log in again.
	OwnerEmail, ManagerEmail, WaiterEmail, KitchenEmail string
}

// newFixture creates a tenant with a full set of roles and logs each member in
// through the real auth route. Torn down (CASCADE) at test end.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	requireDB(t)
	ctx := context.Background()
	suffix := uuid.NewString()[:8]
	f := &fixture{t: t, Slug: "e2e-" + suffix}

	// A paying cafe on the standard plan, not a trial: the feature gates and the
	// billing gates both read the plan, and a planless tenant is refused every
	// gated route (403 plan_upgrade_required) — which would make role tests lie.
	// paid_through_at in the future keeps ComputeState in PhaseActive.
	if err := pool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, timezone, vat_mode, vat_pct, service_charge_pct,
		                     plan_id, paid_through_at, trial_ends_at)
		VALUES ($1, $2, 'Asia/Kathmandu', 'exclusive', 13, 10,
		        (SELECT id FROM plans WHERE key = 'standard'), now() + interval '30 days', NULL)
		RETURNING id
	`, f.Slug, "E2E Cafe "+suffix).Scan(&f.TenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, f.TenantID)
	})

	// Roles come from the SAME code path tenant creation uses, so the role tests
	// assert the permissions a real cafe actually gets. Hand-written grants here
	// would make the boundary tests prove something about the harness instead.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := rbac.NewRepo(nil, rbac.NewCache(8)).SeedSystemRoles(ctx, tx, f.TenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed system roles: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit roles: %v", err)
	}

	f.OwnerEmail = "e2e-owner-" + suffix + "@test.local"
	f.ManagerEmail = "e2e-manager-" + suffix + "@test.local"
	f.WaiterEmail = "e2e-waiter-" + suffix + "@test.local"
	f.KitchenEmail = "e2e-kitchen-" + suffix + "@test.local"

	f.Owner = f.member(t, f.OwnerEmail, "owner")
	f.Manager = f.member(t, f.ManagerEmail, "manager")
	f.Waiter = f.member(t, f.WaiterEmail, "waiter")
	f.Kitchen = f.member(t, f.KitchenEmail, "kitchen")
	return f
}

// member creates a user, makes them an active member with a role, logs them in
// and scopes the client to the tenant.
func (f *fixture) member(t *testing.T, email, role string) *client {
	t.Helper()
	ctx := context.Background()
	c := login(t, email)

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&userID); err != nil {
		t.Fatalf("look up %s: %v", email, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
	`, f.TenantID, userID); err != nil {
		t.Fatalf("member %s: %v", email, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenant_member_roles (tenant_id, user_id, role_id)
		SELECT $1, $2, id FROM roles WHERE tenant_id = $1 AND key = $3
		ON CONFLICT DO NOTHING
	`, f.TenantID, userID, role); err != nil {
		t.Fatalf("grant %s to %s: %v", role, email, err)
	}
	return c.forTenant(f.Slug)
}

// =========================================================================
// Catalogue setup
//
// Menu and tables are written directly. They are the *stage* for the money
// tests, not the thing under test (the catalogue routes have their own
// coverage), and going through the API for them would bury the arithmetic
// each test is actually about.
// =========================================================================

func (f *fixture) category(name string) uuid.UUID {
	f.t.Helper()
	var id uuid.UUID
	f.scan([]any{&id}, `
		INSERT INTO menu_categories (tenant_id, name) VALUES ($1, $2) RETURNING id
	`, f.TenantID, name)
	return id
}

// item adds a menu item. cost is the direct per-item cost profitability uses;
// pass 0 for an item with no cost recorded.
func (f *fixture) item(categoryID uuid.UUID, name string, priceCents, costCents int64, allowHalf bool) uuid.UUID {
	f.t.Helper()
	var cost *int64
	if costCents > 0 {
		cost = &costCents
	}
	var id uuid.UUID
	f.scan([]any{&id}, `
		INSERT INTO menu_items (tenant_id, category_id, name, price_cents, cost_cents, allow_half)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
	`, f.TenantID, categoryID, name, priceCents, cost, allowHalf)
	return id
}

func (f *fixture) table(name string) uuid.UUID {
	f.t.Helper()
	var id uuid.UUID
	f.scan([]any{&id}, `
		INSERT INTO service_tables (tenant_id, name) VALUES ($1, $2) RETURNING id
	`, f.TenantID, name)
	return id
}

// vatMode reconfigures the cafe's tax/service settings mid-test, so one fixture
// can prove the same identities under all three VAT modes.
func (f *fixture) vatMode(mode string, vatPct, servicePct float64) {
	f.t.Helper()
	f.exec(`UPDATE tenants SET vat_mode = $2, vat_pct = $3, service_charge_pct = $4 WHERE id = $1`,
		f.TenantID, mode, vatPct, servicePct)
}

// accuracyViolations runs the live invariant checker over THIS tenant only,
// through the real /v1/super endpoint. Any test that moves money can end with
// this: it is the same check that would run against production.
func (f *fixture) accuracyViolations() []AccuracyRow {
	f.t.Helper()
	admin := login(f.t, platformAdminEmail)
	var out struct {
		Healthy    bool          `json:"healthy"`
		Violations []AccuracyRow `json:"violations"`
	}
	admin.get("/v1/super/accuracy-check?tenant_id=" + f.TenantID.String()).
		expect(http.StatusOK).decode(&out)
	return out.Violations
}

// assertClean fails with the offending rows spelled out, which is the difference
// between a useful failure and "expected 0, got 3".
func (f *fixture) assertClean() {
	f.t.Helper()
	rows := f.accuracyViolations()
	if len(rows) == 0 {
		return
	}
	msg := fmt.Sprintf("the invariant checker found %d violation(s) after this journey:", len(rows))
	for _, r := range rows {
		msg += fmt.Sprintf("\n  %s on %s %s (delta %d): %s",
			r.CheckKey, r.Entity, r.EntityID, r.DeltaCents, r.Detail)
	}
	f.t.Fatal(msg)
}

// AccuracyRow mirrors super.AccuracyViolation without importing the package.
type AccuracyRow struct {
	CheckKey   string `json:"check_key"`
	Entity     string `json:"entity"`
	EntityID   string `json:"entity_id"`
	Detail     string `json:"detail"`
	DeltaCents int64  `json:"delta_cents"`
	TenantSlug string `json:"slug"`
}

// exec runs raw SQL as the superuser, for setup a client cannot perform (making
// a tenant write-locked, back-dating a row) and for verifying committed state.
func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("exec %q: %v", sql, err)
	}
}

func (f *fixture) scan(dst []any, sql string, args ...any) {
	f.t.Helper()
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(dst...); err != nil {
		f.t.Fatalf("scan %q: %v", sql, err)
	}
}

// localDay renders an instant as the tenant-local day the API windows on.
func localDay(t *testing.T, at time.Time) string {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatalf("load tz: %v", err)
	}
	return at.In(loc).Format("2006-01-02")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// loadDotEnv reads apps/api/.env so `go test ./test/e2e` works without the
// caller exporting anything, matching internal/api's harness.
func loadDotEnv() {
	for _, path := range []string{".env", "../.env", "../../.env"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		defer f.Close()
		raw, _ := io.ReadAll(f)
		for _, line := range bytes.Split(raw, []byte("\n")) {
			s := bytes.TrimSpace(line)
			if len(s) == 0 || s[0] == '#' {
				continue
			}
			eq := bytes.IndexByte(s, '=')
			if eq < 0 {
				continue
			}
			k := string(bytes.TrimSpace(s[:eq]))
			v := string(bytes.Trim(bytes.TrimSpace(s[eq+1:]), `"'`))
			if _, ok := os.LookupEnv(k); !ok && k != "" {
				_ = os.Setenv(k, v)
			}
		}
		return
	}
}

var _ = pgx.ErrNoRows // keep the pgx import honest for helpers added later
