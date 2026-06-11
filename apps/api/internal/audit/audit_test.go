package audit

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =============================================================================
// format.go — pure unit tests (no DB)
// =============================================================================

func TestMoney(t *testing.T) {
	cases := []struct {
		cents int64
		want  string
	}{
		{0, "Rs 0.00"},
		{1, "Rs 0.01"},
		{99, "Rs 0.99"},
		{100, "Rs 1.00"},
		{150, "Rs 1.50"},
		{100_00, "Rs 100.00"},
		{1_000_00, "Rs 1,000.00"},
		{10_000_00, "Rs 10,000.00"},
		{100_000_00, "Rs 100,000.00"},
		{1_000_000_00, "Rs 1,000,000.00"},
		{2_400_00, "Rs 2,400.00"},
		{-100, "-Rs 1.00"},
		{-2_400_00, "-Rs 2,400.00"},
		{-1_000_000_00, "-Rs 1,000,000.00"},
		// sub-rupee (paise)
		{5, "Rs 0.05"},
		{50, "Rs 0.50"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			got := Money(tc.cents)
			if got != tc.want {
				t.Errorf("Money(%d) = %q, want %q", tc.cents, got, tc.want)
			}
		})
	}
}

func TestMoney_ThousandsSeparator_SixDigit(t *testing.T) {
	// 123,456 rupees — 6 digit rupee part → "123,456"
	got := Money(123_456_00)
	if got != "Rs 123,456.00" {
		t.Errorf("got %q", got)
	}
}

func TestMoney_ThousandsSeparator_SevenDigit(t *testing.T) {
	got := Money(1_234_567_00)
	if got != "Rs 1,234,567.00" {
		t.Errorf("got %q", got)
	}
}

func TestQuote(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Coffee Beans", `"Coffee Beans"`},
		{"", `""`},
		{"a", `"a"`},
		{`has "quotes"`, `"has "quotes""`},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := Quote(tc.in)
			if got != tc.want {
				t.Errorf("Quote(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	cases := []struct {
		s    string
		n    int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 5, "hello"},
		{"hello world", 5, "hello…"},
		{"", 5, ""},
		{"abc", 0, "abc"}, // n<=0 returns s unchanged
		// multi-byte rune: "café" = 4 runes, 5 bytes
		{"café", 3, "caf…"},
		{"café", 4, "café"},
	}
	for _, tc := range cases {
		t.Run(tc.s, func(t *testing.T) {
			got := Truncate(tc.s, tc.n)
			if got != tc.want {
				t.Errorf("Truncate(%q, %d) = %q, want %q", tc.s, tc.n, got, tc.want)
			}
		})
	}
}

// =============================================================================
// DB harness helpers
// =============================================================================

func loadDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			f, ferr := os.Open(filepath.Join(dir, ".env"))
			if ferr != nil {
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
				if eq <= 0 {
					continue
				}
				key := strings.TrimSpace(line[:eq])
				val := strings.Trim(strings.TrimSpace(line[eq+1:]), `"'`)
				if _, exists := os.LookupEnv(key); !exists {
					_ = os.Setenv(key, val)
				}
			}
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return
		}
		dir = parent
	}
}

// dbPool returns a superuser pool, skipping when no URL is set.
func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	loadDotEnv()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = os.Getenv("APP_DATABASE_URL")
	}
	if url == "" {
		t.Skip("DATABASE_URL/APP_DATABASE_URL not set; skipping DB integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("cannot ping DB (%v); skipping DB integration tests", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedTenant inserts a minimal tenant row and returns its id.
func seedTenant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	suffix := uuid.NewString()[:8]
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
		"audit-test-"+suffix, "Audit Test "+suffix,
	).Scan(&id); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// seedUser inserts a minimal user row and returns its id.
func seedUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string, string) {
	t.Helper()
	var id uuid.UUID
	suffix := uuid.NewString()[:8]
	email := "audit-" + suffix + "@test.local"
	name := "Audit User " + suffix
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		email, name,
	).Scan(&id); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id, email, name
}

// =============================================================================
// audit.go — DB integration tests
// =============================================================================

