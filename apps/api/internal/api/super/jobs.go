package super

import (
	"context"
	"net/http"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// JobRunner is the slice of internal/jobs the console needs. An interface, not
// the concrete type, so the super package doesn't depend on the job internals
// and the handlers stay testable with a stub.
type JobRunner interface {
	SnapshotDay(ctx context.Context, day time.Time) (int, error)
	SendDigest(ctx context.Context, force bool) (bool, error)
}

// RunSnapshot — POST /v1/super/jobs/snapshot.
//
// Recomputes yesterday's health snapshot on demand. Idempotent, so this is the
// safe thing to reach for after fixing whatever made a run fail: it overwrites
// rather than duplicating.
func RunSnapshot(runner JobRunner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if runner == nil {
			writeErr(w, http.StatusServiceUnavailable, "jobs_unavailable", "the job runner is not configured")
			return
		}
		day := time.Now().AddDate(0, 0, -1)
		n, err := runner.SnapshotDay(r.Context(), day)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		logPlatform(r, appctx.Tx(r.Context()), audit.PlatformEntry{
			Action: "platform.snapshot_run", TargetID: day.Format("2006-01-02"),
			Summary: "recomputed the usage snapshot", Meta: map[string]any{"tenants": n},
		})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenants": n, "day": day.Format("2006-01-02")})
	}
}

// RunDigest — POST /v1/super/jobs/run-digest.
//
// Sends today's digest even if it already went out (force), so an admin can
// re-send after correcting something. Reports `sent: false` with a reason when
// there was genuinely nothing to say — a digest that arrives every morning
// saying "nothing happened" is a digest people stop reading.
func RunDigest(runner JobRunner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if runner == nil {
			writeErr(w, http.StatusServiceUnavailable, "jobs_unavailable", "the job runner is not configured")
			return
		}
		sent, err := runner.SendDigest(r.Context(), true)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if sent {
			logPlatform(r, appctx.Tx(r.Context()), audit.PlatformEntry{
				Action: "platform.digest_manual", Summary: "manually sent the daily digest",
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sent": sent})
	}
}

// LastDigestRun — GET /v1/super/jobs/status. When the digest last went out, so
// the console can show "last sent 8:02 this morning" rather than leaving the
// admin to guess whether the schedule is alive.
func LastDigestRun(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	var lastAt *time.Time
	var lastDay *string
	if err := tx.QueryRow(r.Context(), `
		SELECT created_at, target_id FROM platform_audit
		WHERE action = 'platform.digest_sent'
		ORDER BY created_at DESC LIMIT 1
	`).Scan(&lastAt, &lastDay); err != nil {
		// No row yet is the normal state on a fresh install, not an error.
		writeJSON(w, http.StatusOK, map[string]any{"last_sent_at": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"last_sent_at": lastAt, "last_sent_for": lastDay})
}
