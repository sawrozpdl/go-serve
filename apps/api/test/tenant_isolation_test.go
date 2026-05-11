// Multi-tenant isolation integration test.
//
// This test is the safety net for everything that follows. It boots two
// tenants, sets each as the active context, and asserts that cross-tenant
// reads and writes are impossible.
//
// Connects via APP_DATABASE_URL (the non-superuser, NOBYPASSRLS connection).
// Skipped if not set — set it in CI and locally via .env.
package test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("APP_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("APP_DATABASE_URL/DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// adminPool returns a connection capable of bypassing RLS, used to set up
// fixtures and clean up. Falls back to the same URL if no admin URL is set.
func adminPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = os.Getenv("APP_DATABASE_URL")
	}
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type fixtures struct {
	tenantA   uuid.UUID
	tenantB   uuid.UUID
	userAlice uuid.UUID // member of A
	userBob   uuid.UUID // member of B
}

func setupFixtures(t *testing.T, admin *pgxpool.Pool) fixtures {
	t.Helper()
	ctx := context.Background()
	suffix := uuid.NewString()[:8]

	var f fixtures
	mustQuery(t, admin, ctx, &f.tenantA,
		`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
		"test-iso-a-"+suffix, "Test Iso A")
	mustQuery(t, admin, ctx, &f.tenantB,
		`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
		"test-iso-b-"+suffix, "Test Iso B")
	mustQuery(t, admin, ctx, &f.userAlice,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"alice-"+suffix+"@test.local", "Alice")
	mustQuery(t, admin, ctx, &f.userBob,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"bob-"+suffix+"@test.local", "Bob")

	mustExec(t, admin, ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, roles) VALUES ($1, $2, ARRAY['owner']::tenant_role[])`,
		f.tenantA, f.userAlice)
	mustExec(t, admin, ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, roles) VALUES ($1, $2, ARRAY['owner']::tenant_role[])`,
		f.tenantB, f.userBob)

	mustExec(t, admin, ctx,
		`INSERT INTO audit_events (tenant_id, action, entity_type, entity_id) VALUES ($1, 'seed', 'fixture', 'a')`,
		f.tenantA)
	mustExec(t, admin, ctx,
		`INSERT INTO audit_events (tenant_id, action, entity_type, entity_id) VALUES ($1, 'seed', 'fixture', 'b')`,
		f.tenantB)

	// Seed the richer audit_log table (0011) too — both for isolation
	// checks below and so dev fixtures show an entry in the Activity feed.
	mustExec(t, admin, ctx, `
		INSERT INTO audit_log (tenant_id, actor_id, actor_name, actor_email,
		                       role_snap, action, entity, summary)
		VALUES ($1, $2, 'Alice', 'alice@test.local', ARRAY['owner']::text[],
		        'seed', 'fixture', 'seed entry for tenant A')`,
		f.tenantA, f.userAlice)
	mustExec(t, admin, ctx, `
		INSERT INTO audit_log (tenant_id, actor_id, actor_name, actor_email,
		                       role_snap, action, entity, summary)
		VALUES ($1, $2, 'Bob', 'bob@test.local', ARRAY['owner']::text[],
		        'seed', 'fixture', 'seed entry for tenant B')`,
		f.tenantB, f.userBob)

	t.Cleanup(func() {
		// CASCADE wipes tenant_members + audit_events.
		_, _ = admin.Exec(ctx, `DELETE FROM tenants WHERE id = ANY($1)`, []uuid.UUID{f.tenantA, f.tenantB})
		_, _ = admin.Exec(ctx, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{f.userAlice, f.userBob})
	})
	return f
}

// withTenantTx runs fn inside a tx that has app.tenant_id (and optionally
// app.user_id) set, mimicking the runtime middleware.
func withTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID uuid.UUID, userID uuid.UUID, fn func(pgx.Tx)) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if userID != uuid.Nil {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, userID.String()); err != nil {
			t.Fatalf("set user: %v", err)
		}
	}
	fn(tx)
}

// =========================================================================
// TESTS
// =========================================================================

func TestTenantMembers_CrossReadBlocked(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(),
			`SELECT count(*) FROM tenant_members WHERE tenant_id = $1`, f.tenantB,
		).Scan(&n); err != nil {
			t.Fatalf("query: %v", err)
		}
		if n != 0 {
			t.Errorf("Tenant A context saw %d rows from Tenant B's members; want 0", n)
		}
	})
}

func TestTenantMembers_OwnTenantVisible(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(),
			`SELECT count(*) FROM tenant_members WHERE tenant_id = $1`, f.tenantA,
		).Scan(&n); err != nil {
			t.Fatalf("query: %v", err)
		}
		if n != 1 {
			t.Errorf("Tenant A context saw %d rows from own members; want 1", n)
		}
	})
}

