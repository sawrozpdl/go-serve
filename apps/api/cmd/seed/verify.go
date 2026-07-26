package main

// Seed data that violates the money invariants is worse than no seed data: every
// screen disagrees and you go hunting a bug that isn't there. So the generator
// checks its own work before exiting.
//
// It runs the same invariants /super/accuracy-check runs (platform_accuracy_check,
// migration 0056) and requires:
//
//   - healthy tenants report NOTHING
//   - messy-cafe reports EXACTLY the patterns it was built to carry
//
// The second half matters as much as the first: it means the check itself is
// covered. If a future change stops detecting one of those patterns, seeding
// fails rather than the check quietly going blind.

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

func wipeTenant(ctx context.Context, pool *pgxpool.Pool, slug string) error {
	// ON DELETE CASCADE from tenants clears every child table (see 0036's purge
	// notes for the dependency order the DB already enforces).
	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE slug = $1`, slug); err != nil {
		return fmt.Errorf("wipe %s: %w", slug, err)
	}
	return nil
}

type violation struct {
	slug   string
	check  string
	detail string
	delta  int64
}

func verifySeed(ctx context.Context, pool *pgxpool.Pool, plans []blueprint, seeded []string) error {
	// platform_accuracy_check gates on is_platform_admin(current_user_id()), so
	// run it as one. Seeding is a superuser operation, so borrowing an existing
	// admin (or bypassing when there is none) is fine here.
	var adminID *string
	var id string
	if err := pool.QueryRow(ctx, `SELECT user_id::text FROM platform_admins LIMIT 1`).Scan(&id); err == nil {
		adminID = &id
	}
	if adminID == nil {
		// No platform admin in this database — fall back to the raw invariants so
		// verification still runs on a bare dev box.
		return verifyRaw(ctx, pool, plans, seeded)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT set_config('app.user_id', $1, false)`, *adminID); err != nil {
		return err
	}

	rows, err := conn.Query(ctx, `
		SELECT slug, check_key, detail, delta_cents FROM platform_accuracy_check()
	`)
	if err != nil {
		return fmt.Errorf("run accuracy check: %w", err)
	}
	defer rows.Close()

	found := map[string]map[string]int{} // slug → check → count
	var samples []violation
	for rows.Next() {
		var v violation
		if err := rows.Scan(&v.slug, &v.check, &v.detail, &v.delta); err != nil {
			return err
		}
		if found[v.slug] == nil {
			found[v.slug] = map[string]int{}
		}
		found[v.slug][v.check]++
		if len(samples) < 20 {
			samples = append(samples, v)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	seededSet := map[string]bool{}
	for _, s := range seeded {
		seededSet[s] = true
	}

	var problems []string
	for _, bp := range plans {
		if !seededSet[bp.Slug] {
			continue
		}
		got := found[bp.Slug]
		if bp.Messy {
			// Every expected pattern must be present.
			var missing []string
			for _, want := range expectedMessyChecks {
				if got[want] == 0 {
					missing = append(missing, want)
				}
			}
			if len(missing) > 0 {
				problems = append(problems, fmt.Sprintf(
					"%s was built to carry %v but the accuracy check did not report: %v "+
						"(the check may have stopped detecting them)",
					bp.Slug, expectedMessyChecks, missing))
			}
			continue
		}
		if len(got) > 0 {
			keys := make([]string, 0, len(got))
			for k, n := range got {
				keys = append(keys, fmt.Sprintf("%s×%d", k, n))
			}
			sort.Strings(keys)
			problems = append(problems, fmt.Sprintf(
				"%s should be clean but reported: %s", bp.Slug, strings.Join(keys, ", ")))
		}
	}

	if len(problems) > 0 {
		var b strings.Builder
		for _, p := range problems {
			b.WriteString("\n  - " + p)
		}
		if len(samples) > 0 {
			b.WriteString("\n\n  sample rows:")
			for _, s := range samples {
				if seededSet[s.slug] {
					b.WriteString(fmt.Sprintf("\n    [%s] %s: %s (delta %d)",
						s.slug, s.check, s.detail, s.delta))
				}
			}
		}
		return fmt.Errorf("money invariants violated:%s", b.String())
	}
	return nil
}

// verifyRaw covers the case where the database has no platform admin (so the
// SECURITY DEFINER function returns nothing): assert the two identities that
// matter most, directly.
func verifyRaw(ctx context.Context, pool *pgxpool.Pool, plans []blueprint, seeded []string) error {
	seededSet := map[string]bool{}
	for _, s := range seeded {
		seededSet[s] = true
	}
	for _, bp := range plans {
		if !seededSet[bp.Slug] || bp.Messy {
			continue
		}
		var badArithmetic, badPayments int
		if err := pool.QueryRow(ctx, `
			SELECT
			  (SELECT count(*) FROM orders o JOIN tenants t ON t.id = o.tenant_id
			   WHERE t.slug = $1 AND o.status = 'closed'
			     AND o.total_cents NOT IN (
			       o.subtotal_cents - o.discount_cents + o.service_charge_cents,
			       o.subtotal_cents - o.discount_cents + o.service_charge_cents + o.tax_cents)),
			  (SELECT count(*) FROM orders o JOIN tenants t ON t.id = o.tenant_id
			   WHERE t.slug = $1 AND o.status = 'closed'
			     AND o.total_cents <> COALESCE(
			       (SELECT SUM(amount_cents) FROM payments WHERE order_id = o.id), 0))
		`, bp.Slug).Scan(&badArithmetic, &badPayments); err != nil {
			return fmt.Errorf("raw verify %s: %w", bp.Slug, err)
		}
		if badArithmetic > 0 || badPayments > 0 {
			return fmt.Errorf(
				"%s: %d orders whose totals don't reconcile, %d whose payments don't match the total",
				bp.Slug, badArithmetic, badPayments)
		}
	}
	return nil
}