func TestLog_BasicRow(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()

	tenantID := seedTenant(t, pool)
	userID, email, name := seedUser(t, pool)

	// Insert member so FK on audit_log actor_id doesn't fail if any policy checks it.
	_, _ = pool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		tenantID, userID)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID)
	})

	reqID := "req-" + uuid.NewString()[:8]
	entityID := uuid.New()

	// Build context with all appctx values.
	rctx := appctx.WithTenant(ctx, appctx.Tenant{ID: tenantID, Slug: "t", Name: "T", Timezone: "UTC"})
	rctx = appctx.WithUser(rctx, appctx.User{ID: userID, Email: email, Name: name})
	rctx = appctx.WithRoles(rctx, []string{"owner"})
	rctx = appctx.WithRequestID(rctx, reqID)
	rctx = appctx.WithIP(rctx, "127.0.0.1:54321") // host:port — should strip to "127.0.0.1"

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Set RLS GUCs so the INSERT passes the row-security check.
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`,
		tenantID.String(), userID.String()); err != nil {
		t.Fatalf("set config: %v", err)
	}

	err = Log(rctx, tx, Entry{
		Action:   "create",
		Entity:   "expense",
		EntityID: &entityID,
		Summary:  `created expense "Coffee Beans" (Rs 2,400)`,
	})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}

	// Read the row back inside the same tx.
	var (
		gotTenantID  uuid.UUID
		gotActorID   uuid.UUID
		gotActorName string
		gotEmail     string
		gotAction    string
		gotEntity    string
		gotEntityID  uuid.UUID
		gotSummary   string
		gotIP        string
		gotReqID     string
	)
	err = tx.QueryRow(ctx, `
		SELECT tenant_id, actor_id, actor_name, actor_email,
		       action, entity, entity_id, summary,
		       ip::text, request_id
		FROM audit_log
		WHERE request_id = $1
	`, reqID).Scan(
		&gotTenantID, &gotActorID, &gotActorName, &gotEmail,
		&gotAction, &gotEntity, &gotEntityID, &gotSummary,
		&gotIP, &gotReqID,
	)
	if err != nil {
		t.Fatalf("scan row: %v", err)
	}

	if gotTenantID != tenantID {
		t.Errorf("tenant_id = %s, want %s", gotTenantID, tenantID)
	}
	if gotActorID != userID {
		t.Errorf("actor_id = %s, want %s", gotActorID, userID)
	}
	if gotActorName != name {
		t.Errorf("actor_name = %q, want %q", gotActorName, name)
	}
	if gotEmail != email {
		t.Errorf("actor_email = %q, want %q", gotEmail, email)
	}
	if gotAction != "create" {
		t.Errorf("action = %q, want create", gotAction)
	}
	if gotEntity != "expense" {
		t.Errorf("entity = %q, want expense", gotEntity)
	}
	if gotEntityID != entityID {
		t.Errorf("entity_id = %s, want %s", gotEntityID, entityID)
	}
	if !strings.Contains(gotSummary, "Coffee Beans") {
		t.Errorf("summary = %q, does not contain 'Coffee Beans'", gotSummary)
	}
	// The IP stored should be the bare host, not "host:port".
	// Postgres inet::text adds /32 for IPv4 host addresses.
	if gotIP != "127.0.0.1" && gotIP != "127.0.0.1/32" {
		t.Errorf("ip = %q, want 127.0.0.1 (port stripped)", gotIP)
	}
	if gotReqID != reqID {
		t.Errorf("request_id = %q, want %q", gotReqID, reqID)
	}
}

func TestLog_NilActor(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()

	tenantID := seedTenant(t, pool)
	reqID := "req-nil-actor-" + uuid.NewString()[:8]

	// Context with tenant but NO user (nil actor path).
	// Still need roles (even empty slice) because role_snap is NOT NULL.
	rctx := appctx.WithTenant(ctx, appctx.Tenant{ID: tenantID})
	rctx = appctx.WithRoles(rctx, []string{})
	rctx = appctx.WithRequestID(rctx, reqID)
	rctx = appctx.WithIP(rctx, "10.0.0.1")

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Set tenant RLS config; user can be anything since actor_id will be NULL.
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`,
		tenantID.String(), uuid.Nil.String()); err != nil {
		t.Fatalf("set config: %v", err)
	}

	err = Log(rctx, tx, Entry{Action: "login", Entity: "session", Summary: "anonymous login"})
	if err != nil {
		t.Fatalf("Log with nil actor: %v", err)
	}

	var actorIDNull bool
	err = tx.QueryRow(ctx, `
		SELECT actor_id IS NULL FROM audit_log WHERE request_id = $1
	`, reqID).Scan(&actorIDNull)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !actorIDNull {
		t.Error("actor_id should be NULL when no user in context")
	}
}

