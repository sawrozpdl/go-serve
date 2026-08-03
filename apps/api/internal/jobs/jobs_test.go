package jobs

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests for the nightly work. The interesting properties are all
// about NOT doing something twice — the snapshot must be idempotent, the digest
// must not double-send, and two instances must not both run — so most of what's
// asserted here is second-run behaviour.

var (
	pool   *pgxpool.Pool
	dbSkip string
)

func TestMain(m *testing.M) {
	loadDotEnv()
	url := firstNonEmpty(os.Getenv("DATABASE_URL"), os.Getenv("APP_DATABASE_URL"))
	if url == "" {
		dbSkip = "DATABASE_URL not set; skipping job integration tests"
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	pool, err = pgxpool.New(ctx, url)
	if err == nil {
		err = pool.Ping(ctx)
	}
	if err != nil {
		dbSkip = fmt.Sprintf("cannot connect to DB (%v); skipping", err)
		os.Exit(m.Run())
	}
	code := m.Run()
	pool.Close()
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if dbSkip == "" {
		return
	}
	if os.Getenv("REQUIRE_DB") != "" {
		t.Fatalf("REQUIRE_DB is set but the database is unavailable: %s", dbSkip)
	}
	t.Skip(dbSkip)
}

// newRunner builds a Runner with no mailer, so SendDigest renders and logs but
// never actually posts to SMTP.
func newRunner(t *testing.T) *Runner {
	t.Helper()
	requireDB(t)
	return New(pool, nil, Config{Enabled: true, Hour: 8, Location: time.UTC}, discardLogger())
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// seedTenant creates a throwaway tenant and returns its id.
func seedTenant(t *testing.T, name string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var planID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM plans WHERE key = 'trial'`).Scan(&planID); err != nil {
		t.Fatalf("resolve trial plan: %v", err)
	}
	var id uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO tenants (slug, name, plan_id, created_at) VALUES ($1, $2, $3, now() - interval '90 days') RETURNING id`,
		"job-"+uuid.NewString()[:8], name, planID).Scan(&id); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// --- snapshot ------------------------------------------------------------

// Re-running for the same day must overwrite, not duplicate or error. This is
// what makes a retry after a failed run safe.
func TestSnapshotDay_IsIdempotent(t *testing.T) {
	r := newRunner(t)
	tenantID := seedTenant(t, "Snapshot Cafe")
	day := time.Now().AddDate(0, 0, -1)
	ctx := context.Background()

	if _, err := r.SnapshotDay(ctx, day); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if _, err := r.SnapshotDay(ctx, day); err != nil {
		t.Fatalf("second run: %v", err)
	}

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*)::int FROM tenant_health_daily WHERE tenant_id = $1 AND day = $2::date`,
		tenantID, day.Format("2006-01-02")).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Errorf("got %d snapshot rows for one tenant-day, want exactly 1", rows)
	}
}

func TestSnapshotDay_RecordsStatusAndSignals(t *testing.T) {
	r := newRunner(t)
	tenantID := seedTenant(t, "Graded Cafe")
	day := time.Now().AddDate(0, 0, -1)

	if _, err := r.SnapshotDay(context.Background(), day); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	var status string
	var signals []byte
	if err := pool.QueryRow(context.Background(),
		`SELECT status, signals FROM tenant_health_daily WHERE tenant_id = $1 AND day = $2::date`,
		tenantID, day.Format("2006-01-02")).Scan(&status, &signals); err != nil {
		t.Fatalf("read back: %v", err)
	}
	// A 90-day-old café with no orders at all has genuinely stopped.
	if status != "dormant" {
		t.Errorf("status = %q, want dormant for a café with no trade", status)
	}
	// The signals blob is what lets the digest explain a change without
	// recomputing history.
	if len(signals) == 0 || string(signals) == "null" {
		t.Error("signals should be recorded alongside the status")
	}
}

func TestSnapshotDay_CountsThatDayOnly(t *testing.T) {
	r := newRunner(t)
	tenantID := seedTenant(t, "Counted Cafe")
	ctx := context.Background()

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM users LIMIT 1`).Scan(&userID); err != nil {
		t.Skip("no users in the database")
	}
	// Two orders yesterday, one the day before.
	for _, offset := range []string{"1 day", "1 day", "2 days"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO orders (tenant_id, status, opened_by_user_id, opened_at, closed_at,
			                    subtotal_cents, tax_cents, total_cents)
			VALUES ($1, 'closed', $2, now() - $3::interval, now() - $3::interval, 1000, 100, 1100)
		`, tenantID, userID, offset); err != nil {
			t.Fatalf("seed order: %v", err)
		}
	}

	yesterday := time.Now().AddDate(0, 0, -1)
	if _, err := r.SnapshotDay(ctx, yesterday); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	var orders int
	var gross int64
	if err := pool.QueryRow(ctx,
		`SELECT orders, gross_cents FROM tenant_health_daily WHERE tenant_id = $1 AND day = $2::date`,
		tenantID, yesterday.Format("2006-01-02")).Scan(&orders, &gross); err != nil {
		t.Fatal(err)
	}
	if orders != 2 {
		t.Errorf("orders = %d, want 2 — the day-before order must not be counted", orders)
	}
	// Net of tax, matching the revenue basis used everywhere else.
	if gross != 2*(1100-100) {
		t.Errorf("gross_cents = %d, want %d (net of tax)", gross, 2*(1100-100))
	}
}

// --- digest --------------------------------------------------------------

// The marker in platform_audit is what stops a restart or a second instance
// re-sending the same morning's email.
func TestSendDigest_DoesNotSendTwiceInADay(t *testing.T) {
	r := newRunner(t)
	ctx := context.Background()
	today := time.Now().In(r.cfg.Location).Format("2006-01-02")

	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_audit (actor_email, action, target_id, summary)
		VALUES ('test', 'platform.digest_sent', $1, 'seeded by a test')
	`, today); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM platform_audit WHERE action = 'platform.digest_sent' AND target_id = $1 AND actor_email = 'test'`, today)
	})

	sent, err := r.SendDigest(ctx, false)
	if err != nil {
		t.Fatalf("SendDigest: %v", err)
	}
	if sent {
		t.Error("a second digest went out on a day one had already been sent")
	}
}

// force is the "I fixed the problem, send it again" escape hatch.
func TestSendDigest_ForceBypassesTheMarker(t *testing.T) {
	r := newRunner(t)
	ctx := context.Background()
	today := time.Now().In(r.cfg.Location).Format("2006-01-02")

	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_audit (actor_email, action, target_id, summary)
		VALUES ('test', 'platform.digest_sent', $1, 'seeded by a test')
	`, today); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM platform_audit WHERE action = 'platform.digest_sent' AND target_id = $1 AND actor_email = 'test'`, today)
	})

	// With no mailer configured this returns false after rendering, so what's
	// actually asserted is that it got PAST the marker check without erroring.
	if _, err := r.SendDigest(ctx, true); err != nil {
		t.Fatalf("forced send: %v", err)
	}
}

// --- rendering (pure) ----------------------------------------------------

func TestDigest_EmptyWhenNothingHappened(t *testing.T) {
	if !(Digest{}).Empty() {
		t.Error("a digest with no sections should report itself empty")
	}
	d := Digest{NewSignups: []DigestCafe{{Name: "Somewhere"}}}
	if d.Empty() {
		t.Error("a digest with a signup is not empty")
	}
}

func TestRenderDigest_NamesCafesAndManagers(t *testing.T) {
	d := Digest{
		Day: time.Date(2026, 8, 3, 8, 0, 0, 0, time.UTC),
		WentQuiet: []DigestChange{{
			DigestCafe: DigestCafe{
				TenantID: uuid.New(), Name: "Sahan Cafe", Manager: "Bikash", Detail: "healthy → at_risk",
			},
			From: "healthy", To: "at_risk",
		}},
		TrialsEnding:       []DigestCafe{{Name: "New Place", Detail: "trial ends Friday 07 Aug"}},
		CashCollectedCents: 250000,
	}

	text := renderDigestText(d)
	for _, want := range []string{"Sahan Cafe", "healthy → at_risk", "Bikash", "New Place", "Went quiet"} {
		if !strings.Contains(text, want) {
			t.Errorf("text digest is missing %q\n---\n%s", want, text)
		}
	}

	htmlOut := renderDigestHTML(d, "https://console.example")
	if !strings.Contains(htmlOut, "https://console.example/super/tenants/") {
		t.Error("html digest should deep-link each café into the console")
	}
	// An unassigned café must be visibly unassigned, not blank.
	if !strings.Contains(htmlOut, "unassigned") {
		t.Error("html digest should mark cafés with no relationship manager")
	}
}

// A café name is user-supplied and lands in an HTML email.
func TestRenderDigestHTML_EscapesCafeNames(t *testing.T) {
	d := Digest{
		Day:        time.Now(),
		NewSignups: []DigestCafe{{Name: `<script>alert(1)</script>`, Manager: `"quoted"`}},
	}
	out := renderDigestHTML(d, "")
	if strings.Contains(out, "<script>") {
		t.Errorf("café name was not escaped:\n%s", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Errorf("expected the name to be HTML-escaped:\n%s", out)
	}
}

func TestRenderDigestHTML_NoConsoleURLDegradesToPlainNames(t *testing.T) {
	d := Digest{Day: time.Now(), NewSignups: []DigestCafe{{Name: "Plain Cafe"}}}
	out := renderDigestHTML(d, "")
	if strings.Contains(out, "<a href") {
		t.Error("with no console URL configured there should be no links")
	}
	if !strings.Contains(out, "Plain Cafe") {
		t.Error("the café should still be named")
	}
}

// --- env helpers ---------------------------------------------------------

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// loadDotEnv mirrors the other packages' test harnesses: fill missing env from
// the api-root .env without overriding what's already set.
func loadDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	var envPath string
	for range 6 {
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
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if key == "" {
			continue
		}
		if _, set := os.LookupEnv(key); !set {
			_ = os.Setenv(key, val)
		}
	}
}

// A section with hundreds of cafés must not produce an unreadable email — but
// the overflow has to be STATED, not silently dropped. A truncated list that
// looks complete is worse than a long one.
func TestRenderDigest_CapsSectionsAndSaysSo(t *testing.T) {
	many := make([]DigestCafe, maxPerSection+16)
	for i := range many {
		many[i] = DigestCafe{Name: fmt.Sprintf("Cafe %d", i)}
	}
	d := Digest{Day: time.Now(), TrialsEnding: many}

	text := renderDigestText(d)
	if strings.Count(text, "  · Cafe ") != maxPerSection {
		t.Errorf("text listed %d cafés, want %d", strings.Count(text, "  · Cafe "), maxPerSection)
	}
	// The header still reports the TRUE total, so the count isn't a lie.
	if !strings.Contains(text, fmt.Sprintf("(%d)", len(many))) {
		t.Error("the section header should report the full count, not the capped one")
	}
	if !strings.Contains(text, "and 16 more") {
		t.Errorf("the overflow must be stated:\n%s", text)
	}

	htmlOut := renderDigestHTML(d, "")
	if !strings.Contains(htmlOut, "and 16 more") {
		t.Error("html digest should state its overflow too")
	}
}

// A café purged while the nightly run is in flight must cost only its own row.
// Before this was guarded, the foreign-key violation aborted the whole snapshot,
// so one badly-timed delete silently robbed every other café of that night's
// data — and the next morning's digest would have nothing to diff against.
func TestSnapshotDay_SurvivesATenantVanishingMidRun(t *testing.T) {
	r := newRunner(t)
	ctx := context.Background()
	survivor := seedTenant(t, "Survivor Cafe")

	// A tenant that exists when the list is read and is gone by insert time.
	// Deleting it up front reproduces the same window deterministically: the
	// grade map still carries it, so the insert is still attempted.
	doomed := seedTenant(t, "Doomed Cafe")
	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1`, doomed); err != nil {
		t.Fatal(err)
	}

	day := time.Now().AddDate(0, 0, -1)
	if _, err := r.SnapshotDay(ctx, day); err != nil {
		t.Fatalf("a vanished tenant must not fail the run: %v", err)
	}

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*)::int FROM tenant_health_daily WHERE tenant_id = $1 AND day = $2::date`,
		survivor, day.Format("2006-01-02")).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Errorf("the surviving café got %d snapshot rows, want 1", rows)
	}
}
