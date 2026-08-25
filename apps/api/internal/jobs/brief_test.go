package jobs

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The brief job is tested against the APP pool, not the superuser pool the rest
// of this package uses.
//
// That is not fussiness. The job's correctness is almost entirely about RLS:
// every café's work happens inside a transaction with app.tenant_id set, and the
// one cross-tenant query leans on insight_briefs' platform-admin policy. A
// superuser bypasses RLS completely, so a test on `pool` would pass even if
// withTenant did nothing at all — and in fact the first version of
// briefRecipients ran with no tenant context and silently found nobody for any
// café. A superuser-pool test would have called that green.

var briefAppPool *pgxpool.Pool

func appPoolOrSkip(t *testing.T) *pgxpool.Pool {
	t.Helper()
	requireDB(t)
	if briefAppPool != nil {
		return briefAppPool
	}
	url := os.Getenv("APP_DATABASE_URL")
	if url == "" {
		t.Skip("APP_DATABASE_URL not set; the brief job must be tested as the app role")
	}
	p, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	briefAppPool = p
	return p
}

// briefRunner builds a Runner on the app pool with no mailer, so emails render
// and log rather than being sent.
func briefRunner(t *testing.T) *Runner {
	t.Helper()
	ensurePlatformAdmin(t)
	return New(appPoolOrSkip(t), nil, Config{
		Enabled: true, Hour: 8, Location: time.UTC,
		BriefHour: 7, AppURL: "https://app.test",
		// The dev database carries thousands of junk tenants that sort ahead of a
		// freshly seeded one, so the default batch would never reach it.
		MaxBriefsPerRun: 100000,
	}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})))
}

// activeCafe seeds a tenant that dueCafes will consider, in a known timezone.
func activeCafe(t *testing.T, tz string) (uuid.UUID, dueCafe) {
	t.Helper()
	id := seedTenant(t, "Brief Cafe")
	if _, err := pool.Exec(context.Background(),
		`UPDATE tenants SET status = 'active', timezone = $2 WHERE id = $1`, id, tz); err != nil {
		t.Fatalf("set tz: %v", err)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatalf("tz: %v", err)
	}
	local := time.Now().In(loc)
	return id, dueCafe{
		TenantID: id, Name: "Brief Cafe", Slug: "brief-cafe", TZ: tz,
		LocalDay: time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC),
	}
}

