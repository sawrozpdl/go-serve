package api

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Analytics — the definitions, pinned.
//
// These numbers go on an owner's dashboard and get used to decide whether to
// keep paying for the feature, so the arithmetic is worth testing precisely
// rather than approximately.
// =========================================================================

func engageStatsFor(t *testing.T, fx *fixture, query string) engageStats {
	t.Helper()
	var out engageStats
	callHandler(t, fx, GetEngageStats, "GET", "/", nil, withQuery(query)).
		expectStatus(200).decode(&out)
	return out
}

func TestEngageStats_EmptyCafeReturnsZeroesNotNaN(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	out := engageStatsFor(t, fx, "range=30d")

	// Every rate divides by something that can be zero. A NaN here would
	// serialise as invalid JSON and take the whole page down.
	if out.Rates.Completion != 0 || out.Rates.Win != 0 || out.Rates.Redemption != 0 {
		t.Fatalf("rates on an empty café = %+v, want zeroes", out.Rates)
	}
	body := string(callHandler(t, fx, GetEngageStats, "GET", "/", nil, withQuery("range=30d")).Body)
	if strings.Contains(body, "NaN") || strings.Contains(body, "Inf") {
		t.Fatalf("stats produced non-finite JSON: %s", body)
	}
}

func TestEngageStats_FunnelAndRates(t *testing.T) {
	fx := playSetup(t)

	// Three devices scan. Two play; one wins.
	bootstrap(t, fx, "d1").expectStatus(200)
	bootstrap(t, fx, "d2").expectStatus(200)
	bootstrap(t, fx, "d3").expectStatus(200)

	winner, _, _ := startSession(t, fx, "d1")
	backdateSession(fx, winner, "60 seconds")
	submitScore(t, fx, winner, 45, 60000, 60).expectStatus(200) // clears the top tier

	loser, _, _ := startSession(t, fx, "d2")
	backdateSession(fx, loser, "20 seconds")
	submitScore(t, fx, loser, 1, 20000, 10).expectStatus(200) // below every tier

	out := engageStatsFor(t, fx, "range=today")

	if out.Funnel.Scans != 3 {
		t.Errorf("scans = %d, want 3 unique devices", out.Funnel.Scans)
	}
	if out.Funnel.Started != 2 || out.Funnel.Completed != 2 {
		t.Errorf("started/completed = %d/%d, want 2/2", out.Funnel.Started, out.Funnel.Completed)
	}
	if out.Funnel.Won != 1 {
		t.Errorf("won = %d, want 1", out.Funnel.Won)
	}
	if out.Rates.Completion != 1 {
		t.Errorf("completion = %v, want 1", out.Rates.Completion)
	}
	if out.Rates.Win != 0.5 {
		t.Errorf("win rate = %v, want 0.5 (1 of 2 winnable runs)", out.Rates.Win)
	}
	// Issued but not yet used at the till.
	if out.Rates.Redemption != 0 || out.InFlightCodes != 1 {
		t.Errorf("redemption = %v, in flight = %d; want 0 and 1", out.Rates.Redemption, out.InFlightCodes)
	}
}

// TestEngageStats_PracticeRunsDontDiluteWinRate — practice runs can never win,
// so counting them in the denominator would make a healthy campaign look broken.
func TestEngageStats_PracticeRunsDontDiluteWinRate(t *testing.T) {
	fx := playSetup(t)

	winner, _, _ := startSession(t, fx, "d1")
	backdateSession(fx, winner, "60 seconds")
	submitScore(t, fx, winner, 45, 60000, 60).expectStatus(200)

	// Same device plays three more times — all practice.
	for i := 0; i < 3; i++ {
		tok, winnable, _ := startSession(t, fx, "d1")
		if winnable {
			t.Fatal("expected a practice run")
		}
		backdateSession(fx, tok, "60 seconds")
		submitScore(t, fx, tok, 45, 60000, 60).expectStatus(200)
	}

	out := engageStatsFor(t, fx, "range=today")
	if out.Rates.Win != 1 {
		t.Fatalf("win rate = %v, want 1 — practice runs must be out of the denominator", out.Rates.Win)
	}
	if out.PracticeRuns != 3 {
		t.Fatalf("practice_runs = %d, want 3 reported separately", out.PracticeRuns)
	}
}

