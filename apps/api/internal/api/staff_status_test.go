package api

import (
	"net/http"
	"testing"
	"time"
)

// =========================================================================
// Staff auto-deactivation (0083)
//
// Two rules, and the second is the one worth the tests: an end date that has
// passed deactivates somebody, and an automatic deactivation may reverse itself
// — but a HUMAN's decision never may. A job that quietly reactivates a
// suspended employee is worse than a roster that needs tidying by hand.
// =========================================================================

// tenantDay renders an offset from today in the fixture tenant's timezone,
// which is the only calendar the reconciler is allowed to consult.
func tenantDay(t *testing.T, fx *fixture, deltaDays int) string {
	t.Helper()
	var d string
	fx.adminScan([]any{&d},
		`SELECT ((now() AT TIME ZONE (SELECT COALESCE(NULLIF(timezone,''),'Asia/Kathmandu')
		          FROM tenants WHERE id = $1))::date + $2::int)::text`,
		fx.Tenant, deltaDays)
	return d
}

func (fx *fixture) staffStatus(t *testing.T, id string) (status string, marker *string) {
	t.Helper()
	fx.adminScan([]any{&status, &marker},
		`SELECT status, to_char(auto_deactivated_on, 'YYYY-MM-DD') FROM staff WHERE id = $1`, id)
	return
}

func TestStaff_EndDateInThePastDeactivates(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"ended_on": tenantDay(t, fx, -1)}, withParam("id", id)).
		expectStatus(http.StatusOK)

	status, marker := fx.staffStatus(t, id)
	if status != "inactive" {
		t.Fatalf("status = %q, want inactive — their last day has passed", status)
	}
	if marker == nil {
		t.Fatal("auto_deactivated_on not set — without it this cannot be un-done automatically")
	}
}

func TestStaff_LastWorkingDayIsStillActive(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	// Strictly `<`. Somebody whose last day is today is working today, and a
	// `<=` rule would log them out mid-shift on their own leaving day.
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"ended_on": tenantDay(t, fx, 0)}, withParam("id", id)).
		expectStatus(http.StatusOK)

	if status, _ := fx.staffStatus(t, id); status != "active" {
		t.Fatalf("status = %q, want active on their last working day", status)
	}
}

func TestStaff_FutureEndDateLeavesThemActive(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"ended_on": tenantDay(t, fx, 14)}, withParam("id", id)).
		expectStatus(http.StatusOK)

	if status, _ := fx.staffStatus(t, id); status != "active" {
		t.Fatalf("status = %q, want active — they are still working", status)
	}
}

func TestStaff_MovingTheEndDateOutBringsThemBack(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"ended_on": tenantDay(t, fx, -1)}, withParam("id", id)).
		expectStatus(http.StatusOK)
	if status, _ := fx.staffStatus(t, id); status != "inactive" {
		t.Fatal("precondition: expected them deactivated")
	}

	// They changed their mind and stayed on.
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"ended_on": tenantDay(t, fx, 30)}, withParam("id", id)).
		expectStatus(http.StatusOK)

	status, marker := fx.staffStatus(t, id)
	if status != "active" {
		t.Fatalf("status = %q, want active — the end date no longer applies", status)
	}
	if marker != nil {
		t.Fatalf("auto_deactivated_on = %v, want NULL once they are back", *marker)
	}
}

func TestStaff_ManualDeactivationIsNeverAutoReactivated(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	// THE test. Suspended, on leave, mid-dispute: no end date, a human's
	// decision. The reconciler must not touch it, ever.
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"status": "inactive"}, withParam("id", id)).
		expectStatus(http.StatusOK)

	status, marker := fx.staffStatus(t, id)
	if status != "inactive" {
		t.Fatalf("status = %q, want inactive", status)
	}
	if marker != nil {
		t.Fatalf("auto_deactivated_on = %v, want NULL — a human owns this status", *marker)
	}

	// Run the reconciler again (any staff write does). They must stay off.
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"notes": "on unpaid leave"}, withParam("id", id)).
		expectStatus(http.StatusOK)

	if status, _ := fx.staffStatus(t, id); status != "inactive" {
		t.Fatalf("status = %q — the reconciler overruled a human", status)
	}
}

func TestStaff_ManualReactivationSticksDespiteAPastEndDate(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"ended_on": tenantDay(t, fx, -1)}, withParam("id", id)).
		expectStatus(http.StatusOK)

	// A manager turns them back on by hand without touching the date — they
	// came in to cover a shift. Pressing Active has to mean something, so the
	// stale leaving date is cleared with it: otherwise the row says "active,
	// but left last Tuesday", the reconciler switches them straight back off,
	// and the toggle appears to do nothing at all.
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"status": "active"}, withParam("id", id)).
		expectStatus(http.StatusOK)

	status, marker := fx.staffStatus(t, id)
	if status != "active" {
		t.Fatalf("status = %q right after a manual reactivation, want active", status)
	}
	if marker != nil {
		t.Fatalf("auto_deactivated_on = %v, want NULL — the human took ownership", *marker)
	}
	var endedOn *string
	fx.adminScan([]any{&endedOn},
		`SELECT to_char(ended_on, 'YYYY-MM-DD') FROM staff WHERE id = $1`, id)
	if endedOn != nil {
		t.Fatalf("ended_on = %s after reactivating, want cleared — somebody working has not left", *endedOn)
	}

	// And it survives the next reconcile.
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"notes": "covering weekends"}, withParam("id", id)).
		expectStatus(http.StatusOK)
	if status, _ := fx.staffStatus(t, id); status != "active" {
		t.Fatalf("status = %q — the reconciler undid a manual reactivation", status)
	}
}

