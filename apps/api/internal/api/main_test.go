package api

// Shared test harness for the api package.
//
// Strategy: these are *integration* tests that run real handlers against the
// real local Postgres `cafe` database. Two connection pools are used, mirroring
// production:
//
//   - admin pool (DATABASE_URL, superuser) — bypasses RLS, used only to seed
//     and tear down fixtures.
//   - app pool   (APP_DATABASE_URL, app_user, NOBYPASSRLS) — used to run the
//     handler under test, so RLS policies AND table grants are exercised
//     exactly as they are in the live API. Missing GRANTs therefore fail here
//     rather than silently passing (see memory: db_grants_gotcha).
//
// Each test creates its own throwaway tenant + owner user and registers a
// cleanup that deletes the tenant (CASCADE wipes every child table) and the
// user. Handlers are invoked through callHandler, which wraps the call in an
// app-pool transaction with app.tenant_id / app.user_id set — the same context
// db.TxMiddleware builds at runtime.
//
// If APP_DATABASE_URL / DATABASE_URL are not set (and no .env is found), every
// DB-backed test skips rather than failing, so `go test ./...` stays green on a
// machine with no database.

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
// environment (without overriding values already set), so `go test ./...`
// works without the caller manually sourcing .env. Best-effort: missing file
// is fine.
func loadDotEnv() {
	// Walk up from the package dir to find the api-root .env (where go.mod lives).
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
