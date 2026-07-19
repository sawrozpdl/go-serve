package db

// Tests for TxMiddleware's commit-error handling.
//
// These are DB-backed: TxMiddleware opens a real request-scoped transaction, and
// the behaviour under test (a failing statement aborts the tx, so Commit degrades
// to ROLLBACK and pgx surfaces pgx.ErrTxCommitRollback) only reproduces against a
// live Postgres. When no database is reachable the tests skip rather than fail,
// keeping `go test ./...` green on a machine with no DB.

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// capturingNotifier records whether an alert with a given name fired.
type capturingNotifier struct {
	names []string
}

func (c *capturingNotifier) Notify(_ context.Context, ev alert.Event) {
	c.names = append(c.names, ev.Name)
}

func (c *capturingNotifier) fired(name string) bool {
	for _, n := range c.names {
		if n == name {
			return true
		}
	}
	return false
}

// testPool lazily builds a pool from the env (walking up for the api-root .env,
// mirroring the api package harness) and skips the test if no DB is reachable.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	loadDotEnv()
	url := os.Getenv("APP_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("DATABASE_URL / APP_DATABASE_URL not set; skipping DB-backed test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err == nil {
		err = pool.Ping(ctx)
	}
	if err != nil {
		t.Skipf("cannot connect to DB (%v); skipping DB-backed test", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// abortTx runs a statement that always errors, which leaves the request-scoped
// transaction in an aborted state (Postgres aborts a tx on any error). The
// handler swallows the error — exactly what a handler does when it maps a DB
// constraint violation to a 4xx.
func abortTx(ctx context.Context) {
	_, _ = appctx.Tx(ctx).Exec(ctx, "SELECT 1/0")
}

// TestTxMiddleware_4xxAfterAbortedTx_NoCommitFailedAlert is the core of Fix A:
// a handler that aborts the tx then reports failure to the client (>=400) must
// NOT fire http.commit_failed — the client was already told it failed and
// nothing durable was lost, so paging on it is noise.
func TestTxMiddleware_4xxAfterAbortedTx_NoCommitFailedAlert(t *testing.T) {
	pool := testPool(t)
	cn := &capturingNotifier{}
	alert.SetDefault(cn)
	t.Cleanup(func() { alert.SetDefault(nil) })

	h := TxMiddleware(pool)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		abortTx(r.Context())
		w.WriteHeader(http.StatusConflict) // 409, as OpenOrder does on tab_already_open
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/orders", nil))

	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rr.Code)
	}
	if cn.fired("http.commit_failed") {
		t.Errorf("http.commit_failed fired for a 409 after an aborted tx; it must be suppressed")
	}
}

// TestTxMiddleware_2xxAfterAbortedTx_FiresCommitFailedAlert is the counter-test:
// if the handler aborts the tx but tells the client success (2xx), the commit
// degrades to rollback and the client believes a write that is gone — this is
// the genuine lost-write case the alert exists for, and it MUST still fire.
func TestTxMiddleware_2xxAfterAbortedTx_FiresCommitFailedAlert(t *testing.T) {
	pool := testPool(t)
	cn := &capturingNotifier{}
	alert.SetDefault(cn)
	t.Cleanup(func() { alert.SetDefault(nil) })

	h := TxMiddleware(pool)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		abortTx(r.Context())
		w.WriteHeader(http.StatusOK) // handler swallowed the error and claimed success
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/orders", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if !cn.fired("http.commit_failed") {
		t.Errorf("http.commit_failed did NOT fire for a 200 whose commit rolled back; the lost write is invisible")
	}
}

// TestTxMiddleware_CleanCommit_NoAlert guards the happy path: a normal request
// (no aborted tx) commits cleanly and fires nothing.
func TestTxMiddleware_CleanCommit_NoAlert(t *testing.T) {
	pool := testPool(t)
	cn := &capturingNotifier{}
	alert.SetDefault(cn)
	t.Cleanup(func() { alert.SetDefault(nil) })

	h := TxMiddleware(pool)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = appctx.Tx(r.Context()).Exec(r.Context(), "SELECT 1")
		w.WriteHeader(http.StatusOK)
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/anything", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if cn.fired("http.commit_failed") {
		t.Errorf("http.commit_failed fired for a clean commit")
	}
}

// loadDotEnv loads KEY=VALUE pairs from the api-root .env into the process
// environment (without overriding values already set), so the DB-backed tests
// find DATABASE_URL without the caller sourcing .env. Best-effort.
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
		val := strings.Trim(strings.TrimSpace(line[eq+1:]), `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}