func TestStaff_CreateWithAPastEndDateLandsInactive(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	var s Staff
	callHandler(t, fx, CreateStaff, http.MethodPost, "/", map[string]any{
		"full_name": "Former Cook",
		"phone":     "+9779800000000",
		"ended_on":  tenantDay(t, fx, -10),
	}).expectStatus(http.StatusCreated).decode(&s)

	if status, _ := fx.staffStatus(t, s.ID.String()); status != "inactive" {
		t.Fatalf("status = %q, want inactive — they left ten days ago", status)
	}
}

func TestStaff_ReconcileIsIdempotent(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()
	fx.adminExec(`UPDATE staff SET ended_on = ($1)::date WHERE id = $2`, tenantDay(t, fx, -1), id)

	// Every staff write runs the reconciler, so three writes run it three
	// times. The marker must be set once and then left alone — a reconciler
	// that rewrote it each pass would keep moving the "when" of a decision
	// that was made days ago.
	for i := 0; i < 3; i++ {
		callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
			map[string]any{"notes": "pass"}, withParam("id", id)).expectStatus(http.StatusOK)
	}

	status, marker := fx.staffStatus(t, id)
	if status != "inactive" {
		t.Fatalf("status = %q after three passes, want inactive", status)
	}
	if marker == nil {
		t.Fatal("auto_deactivated_on was cleared by a later pass")
	}
	if *marker != tenantDay(t, fx, 0) {
		t.Fatalf("auto_deactivated_on = %s, want today (%s)", *marker, tenantDay(t, fx, 0))
	}
}

func TestStaff_ReconcileUsesTheTenantTimezone(t *testing.T) {
	requireDB(t)

	// The anti-regression test for this repo's standing timezone bug. Two
	// cafes, one either side of the date line, and a leaving date chosen so
	// that "has it passed?" has OPPOSITE answers in the two zones at the same
	// instant. A reconciler that used UTC, or the DB session's zone, would give
	// both cafes the same answer and one of them would be wrong.
	ahead := newTenant(t) // UTC+14 — already tomorrow
	behind := newTenant(t)
	ahead.adminExec(`UPDATE tenants SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, ahead.Tenant)
	behind.adminExec(`UPDATE tenants SET timezone = 'Pacific/Niue' WHERE id = $1`, behind.Tenant)

	// The UTC calendar date right now. In Kiritimati it is already past; in
	// Niue it is still today or earlier.
	utcToday := time.Now().UTC().Format("2006-01-02")

	aID := ahead.seedStaff("Ahead").String()
	bID := behind.seedStaff("Behind").String()
	ahead.adminExec(`UPDATE staff SET ended_on = ($1)::date WHERE id = $2`, utcToday, aID)
	behind.adminExec(`UPDATE staff SET ended_on = ($1)::date WHERE id = $2`, utcToday, bID)

	callHandler(t, ahead, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"notes": "touch"}, withParam("id", aID)).expectStatus(http.StatusOK)
	callHandler(t, behind, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"notes": "touch"}, withParam("id", bID)).expectStatus(http.StatusOK)

	aStatus, _ := ahead.staffStatus(t, aID)
	bStatus, _ := behind.staffStatus(t, bID)

	// Niue (UTC−11) can never be past the UTC date, so its person is still on.
	if bStatus != "active" {
		t.Fatalf("UTC−11 cafe: status = %q, want active — their last day has not passed there", bStatus)
	}
	// Kiritimati (UTC+14) is a day ahead for most of the UTC day. Assert the
	// pair DISAGREES whenever the zones genuinely differ; when both happen to
	// be on the same local date, they legitimately agree.
	var aheadLocal, behindLocal string
	ahead.adminScan([]any{&aheadLocal}, `SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text`)
	behind.adminScan([]any{&behindLocal}, `SELECT (now() AT TIME ZONE 'Pacific/Niue')::date::text`)
	if aheadLocal > utcToday && aStatus != "inactive" {
		t.Fatalf("UTC+14 cafe is on %s (UTC is %s) but status = %q — the reconciler is not "+
			"using the tenant's own calendar", aheadLocal, utcToday, aStatus)
	}
}

func TestStaff_ActivatingWithAnExplicitEndDateKeepsIt(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	id := fx.seedStaff("Bikash").String()

	// Clearing the date is only the fallback for a bare "make them active".
	// When the same request supplies a date, that date is what the operator
	// asked for and it must survive — here, a notice period ending next month.
	future := tenantDay(t, fx, 30)
	callHandler(t, fx, UpdateStaff, http.MethodPatch, "/",
		map[string]any{"status": "active", "ended_on": future}, withParam("id", id)).
		expectStatus(http.StatusOK)

	var endedOn *string
	fx.adminScan([]any{&endedOn},
		`SELECT to_char(ended_on, 'YYYY-MM-DD') FROM staff WHERE id = $1`, id)
	if endedOn == nil || *endedOn != future {
		t.Fatalf("ended_on = %v, want %s — an explicit date beats the clearing rule", endedOn, future)
	}
	if status, _ := fx.staffStatus(t, id); status != "active" {
		t.Fatalf("status = %q, want active — the date is in the future", status)
	}
}