// The marker is reserved BEFORE the work, so a second pass does nothing. This is
// what makes a mid-run crash cost one brief instead of duplicating an email —
// and the API runs as one ECS task with minimumHealthyPercent 0, so any push to
// main kills this job mid-run.
func TestBrief_SecondPassIsSkipped(t *testing.T) {
	r := briefRunner(t)
	_, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()
	now := time.Now()

	if err := r.briefFor(ctx, c, now); err != nil {
		t.Fatalf("first pass: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM insight_briefs WHERE tenant_id = $1`, c.TenantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("%d brief rows after one pass, want 1", n)
	}

	// Second pass: must not add a row, must not error.
	if err := r.briefFor(ctx, c, now); err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM insight_briefs WHERE tenant_id = $1`, c.TenantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("%d brief rows after two passes, want 1 — the marker is not holding", n)
	}
}

// A café that has not traded gets a marker but no email. Some detectors are
// timeless (a credit balance is stale whether or not the shop opened), so a
// dormant café would otherwise be emailed the same old debts every morning.
func TestBrief_DormantCafeIsMarkedButNotEmailed(t *testing.T) {
	r := briefRunner(t)
	_, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	if err := r.briefFor(ctx, c, time.Now()); err != nil {
		t.Fatalf("briefFor: %v", err)
	}

	var emailedAt *time.Time
	var findings int
	if err := pool.QueryRow(ctx, `
		SELECT emailed_at, finding_count FROM insight_briefs WHERE tenant_id = $1`,
		c.TenantID).Scan(&emailedAt, &findings); err != nil {
		t.Fatal(err)
	}
	if emailedAt != nil {
		t.Error("a café with no trade must not be emailed a morning brief")
	}
	// The marker still exists, so the job does not retry it all morning.
	if findings != 0 {
		t.Errorf("finding_count = %d for an empty café, want 0", findings)
	}
}

// Regression: briefRecipients originally ran on the bare pool. tenant_members'
// policy is (tenant_id = current_tenant_id() OR user_id = current_user_id()), so
// with neither GUC set it returns NOTHING — no error, just an empty list and a
// warning, which is the worst possible failure shape. It must run inside the
// café transaction.
func TestBrief_RecipientsResolveInsideTheTenantTransaction(t *testing.T) {
	r := briefRunner(t)
	tenantID, _ := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	email := "brief-owner-" + uuid.NewString()[:8] + "@test.local"
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'Brief Owner') RETURNING id`, email).
		Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })

	if _, err := pool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1,$2,'active')`,
		tenantID, userID); err != nil {
		t.Fatal(err)
	}
	var roleID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1,'owner','Owner',true)
		ON CONFLICT (tenant_id, key) DO UPDATE SET name = roles.name RETURNING id`, tenantID).
		Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`,
		tenantID, userID, roleID); err != nil {
		t.Fatal(err)
	}

	var got []string
	if err := r.withTenant(ctx, tenantID, func(tx pgx.Tx) error {
		var err error
		got, err = briefRecipients(ctx, tx)
		return err
	}); err != nil {
		t.Fatalf("withTenant: %v", err)
	}
	if len(got) != 1 || got[0] != email {
		t.Fatalf("recipients = %v, want [%s]", got, email)
	}

	// And the proof that the tenant context is what makes it work: the same
	// query on the bare pool sees nothing.
	rows, err := r.pool.Query(ctx, `SELECT 1 FROM tenant_members WHERE tenant_id = $1`, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Error("tenant_members should be invisible without a tenant context; " +
			"if this passes, the RLS policy has changed and briefRecipients' guarantee is gone")
	}
}

// withTenant must set the GUC TRANSACTION-locally, so it cannot leak onto the
// next user of a pooled connection. That is a structural guarantee rather than
// the defer-and-hope a session-level GUC needs.
func TestBrief_TenantContextDoesNotLeakOntoTheConnection(t *testing.T) {
	r := briefRunner(t)
	tenantID, _ := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	if err := r.withTenant(ctx, tenantID, func(tx pgx.Tx) error {
		var got string
		return tx.QueryRow(ctx, `SELECT current_tenant_id()::text`).Scan(&got)
	}); err != nil {
		t.Fatalf("withTenant: %v", err)
	}

	// Hammer the pool: whichever connection comes back must have no tenant.
	for range 5 {
		var leaked *string
		if err := r.pool.QueryRow(ctx, `SELECT current_tenant_id()::text`).Scan(&leaked); err != nil {
			t.Fatal(err)
		}
		if leaked != nil {
			t.Fatalf("app.tenant_id leaked out of the transaction: %q", *leaked)
		}
	}
}

// dueCafes must respect each café's OWN local hour. A single platform-wide hour
// would brief a café in another timezone in the middle of its afternoon.
func TestBrief_DueDependsOnTheCafesOwnLocalHour(t *testing.T) {
	r := briefRunner(t)
	tenantID, _ := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	loc, _ := time.LoadLocation("Asia/Kathmandu")
	localHour := time.Now().In(loc).Hour()

	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()

	// Target the café's current local hour: it must be due.
	r.cfg.BriefHour = localHour
	due, err := r.dueCafes(ctx, conn.Conn(), false)
	if err != nil {
		t.Fatalf("dueCafes: %v", err)
	}
	if !containsTenant(due, tenantID) {
		t.Errorf("café not due at its own local hour %d", localHour)
	}

	// Target an hour well outside the catch-up window: it must not be.
	r.cfg.BriefHour = (localHour + briefCatchUpHours + 2) % 24
	due, err = r.dueCafes(ctx, conn.Conn(), false)
	if err != nil {
		t.Fatalf("dueCafes: %v", err)
	}
	if containsTenant(due, tenantID) {
		t.Errorf("café due at hour %d when its local hour is %d", r.cfg.BriefHour, localHour)
	}
}

// force ignores the hour so the manual trigger works at any time of day, but it
// must NOT ignore the marker: re-running fills gaps, it does not re-send.
func TestBrief_ForceIgnoresTheHourButNotTheMarker(t *testing.T) {
	r := briefRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()

	// An hour it could not possibly be due at.
	loc, _ := time.LoadLocation("Asia/Kathmandu")
	r.cfg.BriefHour = (time.Now().In(loc).Hour() + 6) % 24

	due, err := r.dueCafes(ctx, conn.Conn(), true)
	if err != nil {
		t.Fatalf("dueCafes(force): %v", err)
	}
	if !containsTenant(due, tenantID) {
		t.Fatal("force must make a café due regardless of the hour")
	}

	// Now give it a brief, and force must stop offering it.
	if err := r.briefFor(ctx, c, time.Now()); err != nil {
		t.Fatal(err)
	}
	due, err = r.dueCafes(ctx, conn.Conn(), true)
	if err != nil {
		t.Fatal(err)
	}
	if containsTenant(due, tenantID) {
		t.Error("force must not re-offer a café that already has today's brief")
	}
}

// The brief job must not be able to block the platform digest, so it holds a
// DIFFERENT advisory lock.
func TestBrief_UsesItsOwnAdvisoryLock(t *testing.T) {
	if briefLockKey == advisoryLockKey {
		t.Fatal("the brief job must not share the digest's lock: a slow fan-out " +
			"would block the platform digest for the day")
	}
}

func containsTenant(due []dueCafe, id uuid.UUID) bool {
	for _, c := range due {
		if c.TenantID == id {
			return true
		}
	}
	return false
}
