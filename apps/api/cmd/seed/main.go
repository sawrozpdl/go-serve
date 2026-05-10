// Seed creates two demo tenants (sahan, brews) with one owner each and
// optional waiter/kitchen members. Idempotent: re-running upserts.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type member struct {
	email string
	name  string
	role  string
}

type tenantSeed struct {
	slug    string
	name    string
	tz      string
	members []member
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL not set")
		os.Exit(2)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open db: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	tenants := []tenantSeed{
		{slug: "sahan", name: "Sahan Cafe", tz: "Asia/Kathmandu", members: []member{
			{email: "owner@sahan.test", name: "Sahan Owner", role: "owner"},
			{email: "manager@sahan.test", name: "Sahan Manager", role: "manager"},
			{email: "waiter@sahan.test", name: "Sahan Waiter", role: "waiter"},
			{email: "kitchen@sahan.test", name: "Sahan Kitchen", role: "kitchen"},
		}},
		{slug: "brews", name: "Brews & Co", tz: "Asia/Kathmandu", members: []member{
			{email: "owner@brews.test", name: "Brews Owner", role: "owner"},
			{email: "waiter@brews.test", name: "Brews Waiter", role: "waiter"},
		}},
	}

	for _, t := range tenants {
		if err := seedTenant(ctx, pool, t); err != nil {
			slog.Error("seed failed", "tenant", t.slug, "err", err)
			os.Exit(1)
		}
		slog.Info("seeded", "tenant", t.slug, "members", len(t.members))
	}
}

func seedTenant(ctx context.Context, pool *pgxpool.Pool, ts tenantSeed) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tenantID uuid.UUID
	row := tx.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, timezone)
		VALUES ($1, $2, $3)
		ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone
		RETURNING id
	`, ts.slug, ts.name, ts.tz)
	if err := row.Scan(&tenantID); err != nil {
		return fmt.Errorf("upsert tenant: %w", err)
	}

	// Set both contexts so RLS allows tenant_members writes.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
		return fmt.Errorf("set tenant ctx: %w", err)
	}

	for _, m := range ts.members {
		var userID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (email, name)
			VALUES ($1, $2)
			ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
			RETURNING id
		`, m.email, m.name).Scan(&userID); err != nil {
			return fmt.Errorf("upsert user %s: %w", m.email, err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_members (tenant_id, user_id, role, status)
			VALUES ($1, $2, $3, 'active')
			ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
		`, tenantID, userID, m.role); err != nil {
			return fmt.Errorf("upsert member %s: %w", m.email, err)
		}
	}
	return tx.Commit(ctx)
}
