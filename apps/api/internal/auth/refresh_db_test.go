package auth

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dbPool returns an admin pool, skipping the test when no DB URL is set.
// Requires migrations (incl. 0020) to have been applied.
func dbPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = os.Getenv("APP_DATABASE_URL")
	}
	if url == "" {
		t.Skip("DATABASE_URL/APP_DATABASE_URL not set; skipping refresh integration test")
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

func makeUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	email := "rt-" + uuid.NewString()[:8] + "@test.local"
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, 'Refresh Test') RETURNING id`, email).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
	return id
}

func TestRotateRefresh_NormalRotation(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	uid := makeUser(t, pool)

	raw1, sid1, err := CreateSession(ctx, pool, uid, "", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	raw2, sid2, gotUID, err := RotateRefresh(ctx, pool, raw1, "", "")
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if sid2 == sid1 {
		t.Fatal("expected a new session id after rotation")
	}
	if gotUID != uid {
		t.Fatalf("user mismatch: got %s want %s", gotUID, uid)
	}
	// Old row must be revoked + point at the successor.
	var revoked *time.Time
	var replacedBy *uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT revoked_at, replaced_by FROM sessions WHERE id = $1`, sid1).Scan(&revoked, &replacedBy); err != nil {
		t.Fatalf("read old row: %v", err)
	}
	if revoked == nil {
		t.Fatal("old session should be revoked")
	}
	if replacedBy == nil || *replacedBy != sid2 {
		t.Fatalf("replaced_by should point at successor %s, got %v", sid2, replacedBy)
	}
	// The new token works for a further rotation.
	if _, _, _, err := RotateRefresh(ctx, pool, raw2, "", ""); err != nil {
		t.Fatalf("rotate successor: %v", err)
	}
}

func TestRotateRefresh_GraceReplay(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	uid := makeUser(t, pool)

	raw1, _, _ := CreateSession(ctx, pool, uid, "", "")
	if _, _, _, err := RotateRefresh(ctx, pool, raw1, "", ""); err != nil {
		t.Fatalf("first rotate: %v", err)
	}
	// Presenting raw1 again immediately (within the grace window) must NOT be
	// treated as reuse — it returns a fresh token (idempotent replay).
	raw3, _, _, err := RotateRefresh(ctx, pool, raw1, "", "")
	if err != nil {
		t.Fatalf("grace replay should succeed, got: %v", err)
	}
	if raw3 == "" {
		t.Fatal("expected a fresh token from grace replay")
	}
}

func TestRotateRefresh_ReuseRevokesChain(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	uid := makeUser(t, pool)

	raw1, sid1, _ := CreateSession(ctx, pool, uid, "", "")
	if _, _, _, err := RotateRefresh(ctx, pool, raw1, "", ""); err != nil {
		t.Fatalf("first rotate: %v", err)
	}
	// Simulate the replay arriving AFTER the grace window by backdating
	// replaced_at on the original row.
	if _, err := pool.Exec(ctx,
		`UPDATE sessions SET replaced_at = now() - interval '1 hour' WHERE id = $1`, sid1); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	_, _, _, err := RotateRefresh(ctx, pool, raw1, "", "")
	if !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("expected ErrRefreshReuse, got: %v", err)
	}
	// Every session for the user must now be revoked.
	var active int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, uid).Scan(&active); err != nil {
		t.Fatalf("count active: %v", err)
	}
	if active != 0 {
		t.Fatalf("expected all sessions revoked after reuse, %d still active", active)
	}
}

func TestTokenVersionBump(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	uid := makeUser(t, pool)

	v0, err := GetTokenVersion(ctx, pool, uid)
	if err != nil {
		t.Fatalf("get tv: %v", err)
	}
	v1, err := BumpTokenVersion(ctx, pool, uid)
	if err != nil {
		t.Fatalf("bump tv: %v", err)
	}
	if v1 != v0+1 {
		t.Fatalf("expected bump to %d, got %d", v0+1, v1)
	}
	// Cache must reflect the bump immediately.
	v2, _ := GetTokenVersion(ctx, pool, uid)
	if v2 != v1 {
		t.Fatalf("cache stale: got %d want %d", v2, v1)
	}
}
