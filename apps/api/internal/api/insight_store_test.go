package api

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/insight"
)

// Persistence tests. Everything here runs through the APP pool, because
// insight/store.go has no tenant_id predicate anywhere — it relies entirely on
// RLS and on current_tenant_id() in the INSERT. A missing GRANT or a broken
// policy fails here and nowhere else.

func day(offset int) time.Time {
	return time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC).AddDate(0, 0, offset)
}

func mkFinding(key, subject string, sev insight.Severity, metric float64) insight.Finding {
	return insight.Finding{
		DetectorKey: key, SubjectKind: insight.SubjectTenant, SubjectKey: subject,
		SubjectLabel: "Label " + subject, Severity: sev,
		Detail: "sentence for " + subject, MetricValue: metric, Unit: insight.UnitCents,
		Facts: map[string]any{"k": 1},
	}
}

// storeAsApp runs one nightly reconciliation as the app role.
func storeAsApp(t *testing.T, fx *fixture, d time.Time, fs []insight.Finding) map[string]uuid.UUID {
	t.Helper()
	var ids map[string]uuid.UUID
	err := fx.appTx(func(tx pgx.Tx) error {
		var err error
		if ids, err = insight.Store(context.Background(), tx, d, fs); err != nil {
			return err
		}
		_, err = insight.CloseStale(context.Background(), tx, d)
		return err
	})
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	return ids
}

