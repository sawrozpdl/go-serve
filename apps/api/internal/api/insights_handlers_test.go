package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/insight"
)

// newInsightTenant is newTenant plus the owner role IN THE DATABASE.
//
// ListInsights filters its own output by the viewer's real grant set — that is
// the entire permission model for findings — so a fixture whose roles exist only
// in the request context would correctly see nothing at all. This is the same
// gap grantRole's own comment warns about.
func newInsightTenant(t *testing.T) *fixture {
	t.Helper()
	fx := newTenant(t)
	fx.grantRole(fx.User, "owner")
	// grantRole links the role but writes no role_permissions — in production
	// rbac.SeedSystemRoles fills those from permissions.json at provisioning.
	// Without this the owner role has zero grants and the list is correctly, but
	// unhelpfully, empty.
	fx.adminExec(`
		INSERT INTO role_permissions (role_id, permission)
		SELECT id, '*:*' FROM roles WHERE tenant_id = $1 AND key = 'owner'
		ON CONFLICT DO NOTHING`, fx.Tenant)
	return fx
}

// seedFinding writes one finding + today's observation directly, so handler tests
// do not have to manufacture a café whose real data trips a detector.
func seedFinding(t *testing.T, fx *fixture, detectorKey string, sev insight.Severity, metric float64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO insight_findings
		  (tenant_id, detector_key, subject_kind, subject_key, subject_label,
		   severity, deep_link, state, first_seen_on, last_seen_on)
		VALUES ($1, $2, 'tenant', '', 'Subject '||$2, $3, '/admin/x', 'new',
		        CURRENT_DATE, CURRENT_DATE)
		RETURNING id`, fx.Tenant, detectorKey, string(sev))
	fx.adminExec(`
		INSERT INTO insight_observations
		  (tenant_id, finding_id, day, severity, metric_value, metric_unit, detail, facts)
		VALUES ($1, $2, CURRENT_DATE, $3, $4, 'cents', 'the sentence for '||$5, '{}')`,
		fx.Tenant, id, string(sev), metric, detectorKey)
	return id
}

func listInsights(t *testing.T, fx *fixture) map[string]any {
	t.Helper()
	return callHandler(t, fx, ListInsights, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json()
}

func TestListInsights_ReturnsOpenFindingsWorstFirst(t *testing.T) {
	fx := newInsightTenant(t)
	// dead_items is last in the registry; integrity is first. Severity wins over
	// both, so the `bad` dead_items must lead.
	seedFinding(t, fx, "integrity", insight.SeverityWarn, 100)
	seedFinding(t, fx, "dead_items", insight.SeverityBad, 5)

	got := listInsights(t, fx)["insights"].([]any)
	if len(got) != 2 {
		t.Fatalf("got %d insights, want 2", len(got))
	}
	first := got[0].(map[string]any)
	if first["detector_key"] != "dead_items" || first["severity"] != "bad" {
		t.Errorf("first = %v/%v, want dead_items/bad", first["detector_key"], first["severity"])
	}
	// The sentence has to come through — it is the product.
	if first["detail"] != "the sentence for dead_items" {
		t.Errorf("detail = %v", first["detail"])
	}
	// And the detector's human label, resolved from the registry.
	if first["label"] != "Menu items nobody orders" {
		t.Errorf("label = %v", first["label"])
	}
}

// The list is filtered PER RECIPIENT by the permission each detector declares.
// This is the whole permission model for findings — there is no second one.
func TestListInsights_FiltersByTheDetectorsOwnPermission(t *testing.T) {
	fx := newInsightTenant(t)
	seedFinding(t, fx, "void_rate", insight.SeverityWarn, 100)      // report:read
	seedFinding(t, fx, "shift_discipline", insight.SeverityWarn, 2) // shift:read

	// A member holding only shift:read must see exactly one of them.
	limited := fx.addUser("Drawer Only")
	fx.grantRole(limited, "kitchen")
	fx.adminExec(`
		INSERT INTO role_permissions (role_id, permission)
		SELECT id, 'shift:read' FROM roles WHERE tenant_id = $1 AND key = 'kitchen'
		ON CONFLICT DO NOTHING`, fx.Tenant)

	got := callHandler(t, fx, ListInsights, http.MethodGet, "/", nil, actingAs(limited)).
		expectStatus(http.StatusOK).json()["insights"].([]any)

	if len(got) != 1 {
		for _, g := range got {
			t.Logf("saw %v", g.(map[string]any)["detector_key"])
		}
		t.Fatalf("got %d insights for a shift-only member, want 1", len(got))
	}
	if got[0].(map[string]any)["detector_key"] != "shift_discipline" {
		t.Errorf("wrong finding survived: %v", got[0])
	}
}

func TestListInsights_HidesDismissedAndClosed(t *testing.T) {
	fx := newInsightTenant(t)
	keep := seedFinding(t, fx, "void_rate", insight.SeverityWarn, 100)
	gone := seedFinding(t, fx, "dead_items", insight.SeverityWarn, 5)
	closed := seedFinding(t, fx, "integrity", insight.SeverityBad, 1)
	fx.adminExec(`UPDATE insight_findings SET state='dismissed', dismissed_at=now() WHERE id=$1`, gone)
	fx.adminExec(`UPDATE insight_findings SET state='closed', closed_at=now() WHERE id=$1`, closed)

	got := listInsights(t, fx)["insights"].([]any)
	if len(got) != 1 || got[0].(map[string]any)["id"] != keep.String() {
		t.Fatalf("got %d insights, want only the open one", len(got))
	}
}

// A snooze is "not now", so it comes back on its own once the date passes.
func TestListInsights_SnoozedReturnsWhenTheDatePasses(t *testing.T) {
	fx := newInsightTenant(t)
	id := seedFinding(t, fx, "void_rate", insight.SeverityWarn, 100)

	fx.adminExec(`UPDATE insight_findings SET state='snoozed', snoozed_until=CURRENT_DATE+7 WHERE id=$1`, id)
	if got := listInsights(t, fx)["insights"].([]any); len(got) != 0 {
		t.Fatalf("a snoozed finding must be hidden, got %d", len(got))
	}

	fx.adminExec(`UPDATE insight_findings SET snoozed_until=CURRENT_DATE WHERE id=$1`, id)
	if got := listInsights(t, fx)["insights"].([]any); len(got) != 1 {
		t.Fatalf("a snooze that has expired must come back, got %d", len(got))
	}
}

func TestListInsights_MutedDetectorDisappears(t *testing.T) {
	fx := newInsightTenant(t)
	// Three dismissals of dead_items, each its own finding.
	for i := 0; i < insight.DismissalsToMute; i++ {
		fx.adminExec(`
			INSERT INTO insight_findings
			  (tenant_id, detector_key, subject_kind, subject_key, subject_label,
			   severity, state, dismissed_at, first_seen_on, last_seen_on)
			VALUES ($1, 'dead_items', 'tenant', $2, 'x', 'warn', 'dismissed', now(),
			        CURRENT_DATE, CURRENT_DATE)`, fx.Tenant, uuid.NewString())
	}
	// A fresh, open one now arrives.
	seedFinding(t, fx, "dead_items", insight.SeverityWarn, 9)
	seedFinding(t, fx, "void_rate", insight.SeverityWarn, 100)

	got := listInsights(t, fx)["insights"].([]any)
	if len(got) != 1 || got[0].(map[string]any)["detector_key"] != "void_rate" {
		t.Fatalf("a muted detector must stay hidden even when it fires again; got %d rows", len(got))
	}
}

func TestListInsights_ReportsBooksConfidence(t *testing.T) {
	fx := newInsightTenant(t)
	// A café with nothing recorded has no confidence figure. Null is the honest
	// answer; 0% would read as an accusation.
	if v := listInsights(t, fx)["books_confidence"]; v != nil {
		t.Errorf("books_confidence = %v for an empty café, want null", v)
	}

	// Give it a trading day with a fully costed sale.
	cat := fx.seedCategory("ConfCat")
	item := fx.seedMenuItem(cat, "ConfItem", 10_000)
	shift := fx.seedOpenShift(1_000)
	order := fx.seedOpenOrder(nil)
	line := fx.seedOrderItem(order, item, 1, 10_000)
	fx.adminExec(`UPDATE order_items SET unit_cost_cents = 4000 WHERE id = $1`, line)
	fx.seedPayment(order, "cash", 10_000, ptrUUID(shift))
	fx.closeOrderWithTotals(order)
	fx.closeShift(shift)
	// The window covers COMPLETE local days, so an order closed today is
	// deliberately outside it — including the current partial day would make
	// every morning's figures look like a collapse. Backdate to yesterday.
	fx.adminExec(`UPDATE orders SET closed_at = closed_at - interval '1 day' WHERE id = $1`, order)
	fx.adminExec(`UPDATE shifts SET closed_at = closed_at - interval '1 day' WHERE id = $1`, shift)

	v, ok := listInsights(t, fx)["books_confidence"].(float64)
	if !ok {
		t.Fatal("expected a confidence figure once there is something to measure")
	}
	// Full cost coverage and a closed drawer, no expenses to allocate: the
	// unmeasurable component must be skipped, not counted as zero.
	if v != 1 {
		t.Errorf("books_confidence = %v, want 1", v)
	}
}

// =========================================================================
// Lifecycle
// =========================================================================

func TestAcceptInsight_BooksAFollowUpAgainstTodaysObservation(t *testing.T) {
	fx := newInsightTenant(t)
	id := seedFinding(t, fx, "void_rate", insight.SeverityBad, 5000)

	callHandler(t, fx, AcceptInsight, http.MethodPost, "/",
		map[string]any{"follow_up_days": 7, "note": "talk to the kitchen"},
		withParam("id", id.String())).
		expectStatus(http.StatusNoContent)

	var state, note string
	var acceptedOn, followUp time.Time
	var by uuid.UUID
	fx.adminScan([]any{&state, &note, &acceptedOn, &followUp, &by},
		`SELECT state, note, accepted_on, follow_up_on, accepted_by_user_id
		 FROM insight_findings WHERE id = $1`, id)

	if state != "accepted" {
		t.Errorf("state = %q", state)
	}
	if note != "talk to the kitchen" {
		t.Errorf("note = %q", note)
	}
	if by != fx.User {
		t.Errorf("accepted_by = %v, want the acting user", by)
	}
	// accepted_on must be the observation day being accepted against, or the
	// follow-up has nothing to compare with.
	if got := acceptedOn.Format("2006-01-02"); got != time.Now().Format("2006-01-02") {
		t.Errorf("accepted_on = %s, want today's observation day", got)
	}
	if d := int(followUp.Sub(acceptedOn).Hours() / 24); d != 7 {
		t.Errorf("follow-up is %d days out, want 7", d)
	}
}

func TestAcceptInsight_ClampsAbsurdFollowUpDates(t *testing.T) {
	fx := newInsightTenant(t)
	// A caller — a fat finger now, an AI assistant over MCP later — asking for a
	// forty-year follow-up gets clamped, not obeyed.
	for _, tc := range []struct{ ask, want int }{
		{ask: 100_000, want: insight.MaxFollowUpDays},
		{ask: -5, want: 1},
		{ask: 0, want: 14}, // unset means the default
	} {
		id := seedFinding(t, fx, "void_rate", insight.SeverityBad, 1)
		callHandler(t, fx, AcceptInsight, http.MethodPost, "/",
			map[string]any{"follow_up_days": tc.ask}, withParam("id", id.String())).
			expectStatus(http.StatusNoContent)

		var acceptedOn, followUp time.Time
		fx.adminScan([]any{&acceptedOn, &followUp},
			`SELECT accepted_on, follow_up_on FROM insight_findings WHERE id=$1`, id)
		if d := int(followUp.Sub(acceptedOn).Hours() / 24); d != tc.want {
			t.Errorf("asked for %d days, got %d, want %d", tc.ask, d, tc.want)
		}
		fx.adminExec(`UPDATE insight_findings SET state='closed' WHERE id=$1`, id)
	}
}

func TestAcceptInsight_TruncatesAnOverlongNote(t *testing.T) {
	fx := newInsightTenant(t)
	id := seedFinding(t, fx, "void_rate", insight.SeverityBad, 1)
	long := make([]byte, 1000)
	for i := range long {
		long[i] = 'a'
	}
	callHandler(t, fx, AcceptInsight, http.MethodPost, "/",
		map[string]any{"follow_up_days": 7, "note": string(long)},
		withParam("id", id.String())).
		expectStatus(http.StatusNoContent)

	var note string
	fx.adminScan([]any{&note}, `SELECT note FROM insight_findings WHERE id=$1`, id)
	if len(note) != insight.MaxNoteLen {
		t.Errorf("note is %d chars, want it capped at %d", len(note), insight.MaxNoteLen)
	}
}

func TestDismissInsight_StampsTheDismissal(t *testing.T) {
	fx := newInsightTenant(t)
	id := seedFinding(t, fx, "dead_items", insight.SeverityWarn, 9)

	callHandler(t, fx, DismissInsight, http.MethodPost, "/", nil,
		withParam("id", id.String())).
		expectStatus(http.StatusNoContent)

	var state string
	var at *time.Time
	fx.adminScan([]any{&state, &at},
		`SELECT state, dismissed_at FROM insight_findings WHERE id=$1`, id)
	if state != "dismissed" || at == nil {
		t.Errorf("state=%q dismissed_at=%v — the schema CHECK requires both", state, at)
	}
}

// A closed finding must not be resurrectable. The guard is in the UPDATE's WHERE
// clause rather than in Go, so no caller can get around it.
func TestLifecycle_ClosedFindingsCannotBeActedOn(t *testing.T) {
	fx := newInsightTenant(t)
	id := seedFinding(t, fx, "void_rate", insight.SeverityBad, 1)
	fx.adminExec(`UPDATE insight_findings SET state='closed', closed_at=now() WHERE id=$1`, id)

	for _, tc := range []struct {
		name string
		h    http.HandlerFunc
		body any
	}{
		{"dismiss", DismissInsight, nil},
		{"snooze", SnoozeInsight, map[string]any{"days": 3}},
		{"accept", AcceptInsight, map[string]any{"follow_up_days": 3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			callHandler(t, fx, tc.h, http.MethodPost, "/", tc.body,
				withParam("id", id.String())).
				expectStatus(http.StatusNotFound)
		})
	}
}

// Another café's finding is indistinguishable from one that does not exist —
// telling them apart would leak that it exists.
func TestLifecycle_AnotherCafesFindingIsNotFound(t *testing.T) {
	owner := newInsightTenant(t)
	other := newInsightTenant(t)
	id := seedFinding(t, other, "void_rate", insight.SeverityBad, 1)

	callHandler(t, owner, DismissInsight, http.MethodPost, "/", nil,
		withParam("id", id.String())).
		expectStatus(http.StatusNotFound)

	var state string
	other.adminScan([]any{&state}, `SELECT state FROM insight_findings WHERE id=$1`, id)
	if state != "new" {
		t.Errorf("the other café's finding changed to %q", state)
	}
}

func TestMarkInsightSeen_OnlyMovesNew(t *testing.T) {
	fx := newInsightTenant(t)
	id := seedFinding(t, fx, "void_rate", insight.SeverityBad, 1)

	callHandler(t, fx, MarkInsightSeen, http.MethodPost, "/", nil,
		withParam("id", id.String())).expectStatus(http.StatusNoContent)

	// Reading it again must not clobber a real decision made in between.
	fx.adminExec(`UPDATE insight_findings SET state='accepted', accepted_at=now(),
		accepted_on=CURRENT_DATE, follow_up_on=CURRENT_DATE+7 WHERE id=$1`, id)
	callHandler(t, fx, MarkInsightSeen, http.MethodPost, "/", nil,
		withParam("id", id.String())).expectStatus(http.StatusNotFound)

	var state string
	fx.adminScan([]any{&state}, `SELECT state FROM insight_findings WHERE id=$1`, id)
	if state != "accepted" {
		t.Errorf("state = %q, want the accepted decision preserved", state)
	}
}

// A snooze must never count toward muting: "not now" is not "never".
func TestSnoozeInsight_DoesNotCountTowardMuting(t *testing.T) {
	fx := newInsightTenant(t)
	for i := 0; i < insight.DismissalsToMute+2; i++ {
		id := seedFinding(t, fx, "dead_items", insight.SeverityWarn, 1)
		callHandler(t, fx, SnoozeInsight, http.MethodPost, "/", map[string]any{"days": 3},
			withParam("id", id.String())).expectStatus(http.StatusNoContent)
		fx.adminExec(`UPDATE insight_findings SET state='closed' WHERE id=$1`, id)
	}

	err := fx.appTx(func(tx pgx.Tx) error {
		muted, err := insight.MutedDetectors(context.Background(), tx)
		if err != nil {
			return err
		}
		if muted["dead_items"] {
			t.Error("snoozing repeatedly must not mute a detector")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
