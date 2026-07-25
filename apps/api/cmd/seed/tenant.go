package main

// Building one tenant: identity and roles, then a catalogue, then a day-by-day
// trading history that obeys the same invariants production does.

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

type stats struct {
	orders        int
	shifts        int
	expenses      int
	creditCharges int
	collections   int
}

// world is everything the day loop needs to reference.
type world struct {
	bp       blueprint
	tenantID uuid.UUID
	users    map[string]uuid.UUID // role key → user id
	owner    uuid.UUID            // the acting user for most writes
	items    []seededItem
	tables   []uuid.UUID
	retired  uuid.UUID // a table retired mid-history (table-mix "Retired tables")
	tabs     []uuid.UUID
	owners   []uuid.UUID
	staff    []uuid.UUID
	catByID  map[uuid.UUID]uuid.UUID
	stats    stats
}

type seededItem struct {
	ID        uuid.UUID
	Category  uuid.UUID
	Price     int64
	Cost      int64
	AllowHalf bool
	Weight    int
}

func seedTenant(ctx context.Context, pool *pgxpool.Pool, bp blueprint, rng *rand.Rand) (stats, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return stats{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	w := &world{bp: bp, users: map[string]uuid.UUID{}, catByID: map[uuid.UUID]uuid.UUID{}}

	if err := w.identity(ctx, tx); err != nil {
		return w.stats, err
	}
	// RLS: every write below is tenant-scoped, exactly as a request would be.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, w.tenantID.String()); err != nil {
		return w.stats, fmt.Errorf("set tenant ctx: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, w.owner.String()); err != nil {
		return w.stats, fmt.Errorf("set user ctx: %w", err)
	}

	if bp.Days > 0 || len(bp.CreditNames) > 0 {
		if err := w.catalogue(ctx, tx, rng); err != nil {
			return w.stats, err
		}
	}
	if err := w.people(ctx, tx); err != nil {
		return w.stats, err
	}
	if err := w.trade(ctx, tx, rng); err != nil {
		return w.stats, err
	}
	if bp.Messy {
		if err := w.breakThings(ctx, tx); err != nil {
			return w.stats, err
		}
	}
	return w.stats, tx.Commit(ctx)
}

// identity upserts the tenant, its users, memberships and per-tenant roles.
//
// Roles live in roles + tenant_member_roles (migration 0019). The previous
// version of this file still wrote tenant_members.roles, a column that migration
// removed — so `make seed` had been failing outright for every tenant. Getting
// this wrong is invisible until something JOINs the role tables, which is exactly
// how the shift-summary email silently lost its recipients.
func (w *world) identity(ctx context.Context, tx pgx.Tx) error {
	if err := tx.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, timezone, vat_mode, vat_pct, service_charge_pct)
		VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric)
		ON CONFLICT (slug) DO UPDATE SET
		  name = EXCLUDED.name, timezone = EXCLUDED.timezone,
		  vat_mode = EXCLUDED.vat_mode, vat_pct = EXCLUDED.vat_pct,
		  service_charge_pct = EXCLUDED.service_charge_pct
		RETURNING id
	`, w.bp.Slug, w.bp.Name, w.bp.TZ, w.bp.VatMode, w.bp.VatPct, w.bp.ServicePct,
	).Scan(&w.tenantID); err != nil {
		return fmt.Errorf("upsert tenant: %w", err)
	}

	// System roles + their permissions come from the RBAC model itself
	// (rbac.SeedSystemRoles), the same call real tenant creation makes. Listing
	// permissions here instead would drift from the model — and the owner role is
	// guarded at the DB level to be exactly '*:*', so a hand-written list is
	// rejected outright.
	var roleCount int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM roles WHERE tenant_id = $1`, w.tenantID).Scan(&roleCount); err != nil {
		return fmt.Errorf("count roles: %w", err)
	}
	if roleCount == 0 {
		if _, err := rbac.NewRepo(nil, rbac.NewCache(8)).SeedSystemRoles(ctx, tx, w.tenantID); err != nil {
			return fmt.Errorf("seed system roles: %w", err)
		}
	}

	for _, m := range w.bp.Members {
		var userID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (email, name) VALUES ($1, $2)
			ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
			RETURNING id
		`, m.Email, m.Name).Scan(&userID); err != nil {
			return fmt.Errorf("upsert user %s: %w", m.Email, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_members (tenant_id, user_id, status)
			VALUES ($1, $2, 'active')
			ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
		`, w.tenantID, userID); err != nil {
			return fmt.Errorf("upsert member %s: %w", m.Email, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_member_roles (tenant_id, user_id, role_id)
			SELECT $1, $2, id FROM roles WHERE tenant_id = $1 AND key = $3
			ON CONFLICT DO NOTHING
		`, w.tenantID, userID, m.Role); err != nil {
			return fmt.Errorf("grant role %s to %s: %w", m.Role, m.Email, err)
		}
		w.users[m.Role] = userID
		if m.Role == "owner" {
			w.owner = userID
		}
	}
	if w.owner == uuid.Nil {
		return fmt.Errorf("blueprint %s has no owner member", w.bp.Slug)
	}
	return nil
}

// catalogue writes the menu, the floor and the credit accounts.
func (w *world) catalogue(ctx context.Context, tx pgx.Tx, rng *rand.Rand) error {
	for si, mp := range menuPlans() {
		var catID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO menu_categories (tenant_id, name, sort)
			VALUES ($1, $2, $3)
			ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL
			  DO UPDATE SET sort = EXCLUDED.sort
			RETURNING id
		`, w.tenantID, mp.Category, si).Scan(&catID); err != nil {
			return fmt.Errorf("upsert category %s: %w", mp.Category, err)
		}
		for ii, ip := range mp.Items {
			// menu_items has no unique index on (tenant, category, name) — only on
			// sku — so this is a lookup-then-insert rather than an upsert.
			var itemID uuid.UUID
			err := tx.QueryRow(ctx, `
				SELECT id FROM menu_items
				WHERE tenant_id = $1 AND category_id = $2 AND lower(name) = lower($3)
				  AND deleted_at IS NULL
			`, w.tenantID, catID, ip.Name).Scan(&itemID)
			if errors.Is(err, pgx.ErrNoRows) {
				if err := tx.QueryRow(ctx, `
					INSERT INTO menu_items
					  (tenant_id, category_id, name, price_cents, cost_cents, allow_half, sort, is_active)
					VALUES ($1, $2, $3, $4, $5, $6, $7, true)
					RETURNING id
				`, w.tenantID, catID, ip.Name, ip.Price, ip.Cost, ip.AllowHalf, ii).Scan(&itemID); err != nil {
					return fmt.Errorf("insert item %s: %w", ip.Name, err)
				}
			} else if err != nil {
				return fmt.Errorf("lookup item %s: %w", ip.Name, err)
			} else if _, err := tx.Exec(ctx, `
				UPDATE menu_items SET price_cents = $2, cost_cents = $3, allow_half = $4 WHERE id = $1
			`, itemID, ip.Price, ip.Cost, ip.AllowHalf); err != nil {
				return fmt.Errorf("update item %s: %w", ip.Name, err)
			}
			w.items = append(w.items, seededItem{
				ID: itemID, Category: catID, Price: ip.Price, Cost: ip.Cost,
				AllowHalf: ip.AllowHalf, Weight: ip.Weight,
			})
			w.catByID[itemID] = catID
		}
	}

	for si, tp := range tablePlan() {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO service_tables (tenant_id, name, capacity, sort)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL
			  DO UPDATE SET capacity = EXCLUDED.capacity
			RETURNING id
		`, w.tenantID, tp.Name, tp.Capacity, si).Scan(&id); err != nil {
			return fmt.Errorf("upsert table %s: %w", tp.Name, err)
		}
		w.tables = append(w.tables, id)
	}
	// One table gets retired later so the table-mix report has a "Retired tables"
	// row — revenue that happened on a table which no longer exists.
	if len(w.tables) > 2 {
		w.retired = w.tables[len(w.tables)-1]
	}

	for _, name := range w.bp.CreditNames {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO house_tabs (tenant_id, name, contact_phone, created_by_user_id)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL
			  DO UPDATE SET contact_phone = EXCLUDED.contact_phone
			RETURNING id
		`, w.tenantID, name, fmt.Sprintf("98%08d", rng.Intn(100000000)), w.owner).Scan(&id); err != nil {
			return fmt.Errorf("upsert credit account %s: %w", name, err)
		}
		w.tabs = append(w.tabs, id)
	}
	return nil
}