func TestInsightStore_CreatesFindingAndObservation(t *testing.T) {
	fx := newTenant(t)
	// A single transaction, because appTx rolls back — so assertions have to
	// happen inside it.
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		ids, err := insight.Store(ctx, tx, day(0), []insight.Finding{
			mkFinding("void_rate", "", insight.SeverityWarn, 1234),
		})
		if err != nil {
			return err
		}
		if len(ids) != 1 {
			t.Fatalf("got %d ids, want 1", len(ids))
		}

		var state, detail string
		var first, last time.Time
		if err := tx.QueryRow(ctx, `
			SELECT f.state, f.first_seen_on, f.last_seen_on, o.detail
			FROM insight_findings f
			JOIN insight_observations o ON o.finding_id = f.id
			WHERE f.detector_key = 'void_rate'`).Scan(&state, &first, &last, &detail); err != nil {
			return err
		}
		if state != "new" {
			t.Errorf("state = %q, want new", state)
		}
		if !first.Equal(last) {
			t.Errorf("first_seen_on %v != last_seen_on %v on a brand-new finding", first, last)
		}
		if detail != "sentence for " {
			t.Errorf("observation detail = %q", detail)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// THE most important persistence property. A dismissed finding must stay
// dismissed even though the detector keeps firing every single night — that is
// the entire reason the schema keeps one durable row per finding instead of one
// row per day.
func TestInsightStore_DismissalSurvivesNightlyReruns(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		f := mkFinding("void_rate", "", insight.SeverityWarn, 100)

		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{f}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE insight_findings SET state='dismissed', dismissed_at=now()
			WHERE detector_key='void_rate'`); err != nil {
			return err
		}

		// Three more nights of the same problem.
		for i := 1; i <= 3; i++ {
			f.MetricValue = float64(100 + i)
			if _, err := insight.Store(ctx, tx, day(i), []insight.Finding{f}); err != nil {
				return err
			}
		}

		var state string
		var rows, obs int
		if err := tx.QueryRow(ctx, `SELECT state FROM insight_findings WHERE detector_key='void_rate'`).
			Scan(&state); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM insight_findings`).Scan(&rows); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM insight_observations`).Scan(&obs); err != nil {
			return err
		}

		if state != "dismissed" {
			t.Errorf("state = %q after three re-runs, want dismissed — the upsert must never write state", state)
		}
		if rows != 1 {
			t.Errorf("%d finding rows, want 1 — re-running must not duplicate the finding", rows)
		}
		// But the numbers keep being recorded, so "did it move" still works.
		if obs != 4 {
			t.Errorf("%d observations, want 4 — one per day", obs)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A second run on the same local day must overwrite, not fail, so a manual
// re-trigger of the nightly job is safe.
func TestInsightStore_SameDayRerunIsIdempotent(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		f := mkFinding("void_rate", "", insight.SeverityWarn, 100)
		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{f}); err != nil {
			return err
		}
		f.MetricValue = 999
		f.Detail = "corrected sentence"
		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{f}); err != nil {
			return err
		}

		var n int
		var metric float64
		var detail string
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM insight_observations`).Scan(&n); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`SELECT metric_value, detail FROM insight_observations`).Scan(&metric, &detail); err != nil {
			return err
		}
		if n != 1 {
			t.Errorf("%d observations for one day, want 1", n)
		}
		if metric != 999 || detail != "corrected sentence" {
			t.Errorf("second run did not overwrite: metric=%v detail=%q", metric, detail)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A problem the café FIXED must disappear on its own. Nobody should have to tell
// us they fixed it.
func TestInsightStore_CloseStaleRetiresSolvedProblems(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{
			mkFinding("void_rate", "", insight.SeverityWarn, 100),
			mkFinding("dead_items", "", insight.SeverityWarn, 9),
		}); err != nil {
			return err
		}

		// Next night only one of them is still true.
		if _, err := insight.Store(ctx, tx, day(1), []insight.Finding{
			mkFinding("void_rate", "", insight.SeverityWarn, 90),
		}); err != nil {
			return err
		}
		closed, err := insight.CloseStale(ctx, tx, day(1))
		if err != nil {
			return err
		}
		if closed != 1 {
			t.Errorf("closed %d findings, want 1", closed)
		}

		var state string
		if err := tx.QueryRow(ctx,
			`SELECT state FROM insight_findings WHERE detector_key='dead_items'`).Scan(&state); err != nil {
			return err
		}
		if state != "closed" {
			t.Errorf("solved finding state = %q, want closed", state)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A problem that comes back long after being closed gets a FRESH row and a fresh
// lifecycle, rather than reopening an argument the owner already settled.
func TestInsightStore_RecurrenceAfterCloseStartsANewRow(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		f := mkFinding("void_rate", "", insight.SeverityWarn, 100)

		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{f}); err != nil {
			return err
		}
		if _, err := insight.Store(ctx, tx, day(1), nil); err != nil {
			return err
		}
		if _, err := insight.CloseStale(ctx, tx, day(1)); err != nil {
			return err
		}
		// It comes back a month later.
		if _, err := insight.Store(ctx, tx, day(30), []insight.Finding{f}); err != nil {
			return err
		}

		var total, open int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM insight_findings`).Scan(&total); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM insight_findings WHERE state <> 'closed'`).Scan(&open); err != nil {
			return err
		}
		if total != 2 || open != 1 {
			t.Errorf("total=%d open=%d, want 2 and 1 — a recurrence is a new lifecycle", total, open)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Three dismissals mute a detector — the whole of "it learns what you care
// about", done deterministically. Crucially it must keep working after the rows
// are CLOSED, which is why 0068 never clears dismissed_at.
func TestInsightStore_MutingCountsDismissalsEvenAfterClosing(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		for i := 0; i < insight.DismissalsToMute; i++ {
			// A different subject each time, so each is its own finding.
			f := mkFinding("dead_items", string(rune('a'+i)), insight.SeverityWarn, 1)
			if _, err := insight.Store(ctx, tx, day(i), []insight.Finding{f}); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE insight_findings SET state='dismissed', dismissed_at=now()
				WHERE subject_key=$1`, string(rune('a'+i))); err != nil {
				return err
			}
		}

		muted, err := insight.MutedDetectors(ctx, tx)
		if err != nil {
			return err
		}
		if !muted["dead_items"] {
			t.Fatalf("dead_items should be muted after %d dismissals, got %v",
				insight.DismissalsToMute, muted)
		}

		// Now close them all, as CloseStale eventually would. The mute must hold.
		if _, err := tx.Exec(ctx,
			`UPDATE insight_findings SET state='closed', closed_at=now()`); err != nil {
			return err
		}
		muted, err = insight.MutedDetectors(ctx, tx)
		if err != nil {
			return err
		}
		if !muted["dead_items"] {
			t.Error("muting must survive closing — dismissed_at is never cleared for exactly this reason")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestInsightStore_MutingNeedsEnoughDismissals(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		f := mkFinding("dead_items", "x", insight.SeverityWarn, 1)
		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{f}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE insight_findings SET state='dismissed', dismissed_at=now()`); err != nil {
			return err
		}
		muted, err := insight.MutedDetectors(ctx, tx)
		if err != nil {
			return err
		}
		if muted["dead_items"] {
			t.Error("one dismissal must not mute a detector")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// "Did the number move?" must be a query over real observations, never a diff
// frozen at accept time — a stored diff would be wrong the moment the detector
// ran again, which is every night.
func TestInsightStore_FollowUpComparesAcceptedDayAgainstToday(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		f := mkFinding("void_rate", "", insight.SeverityBad, 5000)
		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{f}); err != nil {
			return err
		}
		// The owner accepts it on day 0, to review a week later.
		if _, err := tx.Exec(ctx, `
			UPDATE insight_findings
			SET state='accepted', accepted_at=now(), accepted_by_user_id=$1,
			    accepted_on=$2, follow_up_on=$3, note='talk to the kitchen'
			WHERE detector_key='void_rate'`, fx.User, day(0), day(7)); err != nil {
			return err
		}
		// It improves over the week.
		f.MetricValue = 1200
		f.Detail = "much better now"
		if _, err := insight.Store(ctx, tx, day(7), []insight.Finding{f}); err != nil {
			return err
		}

		due, err := insight.DueFollowUps(ctx, tx, day(7))
		if err != nil {
			return err
		}
		if len(due) != 1 {
			t.Fatalf("got %d due follow-ups, want 1", len(due))
		}
		fu := due[0]
		if fu.Then != 5000 || fu.Now != 1200 {
			t.Errorf("then=%v now=%v, want 5000 and 1200", fu.Then, fu.Now)
		}
		if fu.Note != "talk to the kitchen" {
			t.Errorf("note = %q", fu.Note)
		}
		// Today's sentence, not a stale quote from the day it was accepted.
		if fu.Detail != "much better now" {
			t.Errorf("detail = %q, want today's sentence", fu.Detail)
		}
		if !fu.Improved(false) {
			t.Error("a fall from 5000 to 1200 must read as an improvement")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestInsightStore_FollowUpNotDueYetIsNotReturned(t *testing.T) {
	fx := newTenant(t)
	err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		if _, err := insight.Store(ctx, tx, day(0), []insight.Finding{
			mkFinding("void_rate", "", insight.SeverityBad, 5000)}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE insight_findings
			SET state='accepted', accepted_at=now(), accepted_on=$1, follow_up_on=$2`,
			day(0), day(7)); err != nil {
			return err
		}
		due, err := insight.DueFollowUps(ctx, tx, day(3))
		if err != nil {
			return err
		}
		if len(due) != 0 {
			t.Errorf("got %d follow-ups on day 3, want 0 — it is not due until day 7", len(due))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