func TestTenantMembers_UserScopedReadWithoutTenant(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	// Alice authenticates but has not picked a workspace yet → tenant
	// context is unset. Policy allows her to see her own memberships only.
	ctx := context.Background()
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, f.userAlice.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	var seenA, seenB int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tenant_members WHERE tenant_id = $1`, f.tenantA).Scan(&seenA); err != nil {
		t.Fatalf("q a: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tenant_members WHERE tenant_id = $1`, f.tenantB).Scan(&seenB); err != nil {
		t.Fatalf("q b: %v", err)
	}
	if seenA != 1 {
		t.Errorf("Alice should see her own membership in A; got %d", seenA)
	}
	if seenB != 0 {
		t.Errorf("Alice should NOT see B's memberships; got %d", seenB)
	}
}

func TestAuditEvents_CrossReadBlocked(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(),
			`SELECT count(*) FROM audit_events WHERE tenant_id = $1`, f.tenantB,
		).Scan(&n); err != nil {
			t.Fatalf("query: %v", err)
		}
		if n != 0 {
			t.Errorf("Tenant A context saw %d B audit_events; want 0", n)
		}
	})
}

func TestTenantMembers_CrossWriteBlocked(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	// In Tenant A's context, try to insert a member into Tenant B.
	// The WITH CHECK clause should block it.
	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		_, err := tx.Exec(context.Background(),
			`INSERT INTO tenant_members (tenant_id, user_id, roles) VALUES ($1, $2, ARRAY['waiter']::tenant_role[])`,
			f.tenantB, f.userAlice)
		if err == nil {
			t.Error("expected RLS to block cross-tenant insert; got no error")
		}
	})
}

func TestAuditEvents_CrossWriteBlocked(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		_, err := tx.Exec(context.Background(),
			`INSERT INTO audit_events (tenant_id, action, entity_type, entity_id) VALUES ($1, 'evil', 'fixture', 'x')`,
			f.tenantB)
		if err == nil {
			t.Error("expected RLS to block cross-tenant audit_event insert; got no error")
		}
	})
}

func TestNoTenantContext_SeesNothing(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	_ = setupFixtures(t, admin)

	ctx := context.Background()
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)

	var members, audits int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tenant_members`).Scan(&members); err != nil {
		t.Fatalf("q members: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_events`).Scan(&audits); err != nil {
		t.Fatalf("q audits: %v", err)
	}
	if members != 0 || audits != 0 {
		t.Errorf("with no context: members=%d audits=%d, want 0/0", members, audits)
	}
}

// =========================================================================
// audit_log (0011) — activity feed table. Same isolation guarantees as
// the older audit_events table.
// =========================================================================

func TestAuditLog_CrossReadBlocked(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(),
			`SELECT count(*) FROM audit_log WHERE tenant_id = $1`, f.tenantB,
		).Scan(&n); err != nil {
			t.Fatalf("query: %v", err)
		}
		if n != 0 {
			t.Errorf("Tenant A context saw %d B audit_log rows; want 0", n)
		}
	})
}

func TestAuditLog_OwnTenantVisible(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(),
			`SELECT count(*) FROM audit_log WHERE tenant_id = $1`, f.tenantA,
		).Scan(&n); err != nil {
			t.Fatalf("query: %v", err)
		}
		if n != 1 {
			t.Errorf("Tenant A context saw %d own audit_log rows; want 1", n)
		}
	})
}

func TestAuditLog_CrossWriteBlocked(t *testing.T) {
	app := dbPool(t)
	admin := adminPool(t)
	f := setupFixtures(t, admin)

	withTenantTx(t, app, f.tenantA, uuid.Nil, func(tx pgx.Tx) {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO audit_log (tenant_id, actor_name, actor_email,
			                       action, entity, summary)
			VALUES ($1, 'X', 'x@test.local', 'evil', 'fixture', 'cross-tenant insert')`,
			f.tenantB)
		if err == nil {
			t.Error("expected RLS to block cross-tenant audit_log insert; got no error")
		}
	})
}

// =========================================================================
// helpers
// =========================================================================

func mustExec(t *testing.T, pool *pgxpool.Pool, ctx context.Context, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %s: %v", sql, err)
	}
}

func mustQuery(t *testing.T, pool *pgxpool.Pool, ctx context.Context, dst *uuid.UUID, sql string, args ...any) {
	t.Helper()
	if err := pool.QueryRow(ctx, sql, args...).Scan(dst); err != nil {
		t.Fatalf("q %s: %v", sql, err)
	}
}
