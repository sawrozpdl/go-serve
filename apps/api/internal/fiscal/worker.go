package fiscal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
)

// CBMSWorker drains the cbms_submissions outbox.
//
//   - Kicked right after a settle commits (so a bill normally reaches CBMS
//     within a second of issue), and on a ticker for retries.
//   - Finds due rows across tenants through cbms_due_submissions() (ids only),
//     then works each in a transaction scoped to its own tenant, taking the
//     row with FOR UPDATE SKIP LOCKED so two API processes never post the same
//     document at once.
//   - Bills are idempotent at CBMS (101 = already there). Returns are not, so a
//     return is re-posted only after a transport failure, when CBMS never saw it
//     or never answered.
type CBMSWorker struct {
	Pool     *pgxpool.Pool
	Client   cbms.Client
	Interval time.Duration // ticker for retries; default 30s
	// RealtimeWindow: a post within this long of issue is reported as
	// real-time (isrealtime=true). IRD gives no tolerance; 5 minutes is the
	// convention other listed vendors use.
	RealtimeWindow time.Duration
	Log            *slog.Logger
	// OnlyTenant, when set, limits a pass to one café's submissions. Tests
	// use it so a pass never touches another café's rows in a shared
	// database; production leaves it zero (all cafés).
	OnlyTenant uuid.UUID
	kick       chan struct{}
	now        func() time.Time
}

// NewCBMSWorker builds a worker.
func NewCBMSWorker(pool *pgxpool.Pool, client cbms.Client, log *slog.Logger) *CBMSWorker {
	if log == nil {
		log = slog.Default()
	}
	return &CBMSWorker{
		Pool: pool, Client: client, Interval: 30 * time.Second, RealtimeWindow: 5 * time.Minute,
		Log: log, kick: make(chan struct{}, 1), now: time.Now,
	}
}

// Kick asks for an immediate pass; never blocks.
func (w *CBMSWorker) Kick() {
	select {
	case w.kick <- struct{}{}:
	default:
	}
}

