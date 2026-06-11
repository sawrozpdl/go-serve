package super

// Shared test harness for the super package.
//
// Strategy: real integration tests that drive the actual handlers against the
// local "cafe" Postgres database. Two pools mirror production:
//
//   - adminPool (DATABASE_URL, superuser) — bypasses RLS, used ONLY for
//     seeding fixtures and making post-handler DB assertions.
//   - appPool   (APP_DATABASE_URL, app_user, NOBYPASSRLS) — used inside
//     callSuper to open the per-request tx, so GRANTS and RLS policies are
//     exercised exactly as they are in the live API.
//
// Super-admin routes run under auth.RequirePlatformAdmin + db.TxMiddleware,
// which sets app.user_id but NO app.tenant_id. Cross-tenant reads go through
// SECURITY DEFINER functions (platform_tenant_summaries, etc.). callSuper
// mirrors that: it begins an app-pool tx, sets only app.user_id, and injects
// appctx.WithPlatformAdmin(ctx, true).
//
// If DATABASE_URL / APP_DATABASE_URL are absent (and no .env is found), every
// DB-backed test skips instead of failing, so `go test ./...` is clean on a
// machine without a database.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	adminPool *pgxpool.Pool // superuser, bypasses RLS — fixtures only
	appPool   *pgxpool.Pool // app_user, RLS active — runs handlers
	dbSkip    string        // non-empty => DB unavailable, tests skip with this reason
)

func TestMain(m *testing.M) {
	loadDotEnv()

	adminURL := firstNonEmpty(os.Getenv("DATABASE_URL"), os.Getenv("APP_DATABASE_URL"))
	appURL := firstNonEmpty(os.Getenv("APP_DATABASE_URL"), os.Getenv("DATABASE_URL"))
	if adminURL == "" {
		dbSkip = "DATABASE_URL / APP_DATABASE_URL not set; skipping DB integration tests"
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	adminPool, err = pgxpool.New(ctx, adminURL)
	if err == nil {
		err = adminPool.Ping(ctx)
	}
	if err != nil {
		dbSkip = fmt.Sprintf("cannot connect to admin DB (%v); skipping DB integration tests", err)
		os.Exit(m.Run())
	}

	appPool, err = pgxpool.New(ctx, appURL)
	if err == nil {
		err = appPool.Ping(ctx)
	}
	if err != nil {
		dbSkip = fmt.Sprintf("cannot connect to app DB (%v); skipping DB integration tests", err)
		os.Exit(m.Run())
	}

	code := m.Run()
	adminPool.Close()
	appPool.Close()
	os.Exit(code)
}

// requireDB skips the calling test when no database is reachable.
func requireDB(t *testing.T) {
	t.Helper()
	if dbSkip != "" {
		t.Skip(dbSkip)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// loadDotEnv loads KEY=VALUE pairs from the api-root .env into the process
// environment (without overriding already-set values). Best-effort.
func loadDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	var envPath string
	for i := 0; i < 6; i++ {
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
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}