func TestLog_BareIPNoParsing(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()

	tenantID := seedTenant(t, pool)
	userID, email, name := seedUser(t, pool)
	_, _ = pool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		tenantID, userID)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID)
	})

	reqID := "req-bareip-" + uuid.NewString()[:8]

	// Use a bare IP without port — SplitHostPort fails, but ParseIP should succeed.
	rctx := appctx.WithTenant(ctx, appctx.Tenant{ID: tenantID})
	rctx = appctx.WithUser(rctx, appctx.User{ID: userID, Email: email, Name: name})
	rctx = appctx.WithRoles(rctx, []string{})
	rctx = appctx.WithRequestID(rctx, reqID)
	rctx = appctx.WithIP(rctx, "192.168.100.200")

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`,
		tenantID.String(), userID.String()); err != nil {
		t.Fatalf("set config: %v", err)
	}

	if err := Log(rctx, tx, Entry{Action: "open", Entity: "shift", Summary: "opened shift"}); err != nil {
		t.Fatalf("Log: %v", err)
	}

	var gotIP string
	err = tx.QueryRow(ctx, `SELECT ip::text FROM audit_log WHERE request_id = $1`, reqID).Scan(&gotIP)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	// Postgres inet::text adds /32 for host addresses.
	if gotIP != "192.168.100.200" && gotIP != "192.168.100.200/32" {
		t.Errorf("ip = %q, want 192.168.100.200", gotIP)
	}
}

func TestLog_MalformedIP_StoresNull(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()

	tenantID := seedTenant(t, pool)
	userID, email, name := seedUser(t, pool)
	_, _ = pool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		tenantID, userID)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID)
	})

	reqID := "req-badip-" + uuid.NewString()[:8]

	rctx := appctx.WithTenant(ctx, appctx.Tenant{ID: tenantID})
	rctx = appctx.WithUser(rctx, appctx.User{ID: userID, Email: email, Name: name})
	rctx = appctx.WithRoles(rctx, []string{})
	rctx = appctx.WithRequestID(rctx, reqID)
	rctx = appctx.WithIP(rctx, "not-an-ip!!!") // malformed → NULL

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`,
		tenantID.String(), userID.String()); err != nil {
		t.Fatalf("set config: %v", err)
	}

	if err := Log(rctx, tx, Entry{Action: "delete", Entity: "item", Summary: "deleted item"}); err != nil {
		t.Fatalf("Log: %v", err)
	}

	var ipIsNull bool
	err = tx.QueryRow(ctx, `SELECT ip IS NULL FROM audit_log WHERE request_id = $1`, reqID).Scan(&ipIsNull)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !ipIsNull {
		t.Error("ip should be NULL for malformed address")
	}
}

func TestLog_WithRoleSnap(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()

	tenantID := seedTenant(t, pool)
	userID, email, name := seedUser(t, pool)
	_, _ = pool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		tenantID, userID)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID)
	})

	reqID := "req-roles-" + uuid.NewString()[:8]

	rctx := appctx.WithTenant(ctx, appctx.Tenant{ID: tenantID})
	rctx = appctx.WithUser(rctx, appctx.User{ID: userID, Email: email, Name: name})
	rctx = appctx.WithRoles(rctx, []string{"owner", "manager"})
	rctx = appctx.WithRequestID(rctx, reqID)
	rctx = appctx.WithIP(rctx, "127.0.0.1")

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`,
		tenantID.String(), userID.String()); err != nil {
		t.Fatalf("set config: %v", err)
	}

	if err := Log(rctx, tx, Entry{Action: "update", Entity: "member", Summary: "updated roles"}); err != nil {
		t.Fatalf("Log: %v", err)
	}

	var roleSnap []string
	err = tx.QueryRow(ctx, `SELECT role_snap FROM audit_log WHERE request_id = $1`, reqID).Scan(&roleSnap)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(roleSnap) != 2 {
		t.Fatalf("role_snap len = %d, want 2; got %v", len(roleSnap), roleSnap)
	}
}