// Run loops until ctx ends.
func (w *CBMSWorker) Run(ctx context.Context) {
	if w.Client.Name() == "live" {
		w.requeueMockSynced(ctx)
	}
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	for {
		if _, err := w.RunOnce(ctx); err != nil && ctx.Err() == nil {
			alert.Fire(ctx, slog.LevelError, "cbms.worker_pass_failed", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-w.kick:
		}
	}
}

func (w *CBMSWorker) requeueMockSynced(ctx context.Context) {
	var n int
	if err := w.Pool.QueryRow(ctx, `SELECT cbms_requeue_mock_synced()`).Scan(&n); err != nil {
		alert.Fire(ctx, slog.LevelError, "cbms.requeue_mock_failed", err)
		return
	}
	if n > 0 {
		w.Log.Warn("cbms.requeued_mock_synced", "count", n)
	}
}

// RunOnce posts every due submission once. Returns how many it attempted.
func (w *CBMSWorker) RunOnce(ctx context.Context) (int, error) {
	rows, err := w.Pool.Query(ctx, `SELECT id, tenant_id FROM cbms_due_submissions(100)`)
	if err != nil {
		return 0, err
	}
	type due struct{ id, tenant uuid.UUID }
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.tenant); err != nil {
			rows.Close()
			return 0, err
		}
		list = append(list, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	for _, d := range list {
		if w.OnlyTenant != uuid.Nil && d.tenant != w.OnlyTenant {
			continue
		}
		if ctx.Err() != nil {
			return n, ctx.Err()
		}
		if err := w.process(ctx, d.tenant, d.id); err != nil {
			alert.Fire(ctx, slog.LevelError, "cbms.submission_error", err, "submission_id", d.id.String(), "tenant_id", d.tenant.String())
		}
		n++
	}
	return n, nil
}

// backoff after the n-th failed attempt: 30s, 1m, 2m, 4m … capped at 6h.
func backoff(attempt int) time.Duration {
	d := 30 * time.Second
	for i := 1; i < attempt && d < 6*time.Hour; i++ {
		d *= 2
	}
	if d > 6*time.Hour {
		d = 6 * time.Hour
	}
	return d
}

// maxContentFailures: a document CBMS keeps rejecting on content (102–104)
// stops being retried and is flagged for a human.
const maxContentFailures = 5

func (w *CBMSWorker) process(ctx context.Context, tenantID, id uuid.UUID) error {
	tx, err := w.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
		return err
	}

	var (
		docType, endpoint string
		issuedAt          time.Time
		payload           []byte
		attempts          int
	)
	err = tx.QueryRow(ctx, `
		SELECT doc_type, endpoint, issued_at, payload, attempts
		FROM cbms_submissions
		WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now()
		FOR UPDATE SKIP LOCKED
	`, id).Scan(&docType, &endpoint, &issuedAt, &payload, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // another process has it, or it is no longer due
	}
	if err != nil {
		return err
	}

	prof, err := LoadProfile(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	park := func(after time.Duration, msg string) error {
		if _, err := tx.Exec(ctx, `
			UPDATE cbms_submissions SET next_attempt_at = now() + $2::interval, last_error = $3 WHERE id = $1
		`, id, fmt.Sprintf("%d seconds", int(after.Seconds())), msg); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if !prof.CBMSEnabled {
		// Not lost: it waits, and posts (non-real-time) once the café enters
		// its IRD login. Saving credentials re-queues immediately.
		return park(time.Hour, "CBMS is not set up for this café yet (Settings → Tax & IRD)")
	}

	creds := cbms.Credentials{Username: prof.CBMSUsername, SellerPAN: prof.PAN}
	if w.Client.Name() == "live" {
		key, err := keyFor(prof.CBMSKeyID)
		if err == nil {
			creds.Password, err = openSecret(key, prof.CBMSPasswordEnc, tenantID.String())
		}
		if err != nil {
			alert.Fire(ctx, slog.LevelError, "cbms.credentials_unreadable", err, "tenant_id", tenantID.String())
			return park(time.Hour, err.Error())
		}
	}

	now := w.now()
	env := cbms.Envelope{
		Endpoint:       cbms.Endpoint(endpoint),
		Creds:          creds,
		Document:       json.RawMessage(payload),
		IsRealtime:     now.Sub(issuedAt) <= w.RealtimeWindow,
		DatetimeClient: now.In(bsdate.Nepal).Format("2006-01-02T15:04:05"),
	}
	res, postErr := w.Client.Post(ctx, env)
	attempts++

	switch {
	case postErr != nil:
		// Never judged by CBMS: retry, forever, with backoff. Alert once it has
		// been failing for a while so a long IRD outage is visible.
		if attempts == 6 {
			alert.Fire(ctx, slog.LevelWarn, "cbms.unreachable", postErr, "tenant_id", tenantID.String(), "submission_id", id.String())
		}
		_, err = tx.Exec(ctx, `
			UPDATE cbms_submissions
			SET attempts = $2, last_code = NULL, last_error = $3, next_attempt_at = now() + $4::interval
			WHERE id = $1
		`, id, attempts, truncateErr(postErr.Error()), fmt.Sprintf("%d seconds", int(backoff(attempts).Seconds())))

	case res.Synced(cbms.Endpoint(endpoint)):
		_, err = tx.Exec(ctx, `
			UPDATE cbms_submissions
			SET status = 'synced', attempts = $2, last_code = $3, last_error = '', synced_at = now(),
			    synced_via = $4, is_realtime = $5
			WHERE id = $1
		`, id, attempts, res.Code, w.Client.Name(), env.IsRealtime)

	case res.Code == cbms.CodeBadCredentials:
		alert.Fire(ctx, slog.LevelError, "cbms.bad_credentials", nil, "tenant_id", tenantID.String())
		_, err = tx.Exec(ctx, `
			UPDATE cbms_submissions
			SET attempts = $2, last_code = $3, last_error = 'IRD rejected the CBMS login — update it in Settings → Tax & IRD',
			    next_attempt_at = now() + interval '1 hour'
			WHERE id = $1
		`, id, attempts, res.Code)

	case endpoint == string(cbms.EndpointBillReturn) && (res.Code == cbms.CodeBillNotFound || res.Code == cbms.CodeDuplicate):
		// The referenced bill is not on CBMS yet (its own submission may still
		// be queued). Wait for it; this is not the return's fault.
		_, err = tx.Exec(ctx, `
			UPDATE cbms_submissions
			SET attempts = $2, last_code = $3, last_error = 'waiting for the original bill to reach CBMS',
			    next_attempt_at = now() + $4::interval
			WHERE id = $1
		`, id, attempts, res.Code, fmt.Sprintf("%d seconds", int(backoff(attempts).Seconds())))

	default:
		// 102 / 103 / 104: CBMS judged the content. Retry a few times (102/103
		// can be transient on IRD's side), then stop and flag it.
		status := "pending"
		if attempts >= maxContentFailures {
			status = "failed"
			alert.Fire(ctx, slog.LevelError, "cbms.rejected", fmt.Errorf("code %d: %s", res.Code, res.Raw),
				"tenant_id", tenantID.String(), "submission_id", id.String())
		}
		_, err = tx.Exec(ctx, `
			UPDATE cbms_submissions
			SET status = $2, attempts = $3, last_code = $4, last_error = $5, next_attempt_at = now() + $6::interval
			WHERE id = $1
		`, id, status, attempts, res.Code, "CBMS answered "+res.Raw, fmt.Sprintf("%d seconds", int(backoff(attempts).Seconds())))
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func truncateErr(s string) string {
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