// people writes owners (capital accounts) and staff (payroll).
//
// Explicit lookup-then-insert, not INSERT … ON CONFLICT DO NOTHING RETURNING:
// with the latter, a genuine failure (a column that doesn't exist, say) poisons
// the transaction and every following statement reports the useless "current
// transaction is aborted" instead of the actual cause.
func (w *world) people(ctx context.Context, tx pgx.Tx) error {
	for i, name := range w.bp.OwnerNames {
		var id uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM cafe_owners WHERE tenant_id = $1 AND display_name = $2`,
			w.tenantID, name).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.QueryRow(ctx, `
				INSERT INTO cafe_owners (tenant_id, display_name, share_units)
				VALUES ($1, $2, $3) RETURNING id
			`, w.tenantID, name, 100/(i+1)).Scan(&id); err != nil {
				return fmt.Errorf("insert owner %s: %w", name, err)
			}
		} else if err != nil {
			return fmt.Errorf("lookup owner %s: %w", name, err)
		}
		w.owners = append(w.owners, id)
	}

	for _, name := range w.bp.StaffNames {
		var id uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM staff WHERE tenant_id = $1 AND full_name = $2 AND deleted_at IS NULL`,
			w.tenantID, name).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.QueryRow(ctx, `
				INSERT INTO staff (tenant_id, full_name, role_title, status, phone)
				VALUES ($1, $2, 'Server', 'active', '')
				RETURNING id
			`, w.tenantID, name).Scan(&id); err != nil {
				return fmt.Errorf("insert staff %s: %w", name, err)
			}
		} else if err != nil {
			return fmt.Errorf("lookup staff %s: %w", name, err)
		}
		w.staff = append(w.staff, id)
	}
	return nil
}

// localMidnight returns the UTC instant of local midnight `daysAgo` days back.
func (w *world) localMidnight(daysAgo int) (time.Time, error) {
	loc, err := time.LoadLocation(w.bp.TZ)
	if err != nil {
		return time.Time{}, err
	}
	now := time.Now().In(loc)
	d := now.AddDate(0, 0, -daysAgo)
	return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, loc).UTC(), nil
}
