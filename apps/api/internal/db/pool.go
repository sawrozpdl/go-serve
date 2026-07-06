// Package db wraps the pgx connection pool and a per-request transaction
// middleware that sets app.tenant_id / app.user_id for RLS policies.
package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/respond"
)

// Open creates a configured pgxpool.
//
// Sizing: each tenant-scoped request can touch the pool a few times (tenant
// lookup, membership load, then the request tx), so the pool must be wide
// enough that a small burst of concurrent requests never queues waiting for a
// connection. Postgres' default max_connections is 100; a single API instance
// at 25 leaves ample room for migrations/seed/ops. Override with DB_MAX_CONNS.
//
// Safety timeouts are applied to every pooled connection so a single bad query
// or a transaction left open can't pin a connection (and starve everyone else)
// indefinitely — the previous config had none, which let a stuck request hang
// for ~60s while the pool drained.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = envInt("DB_MAX_CONNS", 25)
	cfg.MinConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	// Per-connection guardrails (sent as startup params, applied to every
	// connection in the pool). Tunable via env for prod.
	//   statement_timeout                  — cap any single query
	//   lock_timeout                       — don't wait forever on a row/table lock
	//   idle_in_transaction_session_timeout — reap a tx left open mid-handler
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	setParam(cfg, "statement_timeout", "DB_STATEMENT_TIMEOUT_MS", "15000")
	setParam(cfg, "lock_timeout", "DB_LOCK_TIMEOUT_MS", "5000")
	setParam(cfg, "idle_in_transaction_session_timeout", "DB_IDLE_TX_TIMEOUT_MS", "30000")

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("new pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// setParam sets a Postgres GUC on every pooled connection, reading an override
// (in milliseconds) from env when present.
func setParam(cfg *pgxpool.Config, guc, env, defMillis string) {
	v := defMillis
	if e := os.Getenv(env); e != "" {
		v = e
	}
	cfg.ConnConfig.RuntimeParams[guc] = v
}

func envInt(key string, def int32) int32 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return int32(n)
		}
	}
	return def
}

// TxMiddleware wraps every request in a Postgres transaction with
// app.tenant_id and app.user_id set from context (whatever earlier middleware
// resolved). RLS policies read those settings.
//
// Behavior:
//   - 2xx, 3xx, 4xx → COMMIT
//   - 5xx, panic    → ROLLBACK
//
// Read-only handlers commit too; that's a no-op for SELECT-only transactions.
func TxMiddleware(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				// respond.Err (not http.Error) so the real pg/pool error is
				// captured onto the request writer and rides the 5xx alert +
				// log line instead of vanishing behind a bare "begin tx".
				respond.Err(w, http.StatusInternalServerError, "internal_error", fmt.Errorf("begin tx: %w", err).Error())
				return
			}
			committed := false
			defer func() {
				if !committed {
					_ = tx.Rollback(context.Background())
				}
			}()

			if t, ok := appctx.TenantFromContext(ctx); ok && t.ID != uuid.Nil {
				if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", t.ID.String()); err != nil {
					respond.Err(w, http.StatusInternalServerError, "internal_error", fmt.Errorf("set tenant: %w", err).Error())
					return
				}
			}
			if u, ok := appctx.UserFromContext(ctx); ok && u.ID != uuid.Nil {
				if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", u.ID.String()); err != nil {
					respond.Err(w, http.StatusInternalServerError, "internal_error", fmt.Errorf("set user: %w", err).Error())
					return
				}
			}

			ww := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			hctx := appctx.WithPostCommit(appctx.WithTx(ctx, tx))
			next.ServeHTTP(ww, r.WithContext(hctx))

			if ww.status >= 500 {
				return // rollback via defer
			}
			if err := tx.Commit(ctx); err != nil && !errors.Is(err, context.Canceled) {
				// The handler already wrote a 2xx/4xx to the client, but the
				// commit failed and the defer will roll everything back — the
				// caller thinks the write succeeded while the data is gone. We
				// can't change the response now, but this MUST NOT be silent:
				// surface it so a lost write is investigable, not invisible.
				alert.Fire(ctx, slog.LevelError, "http.commit_failed", err,
					"method", r.Method, "path", r.URL.Path, "status", ww.status)
				return
			}
			committed = true
			// Run realtime broadcasts and other post-commit hooks only after the
			// row is durably visible. Firing before commit races refetching
			// subscribers (which would see pre-commit state via their own tx).
			appctx.RunPostCommit(hctx)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
		s.ResponseWriter.WriteHeader(code)
	}
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

// Hijacker passthrough so WebSocket upgrades work inside the middleware chain.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
