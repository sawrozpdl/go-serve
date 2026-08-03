// Package jobs runs the platform's scheduled background work — currently the
// nightly usage snapshot and the daily digest email to platform admins.
//
// Design notes:
//
//   - ONE goroutine with a ticker, not a cron library. There are two jobs and
//     both run once a day; a dependency would be more machinery than the
//     problem needs.
//
//   - Every run takes a Postgres ADVISORY LOCK first. The API is deployed as an
//     ECS service (docs/DEPLOY.md), so a rolling deploy or a scale-out means
//     two processes can be alive at once — without the lock they'd both send
//     the digest. The lock is session-scoped and released explicitly.
//
//   - The snapshot is idempotent (ON CONFLICT DO UPDATE) and the digest checks
//     a sent-marker, so a retry, a restart, or a manual trigger can't produce a
//     duplicate. This matters more than the lock: locks fail open, markers
//     don't.
//
//   - Failures go through alert.Fire. A digest that silently stops arriving is
//     worse than no digest, because you'd assume everything is fine.
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// advisoryLockKey is an arbitrary but STABLE 64-bit key. Changing it would let
// an old and a new deployment run concurrently during a rollout, so don't.
const advisoryLockKey int64 = 0x60_5e_47_e_01

// tickEvery is how often the scheduler wakes to check whether the daily work
// is due. Fine-grained enough that a process started at 08:59 still catches a
// 09:00 run, cheap enough to be irrelevant.
const tickEvery = 5 * time.Minute

// Config controls the scheduler. Zero value = disabled, so a dev machine never
// mails anybody by accident.
type Config struct {
	Enabled bool
	// Hour of the day (0–23) in Location at which the daily work runs.
	Hour int
	// Location is the platform's operating timezone — the digest should land
	// in the morning where the team actually is, not at UTC midnight.
	Location *time.Location
	// DigestFrom is the sender address; empty falls back to the mailer's.
	DigestFrom string
	// ConsoleURL is the base for deep links in the email, e.g.
	// "https://app.goserve.com.np". Empty renders links as plain text.
	ConsoleURL string
}

// Runner owns the schedule and the two jobs.
type Runner struct {
	pool   *pgxpool.Pool
	mailer *mail.Mailer
	cfg    Config
	log    *slog.Logger
}

func New(pool *pgxpool.Pool, mailer *mail.Mailer, cfg Config, log *slog.Logger) *Runner {
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	return &Runner{pool: pool, mailer: mailer, cfg: cfg, log: log}
}

// Start launches the scheduler until ctx is cancelled. Safe to call when
// disabled — it returns immediately.
func (r *Runner) Start(ctx context.Context) {
	if !r.cfg.Enabled {
		r.log.Info("jobs.disabled", "reason", "PLATFORM_JOBS_ENABLED is not set")
		return
	}
	r.log.Info("jobs.started", "hour", r.cfg.Hour, "tz", r.cfg.Location.String())
	go func() {
		t := time.NewTicker(tickEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				r.tick(ctx)
			}
		}
	}()
}

// tick runs the daily work if the local hour has arrived and it hasn't already
// run today.
func (r *Runner) tick(ctx context.Context) {
	now := time.Now().In(r.cfg.Location)
	if now.Hour() != r.cfg.Hour {
		return
	}
	// RunDaily's own markers make this safe even if the hour check lets several
	// ticks through — which it will, since the window is an hour wide.
	if err := r.RunDaily(ctx, false); err != nil {
		alert.Fire(ctx, slog.LevelError, "platform.daily_jobs_failed", err)
	}
}

// RunDaily performs the snapshot then the digest, under the advisory lock.
//
// force skips the already-ran markers — used by the manual trigger in the
// console so an admin can re-send after fixing a problem. It does NOT skip the
// lock: two admins hammering the button must still serialise.
func (r *Runner) RunDaily(ctx context.Context, force bool) error {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, advisoryLockKey).Scan(&got); err != nil {
		return err
	}
	if !got {
		// Another instance (or an overlapping tick) is already on it. Not an
		// error — this is the lock doing its job.
		r.log.Info("jobs.skipped", "reason", "another instance holds the lock")
		return nil
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, advisoryLockKey)
	}()

	// Snapshot first: the digest diffs today's statuses against yesterday's, so
	// it needs today's row to exist.
	day := time.Now().In(r.cfg.Location).AddDate(0, 0, -1)
	n, err := r.SnapshotDay(ctx, day)
	if err != nil {
		return err
	}
	r.log.Info("jobs.snapshot_done", "day", day.Format("2006-01-02"), "tenants", n)

	sent, err := r.SendDigest(ctx, force)
	if err != nil {
		return err
	}
	r.log.Info("jobs.digest", "sent", sent)
	return nil
}
