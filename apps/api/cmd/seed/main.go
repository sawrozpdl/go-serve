// Seed builds production-shaped demo data so the app can be exercised — by a
// human on localhost, by the Playwright suite, or by anyone chasing a bug —
// against numbers that look like a real cafe's books rather than three orders.
//
//	make seed                     # every tenant, default volumes
//	make seed ARGS='--reset'      # wipe seeded tenants first
//	go run ./cmd/seed --only sahan --days 30
//	go run ./cmd/seed --rng 42    # a different but still reproducible world
//
// # WHY IT LOOKS LIKE THIS
//
// Every figure the app reports is derived, so demo data is only useful if it
// obeys the same invariants production data does: an order's stored totals must
// reconcile with its lines, its payments must equal its total, a closed shift's
// expected cash must match its own rows, a credit account's balance must equal
// charges minus live collections. Data that violates those doesn't just look
// wrong — it makes every screen disagree and sends you hunting a bug that isn't
// there. So the generator writes through one quote function mirroring buildQuote
// (payments.go), then VERIFIES itself against the same invariants
// /super/accuracy-check uses, and refuses to exit 0 if a tenant that should be
// clean isn't.
//
// Determinism: all randomness comes from --rng (default 20260725), so the same
// flags always produce the same world and a bug found in it reproduces exactly.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	var (
		only    = flag.String("only", "", "comma-separated tenant slugs to seed (default: all)")
		days    = flag.Int("days", 0, "override each tenant's trading days")
		rngSeed = flag.Int64("rng", 20260725, "PRNG seed — same seed, same world")
		reset   = flag.Bool("reset", false, "delete the seeded tenants before seeding")
		verify  = flag.Bool("verify", true, "run the money invariants after seeding")
	)
	flag.Parse()

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

	wanted := map[string]bool{}
	for _, s := range strings.Split(*only, ",") {
		if s = strings.TrimSpace(s); s != "" {
			wanted[s] = true
		}
	}

	plans := blueprints()
	start := time.Now()
	var seeded []string

	for i := range plans {
		bp := &plans[i]
		if len(wanted) > 0 && !wanted[bp.Slug] {
			continue
		}
		if *days > 0 && bp.Days > 0 {
			bp.Days = *days
		}
		if *reset {
			if err := wipeTenant(ctx, pool, bp.Slug); err != nil {
				slog.Error("reset failed", "tenant", bp.Slug, "err", err)
				os.Exit(1)
			}
		}
		// Each tenant gets its own PRNG stream derived from the global seed, so
		// seeding a subset (--only) yields the same tenant as a full run.
		rng := rand.New(rand.NewSource(*rngSeed + int64(len(bp.Slug)*7919)))
		st, err := seedTenant(ctx, pool, *bp, rng)
		if err != nil {
			slog.Error("seed failed", "tenant", bp.Slug, "err", err)
			os.Exit(1)
		}
		slog.Info("seeded", "tenant", bp.Slug, "days", bp.Days,
			"orders", st.orders, "shifts", st.shifts, "expenses", st.expenses,
			"credit_charges", st.creditCharges, "collections", st.collections)
		seeded = append(seeded, bp.Slug)
	}

	if len(seeded) == 0 {
		fmt.Fprintf(os.Stderr, "no tenants matched --only=%q\n", *only)
		os.Exit(2)
	}

	if *verify {
		if err := verifySeed(ctx, pool, plans, seeded); err != nil {
			slog.Error("seed verification FAILED", "err", err)
			fmt.Fprintln(os.Stderr,
				"\nThe generator produced data that violates the money invariants.\n"+
					"That is a bug in the generator (or in the invariants) — not something to\n"+
					"work around, because every report derives from these rows.")
			os.Exit(1)
		}
		slog.Info("verified", "tenants", len(seeded), "took", time.Since(start).Round(time.Millisecond))
	}

	fmt.Println()
	printLoginHelp(plans, seeded)
}

// printLoginHelp tells the operator how to get in, which is the first thing
// anyone needs after seeding.
func printLoginHelp(plans []blueprint, seeded []string) {
	inSeeded := func(slug string) bool {
		for _, s := range seeded {
			if s == slug {
				return true
			}
		}
		return false
	}
	fmt.Println("Seeded tenants")
	fmt.Println("──────────────")
	for _, bp := range plans {
		if !inSeeded(bp.Slug) {
			continue
		}
		fmt.Printf("  %-14s %s\n", bp.Slug, bp.Purpose)
		for _, m := range bp.Members {
			fmt.Printf("    %-26s %s\n", m.Email, m.Role)
		}
	}
	fmt.Println()
	fmt.Println("Log in with any email above. On a dev build (APP_ENV != prod) the OTP is")
	fmt.Println("printed to the API console by /auth/request-otp.")
}
