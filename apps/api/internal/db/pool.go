// Package db wraps the pgx connection pool and a per-request transaction
// middleware that sets app.tenant_id / app.user_id for RLS policies.
package db

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// Open creates a configured pgxpool.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MinConns = 1
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
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
				http.Error(w, "begin tx", http.StatusInternalServerError)
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
					http.Error(w, "set tenant", http.StatusInternalServerError)
					return
				}
			}
			if u, ok := appctx.UserFromContext(ctx); ok && u.ID != uuid.Nil {
				if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", u.ID.String()); err != nil {
					http.Error(w, "set user", http.StatusInternalServerError)
					return
				}
			}

			ww := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(ww, r.WithContext(appctx.WithTx(ctx, tx)))

			if ww.status >= 500 {
				return // rollback via defer
			}
			if err := tx.Commit(ctx); err != nil && !errors.Is(err, context.Canceled) {
				// Already responded; can't change status. Log via defer rollback.
				return
			}
			committed = true
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