// TestEngageStats_RedemptionRateWindowsByIssueDate is the trap this module is
// most likely to fall into. A code ISSUED before the window and REDEEMED inside
// it must not appear in the numerator, or the rate exceeds 100%.
func TestEngageStats_RedemptionRateWindowsByIssueDate(t *testing.T) {
	fx := playSetup(t)

	// A code issued and redeemed 20 days ago.
	tok, _, _ := startSession(t, fx, "d1")
	backdateSession(fx, tok, "60 seconds")
	submitScore(t, fx, tok, 45, 60000, 60).expectStatus(200)
	fx.adminExec(`UPDATE engage_codes SET issued_on = current_date - 20, status = 'redeemed'
	              WHERE tenant_id = $1`, fx.Tenant)
	fx.adminExec(`UPDATE engage_sessions SET play_day = current_date - 20 WHERE tenant_id = $1`, fx.Tenant)

	// Its redemption is recorded as happening TODAY.
	var codeID, orderID string
	fx.adminScan([]any{&codeID}, `SELECT id::text FROM engage_codes WHERE tenant_id = $1`, fx.Tenant)
	order := fx.seedOpenOrder(nil)
	orderID = order.String()
	fx.adminExec(`INSERT INTO engage_redemptions
	              (tenant_id, code_id, order_id, amount_cents, intended_amount_cents, redeemed_on)
	              VALUES ($1, $2::uuid, $3::uuid, 1000, 1000, current_date)`, fx.Tenant, codeID, orderID)

	// A window covering only today: nothing was ISSUED in it, so the rate must
	// be 0 rather than 1/0 or an impossible ratio.
	out := engageStatsFor(t, fx, "range=today")
	if out.Funnel.Won != 0 {
		t.Fatalf("codes issued in today's window = %d, want 0", out.Funnel.Won)
	}
	if out.Rates.Redemption != 0 {
		t.Fatalf("redemption rate = %v, want 0 — a redemption today for a code issued 20 days ago "+
			"must not inflate today's rate", out.Rates.Redemption)
	}
}

// TestEngageStats_ReturningIsNullOnShortWindows: over one day "played on two
// different days" is 0 by construction, and a hard 0 reads as "nobody comes
// back" rather than "ask again later".
func TestEngageStats_ReturningIsNullOnShortWindows(t *testing.T) {
	fx := playSetup(t)

	short := engageStatsFor(t, fx, "range=today")
	if short.Rates.Returning != nil {
		t.Fatalf("returning = %v on a one-day window, want null", *short.Rates.Returning)
	}
	if short.Rates.ReturningReason != "window_too_short" {
		t.Fatalf("reason = %q, want window_too_short", short.Rates.ReturningReason)
	}

	long := engageStatsFor(t, fx, "range=30d")
	if long.Rates.Returning == nil {
		t.Fatal("returning is null on a 30-day window, want a number")
	}
}

// TestEngageStats_SpendLiftCarriesItsCaveats — the numbers must not be able to
// travel without the warning that they are correlational.
func TestEngageStats_SpendLiftCarriesItsCaveats(t *testing.T) {
	fx := playSetup(t)
	out := engageStatsFor(t, fx, "range=30d")

	if out.SpendLift.Basis != "association_not_causal" {
		t.Fatalf("basis = %q, want association_not_causal", out.SpendLift.Basis)
	}
	if len(out.SpendLift.Caveats) == 0 {
		t.Fatal("spend lift shipped with no caveats")
	}
}

// TestEngageStats_SpendLiftUsesSubtotal is the subtle one: the reward IS a
// discount inside total_cents, so comparing totals would mechanically penalise
// the group that redeemed.
func TestEngageStats_SpendLiftUsesSubtotal(t *testing.T) {
	fx := playSetup(t)
	requireDB(t)
	fx.setTenantVat("none", "0")
	fx.setTenantRates("0", "0")

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Tea", 10000)

	// Two identical bills of Rs 100. One carries a Rs 30 reward.
	plain := fx.seedOpenOrder(nil)
	fx.seedOrderItem(plain, item, 1, 10000)
	fx.closeOrderWithTotals(plain)

	rewarded := fx.seedOpenOrder(nil)
	fx.seedOrderItem(rewarded, item, 1, 10000)
	// playSetup already put an ACTIVE campaign on this café, and only one may be
	// active at a time — reuse it rather than tripping that index.
	var camp uuid.UUID
	fx.adminScan([]any{&camp}, `SELECT id FROM engage_campaigns WHERE tenant_id = $1`, fx.Tenant)
	amount := int64(3000)
	code := engageSeedCode(t, fx, camp, "LFT-0001", "flat", &amount, "5 minutes", "15 minutes")
	callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": rewarded}, withParam("code", codeText(t, code))).expectStatus(201)
	fx.closeOrderWithTotals(rewarded)

	out := engageStatsFor(t, fx, "range=today")
	sl := out.SpendLift

	if sl.WithRewardOrders != 1 || sl.WithoutRewardOrders != 1 {
		t.Fatalf("populations = %d with / %d without, want 1/1", sl.WithRewardOrders, sl.WithoutRewardOrders)
	}
	// On the subtotal basis the two guests ordered exactly the same amount, so
	// the honest answer is "no difference".
	if sl.AvgWithSubtotal != sl.AvgWithoutSubtotal {
		t.Fatalf("subtotal basis: with=%d without=%d — identical orders should compare equal",
			sl.AvgWithSubtotal, sl.AvgWithoutSubtotal)
	}
	// And on the total basis the rewarded bill is visibly lower, which is
	// exactly why totals are the wrong headline.
	if sl.AvgWithTotal >= sl.AvgWithoutTotal {
		t.Fatalf("total basis: with=%d without=%d — the discount should show here",
			sl.AvgWithTotal, sl.AvgWithoutTotal)
	}
}

func TestEngageTimeseries_ZeroFillsQuietDays(t *testing.T) {
	fx := playSetup(t)
	var out struct {
		Days []engageDayRow `json:"days"`
	}
	callHandler(t, fx, GetEngageTimeseries, "GET", "/", nil, withQuery("range=7d")).
		expectStatus(200).decode(&out)

	// A quiet day must be a zero bar, not a missing one — otherwise every later
	// bar silently shifts left and the chart lies about when things happened.
	if len(out.Days) != 7 {
		t.Fatalf("got %d days, want 7 including the quiet ones", len(out.Days))
	}
}

// =========================================================================
// Contacts
// =========================================================================

func TestEngageContacts_ListAndExport(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")
	submitContact(t, fx, map[string]any{
		"session_token": token, "name": "Asha", "email": "asha@example.com",
		"consent": true, "consent_text_version": "v1",
	}).expectStatus(200)

	var listed struct {
		Contacts []EngageContact `json:"contacts"`
	}
	callHandler(t, fx, ListEngageContacts, "GET", "/", nil).expectStatus(200).decode(&listed)
	if len(listed.Contacts) != 1 || listed.Contacts[0].Email != "asha@example.com" {
		t.Fatalf("list = %+v, want the one opted-in guest", listed.Contacts)
	}

	res := callHandler(t, fx, ExportEngageContacts, "GET", "/", nil).expectStatus(200)
	if ct := res.Hdr.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type = %q, want text/csv", ct)
	}
	if cd := res.Hdr.Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Fatalf("Content-Disposition = %q, want an attachment", cd)
	}
	body := string(res.Body)
	if !strings.Contains(body, "asha@example.com") || !strings.Contains(body, "name,email,phone") {
		t.Fatalf("csv missing header or row:\n%s", body)
	}
}

// TestEngageContacts_CsvDefusesFormulaInjection — a guest controls their own
// name, and Excel executes a cell starting with '='.
func TestEngageContacts_CsvDefusesFormulaInjection(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")
	submitContact(t, fx, map[string]any{
		"session_token": token,
		"name":          `=HYPERLINK("http://evil.example","click")`,
		"email":         "x@example.com", "consent": true,
	}).expectStatus(200)

	body := string(callHandler(t, fx, ExportEngageContacts, "GET", "/", nil).expectStatus(200).Body)
	if strings.Contains(body, ",=HYPERLINK") || strings.Contains(body, "\"=HYPERLINK") {
		t.Fatalf("csv would execute a guest-supplied formula:\n%s", body)
	}
	if !strings.Contains(body, "'=HYPERLINK") {
		t.Fatalf("expected the value neutralised but preserved:\n%s", body)
	}
}

func TestEngageContacts_DeleteIsHard(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")
	submitContact(t, fx, map[string]any{
		"session_token": token, "email": "gone@example.com", "consent": true,
	}).expectStatus(200)

	var listed struct {
		Contacts []EngageContact `json:"contacts"`
	}
	callHandler(t, fx, ListEngageContacts, "GET", "/", nil).expectStatus(200).decode(&listed)

	callHandler(t, fx, DeleteEngageContact, "DELETE", "/", nil,
		withParam("id", listed.Contacts[0].ID.String())).expectStatus(204)

	// "Forget me" has to mean forgotten — no tombstone still holding the address.
	if got := fx.countRows("engage_contacts"); got != 0 {
		t.Fatalf("engage_contacts still has %d rows after deletion", got)
	}
}

func TestEngageContacts_DeleteAllNeedsTheSlug(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")
	submitContact(t, fx, map[string]any{
		"session_token": token, "email": "a@example.com", "consent": true,
	}).expectStatus(200)

	callHandler(t, fx, DeleteAllEngageContacts, "DELETE", "/", nil).
		expectErr(400, "confirm_required")
	if got := fx.countRows("engage_contacts"); got != 1 {
		t.Fatal("an unconfirmed request deleted contacts")
	}

	callHandler(t, fx, DeleteAllEngageContacts, "DELETE", "/", nil,
		withQuery("confirm="+fx.Slug)).expectStatus(200)
	if got := fx.countRows("engage_contacts"); got != 0 {
		t.Fatalf("engage_contacts still has %d rows", got)
	}
}

// TestEngageContacts_CrossTenantInvisible — RLS, proved rather than assumed.
func TestEngageContacts_CrossTenantInvisible(t *testing.T) {
	theirs := playSetup(t)
	token := finishedSession(t, theirs, "device-a")
	submitContact(t, theirs, map[string]any{
		"session_token": token, "email": "private@example.com", "consent": true,
	}).expectStatus(200)

	mine := playSetup(t)
	var listed struct {
		Contacts []EngageContact `json:"contacts"`
	}
	callHandler(t, mine, ListEngageContacts, "GET", "/", nil).expectStatus(200).decode(&listed)
	if len(listed.Contacts) != 0 {
		t.Fatalf("another café's guest contacts are visible: %+v", listed.Contacts)
	}
}

// =========================================================================
// Invalidating outstanding codes
// =========================================================================

func TestInvalidateEngageCodes_VoidsOutstandingOnly(t *testing.T) {
	fx := playSetup(t)
	tok, _, _ := startSession(t, fx, "d1")
	backdateSession(fx, tok, "60 seconds")
	submitScore(t, fx, tok, 45, 60000, 60).expectStatus(200)

	res := callHandler(t, fx, InvalidateEngageCodes, "POST", "/", nil).expectStatus(200)
	if body := res.json(); body["voided"] != float64(1) {
		t.Fatalf("voided = %v, want 1", body["voided"])
	}

	var status string
	fx.adminScan([]any{&status}, `SELECT status FROM engage_codes WHERE tenant_id = $1`, fx.Tenant)
	if status != "void" {
		t.Fatalf("code status = %q, want void", status)
	}
}
