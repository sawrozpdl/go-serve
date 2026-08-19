package api

import (
	"strings"
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/config"
)

// =========================================================================
// The public play surface.
//
// Every call here uses asGuest(): tenant context set, NO app.user_id, exactly
// as production runs it. Without that, an RLS policy accidentally referencing
// current_user_id() would pass the whole suite and then deny every guest.
// =========================================================================

func playCfg() *config.Config {
	return &config.Config{EngageDevicePepper: "test-pepper"}
}

// playSetup gives a café a live campaign with a real ladder and the feature on.
func playSetup(t *testing.T) *fixture {
	t.Helper()
	fx := newTenant(t)
	requireDB(t)
	fx.grantFeature("qr_rewards")

	putCampaign(t, fx, engageBaseCampaign())
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 5, "label": "10% off", "reward_kind": "percent", "percent_bp": 1000, "max_discount_cents": 20000},
		{"min_score": 40, "label": "Free pastry", "reward_kind": "flat", "amount_cents": 15000},
	}}).expectStatus(200)
	callHandler(t, fx, SetEngageCampaignStatus, "POST", "/", map[string]any{"status": "active"}).expectStatus(200)
	return fx
}

func bootstrap(t *testing.T, fx *fixture, fingerprint string) *apiResp {
	t.Helper()
	return callHandler(t, fx, PlayBootstrap(playCfg()), "POST", "/",
		map[string]any{"fingerprint": fingerprint}, asGuest())
}

func startSession(t *testing.T, fx *fixture, fingerprint string) (token string, winnable bool, seed int64) {
	t.Helper()
	res := callHandler(t, fx, StartPlaySession(playCfg()), "POST", "/",
		map[string]any{"fingerprint": fingerprint}, asGuest())
	if res.Code != 200 && res.Code != 201 {
		t.Fatalf("start session: status %d; body: %s", res.Code, res.Body)
	}
	var out struct {
		SessionToken string `json:"session_token"`
		Winnable     bool   `json:"winnable"`
		Seed         int64  `json:"seed"`
	}
	res.decode(&out)
	return out.SessionToken, out.Winnable, out.Seed
}

func submitScore(t *testing.T, fx *fixture, token string, score, elapsedMS, events int) *apiResp {
	t.Helper()
	return callHandler(t, fx, SubmitPlayScore(playCfg()), "POST", "/", map[string]any{
		"session_token": token, "score": score, "elapsed_ms": elapsedMS, "events": events,
	}, asGuest())
}

// backdateSession makes a run look like it took a while, so validateScore's
// duration and rate bounds are satisfied without the test actually waiting.
func backdateSession(fx *fixture, token string, interval string) {
	fx.t.Helper()
	fx.adminExec(`UPDATE engage_sessions SET started_at = now() - $2::interval
	              WHERE session_token_hash = $1`, hashSessionToken(token), interval)
}

// =========================================================================
// Bootstrap
// =========================================================================

// TestPlayBootstrap_FeatureOffIs404 is the disclosure rule: a café without the
// feature must be indistinguishable from a café that doesn't exist.
func TestPlayBootstrap_FeatureOffIs404(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	// Feature NOT granted.
	bootstrap(t, fx, "device-a").expectStatus(404)
}

func TestPlayBootstrap_ReturnsCafeAndLadder(t *testing.T) {
	fx := playSetup(t)
	res := bootstrap(t, fx, "device-a").expectStatus(200)

	var out publicPlayBootstrap
	res.decode(&out)
	if out.Campaign == nil {
		t.Fatal("no campaign returned for a live café")
	}
	if !out.CanWinToday {
		t.Fatalf("a fresh device should be able to win; reason=%q", out.PracticeReason)
	}
	if len(out.Tiers) != 2 {
		t.Fatalf("got %d ladder rungs, want 2", len(out.Tiers))
	}
	if out.Cafe.Slug != fx.Slug {
		t.Fatalf("cafe slug = %q, want %q", out.Cafe.Slug, fx.Slug)
	}
	if res.Hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store — this response is device-specific",
			res.Hdr.Get("Cache-Control"))
	}
}

// TestPlayBootstrap_LeaksNoRewardValues is the customer-facing DTO rule. Anyone
// can read this JSON; it must not tell them what each rung is worth, which item
// it is, or how close the budget is to running out.
func TestPlayBootstrap_LeaksNoRewardValues(t *testing.T) {
	fx := playSetup(t)
	body := string(bootstrap(t, fx, "device-a").expectStatus(200).Body)

	for _, forbidden := range []string{
		"percent_bp", "amount_cents", "menu_item_id", "max_discount",
		"estimated_value", "budget", "issue_limit", "tier_id",
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("bootstrap response leaks %q:\n%s", forbidden, body)
		}
	}
}

func TestPlayBootstrap_CountsUniqueDeviceDays(t *testing.T) {
	fx := playSetup(t)

	bootstrap(t, fx, "device-a").expectStatus(200)
	bootstrap(t, fx, "device-a").expectStatus(200) // a reload
	bootstrap(t, fx, "device-b").expectStatus(200)

	// Two devices, three loads: "scans" means guests, not refreshes.
	if got := fx.countRows("engage_scans"); got != 2 {
		t.Fatalf("engage_scans has %d rows, want 2 (one per device-day)", got)
	}
	var hits int
	fx.adminScan([]any{&hits},
		`SELECT hits FROM engage_scans WHERE tenant_id = $1 AND device_hash <> '' ORDER BY hits DESC LIMIT 1`,
		fx.Tenant)
	if hits != 2 {
		t.Fatalf("reload count = %d, want 2", hits)
	}
}

// TestPlayBootstrap_NoCampaignStillCountsTheScan: "people are scanning but
// there's nothing running" is exactly what an owner needs to see.
func TestPlayBootstrap_NoCampaignStillCountsTheScan(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	fx.grantFeature("qr_rewards")

	var out publicPlayBootstrap
	bootstrap(t, fx, "device-a").expectStatus(200).decode(&out)
	if out.Campaign != nil {
		t.Fatal("a café with no campaign returned one")
	}
	if out.PracticeReason != "no_active_campaign" {
		t.Fatalf("reason = %q, want no_active_campaign", out.PracticeReason)
	}
	if got := fx.countRows("engage_scans"); got != 1 {
		t.Fatalf("engage_scans has %d rows, want the scan recorded anyway", got)
	}
}

// TestPlayBootstrap_WriteLockedCafeCannotMint: billing.WriteGate does not reach
// /public, so this check is the only thing between a trial-expired café and real
// money leaving the till.
func TestPlayBootstrap_WriteLockedCafeCannotMint(t *testing.T) {
	fx := playSetup(t)
	// Expire the trial: no plan, trial_ends_at in the past.
	fx.adminExec(`UPDATE tenants SET trial_ends_at = now() - interval '30 days' WHERE id = $1`, fx.Tenant)

	var out publicPlayBootstrap
	bootstrap(t, fx, "device-a").expectStatus(200).decode(&out)
	if out.CanWinToday {
		t.Fatal("a write-locked café is still offering winnable plays")
	}
	if out.PracticeReason != "rewards_unavailable" {
		t.Fatalf("reason = %q, want rewards_unavailable", out.PracticeReason)
	}
}

// =========================================================================
// The once-a-day gate
// =========================================================================

// TestPlay_OneWinnableAttemptPerDeviceDay is the core fairness rule, and it is
// enforced by a partial unique index rather than a read-then-write check.
func TestPlay_OneWinnableAttemptPerDeviceDay(t *testing.T) {
	fx := playSetup(t)

	token, winnable, _ := startSession(t, fx, "device-a")
	if !winnable {
		t.Fatal("the first play of the day should be winnable")
	}
	backdateSession(fx, token, "20 seconds")
	submitScore(t, fx, token, 10, 20000, 20).expectStatus(200)

	// Same device, same day.
	_, winnable2, _ := startSession(t, fx, "device-a")
	if winnable2 {
		t.Fatal("a second play on the same device the same day must not be winnable")
	}

	// A different device is unaffected.
	_, winnable3, _ := startSession(t, fx, "device-b")
	if !winnable3 {
		t.Fatal("a different device should still get its own attempt")
	}
}

// TestPlay_AttemptIsBurnedAtStartNotSubmit: otherwise start → see a bad score
// coming → abandon → restart is unlimited retries, and score tiers mean nothing.
func TestPlay_AttemptIsBurnedAtStartNotSubmit(t *testing.T) {
	fx := playSetup(t)

	token, winnable, _ := startSession(t, fx, "device-a")
	if !winnable {
		t.Fatal("first play should be winnable")
	}
	// Walk away without submitting, then age the session past the resume window.
	backdateSession(fx, token, "45 minutes")

	_, winnable2, _ := startSession(t, fx, "device-a")
	if winnable2 {
		t.Fatal("abandoning a run and starting again handed out a second winnable attempt")
	}
}

// TestPlay_AbandonedRunStillReportsWinnable — found in a browser, not by a unit
// test. Bootstrap used to say "you've claimed today's reward" the moment a run
// STARTED, while StartPlaySession would happily resume that same run as
// winnable. The guest was told they had claimed something they had not, and the
// two endpoints disagreed. An attempt is spent when it is USED, not begun.
func TestPlay_AbandonedRunStillReportsWinnable(t *testing.T) {
	fx := playSetup(t)

	startSession(t, fx, "device-a") // started, walked away
	var out publicPlayBootstrap
	bootstrap(t, fx, "device-a").expectStatus(200).decode(&out)
	if !out.CanWinToday {
		t.Fatalf("an abandoned run reported %q — the guest has claimed nothing and can resume",
			out.PracticeReason)
	}

	// Once it is actually finished, the attempt IS spent.
	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "20 seconds")
	submitScore(t, fx, token, 10, 20000, 20).expectStatus(200)

	bootstrap(t, fx, "device-a").expectStatus(200).decode(&out)
	if out.CanWinToday || out.PracticeReason != "already_played_today" {
		t.Fatalf("after a completed run: canWin=%v reason=%q, want false/already_played_today",
			out.CanWinToday, out.PracticeReason)
	}
}

// TestPlay_UnfinishedSessionResumes is what keeps the rule above humane: a
// dropped connection must not cost the guest their turn.
func TestPlay_UnfinishedSessionResumes(t *testing.T) {
	fx := playSetup(t)

	token1, winnable1, seed1 := startSession(t, fx, "device-a")
	if !winnable1 {
		t.Fatal("first play should be winnable")
	}
	token2, winnable2, seed2 := startSession(t, fx, "device-a")
	if !winnable2 {
		t.Fatal("resuming within the window must stay winnable")
	}
	if seed1 != seed2 {
		t.Fatalf("resumed session got a different seed (%d vs %d) — it is not the same run", seed1, seed2)
	}
	// The raw token is only ever shown once, so a resume mints a fresh one and
	// the old one stops working.
	if token1 == token2 {
		t.Fatal("resume returned the same raw token; it should be rotated")
	}
	if got := fx.countRows("engage_sessions"); got != 1 {
		t.Fatalf("engage_sessions has %d rows, want 1 — resume must not create a second run", got)
	}
}

// =========================================================================
// Scoring and issuance
// =========================================================================

func TestPlay_WinningScoreMintsACode(t *testing.T) {
	fx := playSetup(t)
	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "60 seconds")

	res := submitScore(t, fx, token, 45, 60000, 60).expectStatus(200)
	var out struct {
		Outcome string          `json:"outcome"`
		Code    *publicPlayCode `json:"code"`
	}
	res.decode(&out)
	if out.Outcome != "win" || out.Code == nil {
		t.Fatalf("outcome=%q code=%v, want a win with a code", out.Outcome, out.Code)
	}
	if out.Code.Label != "Free pastry" {
		t.Fatalf("label = %q, want the top tier the score reached", out.Code.Label)
	}
	// The five-minute rule: the code must already be on a short clock.
	if out.Code.SecondsLeft <= 0 || out.Code.SecondsLeft > 300 {
		t.Fatalf("seconds_left = %d, want a live countdown within the 300s TTL", out.Code.SecondsLeft)
	}
}

func TestPlay_ScoreBelowEveryTierWinsNothing(t *testing.T) {
	fx := playSetup(t)
	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "20 seconds")

	var out struct {
		Outcome string          `json:"outcome"`
		Code    *publicPlayCode `json:"code"`
	}
	submitScore(t, fx, token, 2, 20000, 10).expectStatus(200).decode(&out)
	if out.Outcome != "no_reward" || out.Code != nil {
		t.Fatalf("outcome=%q code=%v, want no_reward and no code", out.Outcome, out.Code)
	}
	if got := fx.countRows("engage_codes"); got != 0 {
		t.Fatalf("a losing run minted %d codes", got)
	}
}

func TestPlay_PracticeRunNeverMintsACode(t *testing.T) {
	fx := playSetup(t)

	// Burn the winnable attempt.
	token1, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token1, "20 seconds")
	submitScore(t, fx, token1, 6, 20000, 20).expectStatus(200)
	before := fx.countRows("engage_codes")

	// Now a practice run, scoring high.
	token2, winnable, _ := startSession(t, fx, "device-a")
	if winnable {
		t.Fatal("expected a practice run")
	}
	backdateSession(fx, token2, "60 seconds")
	var out struct {
		Outcome string          `json:"outcome"`
		Code    *publicPlayCode `json:"code"`
	}
	submitScore(t, fx, token2, 45, 60000, 60).expectStatus(200).decode(&out)

	if out.Outcome != "practice" || out.Code != nil {
		t.Fatalf("outcome=%q code=%v, want practice with no code", out.Outcome, out.Code)
	}
	if got := fx.countRows("engage_codes"); got != before {
		t.Fatalf("a practice run minted a code (%d -> %d)", before, got)
	}
}

// TestPlay_ImplausibleScoreIsFlagged covers the attack that actually happens: a
// naked POST with a huge number.
func TestPlay_ImplausibleScoreIsFlagged(t *testing.T) {
	fx := playSetup(t)
	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "20 seconds")

	submitScore(t, fx, token, 99999, 20000, 99999).expectErr(400, "implausible_score")

	if got := fx.countRows("engage_codes"); got != 0 {
		t.Fatalf("a forged score minted %d codes", got)
	}
	var status, outcome, reason string
	fx.adminScan([]any{&status, &outcome, &reason},
		`SELECT status, outcome, reject_reason FROM engage_sessions WHERE tenant_id = $1`, fx.Tenant)
	if status != "flagged" || outcome != "rejected" {
		t.Fatalf("session status=%q outcome=%q, want flagged/rejected", status, outcome)
	}
	if reason == "" {
		t.Fatal("no reject_reason recorded for the fraud review list")
	}
}

// TestPlay_ScoreSubmitIsIdempotent: a retry over flaky café wifi must not mint a
// second code.
func TestPlay_ScoreSubmitIsIdempotent(t *testing.T) {
	fx := playSetup(t)
	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "60 seconds")

	var first struct {
		Code *publicPlayCode `json:"code"`
	}
	submitScore(t, fx, token, 45, 60000, 60).expectStatus(200).decode(&first)

	var second struct {
		Code     *publicPlayCode `json:"code"`
		Replayed bool            `json:"replayed"`
	}
	submitScore(t, fx, token, 45, 60000, 60).expectStatus(200).decode(&second)

	if !second.Replayed {
		t.Fatal("the second submit was not treated as a replay")
	}
	if second.Code == nil || first.Code == nil || second.Code.Code != first.Code.Code {
		t.Fatalf("replay returned a different code: %v vs %v", first.Code, second.Code)
	}
	if got := fx.countRows("engage_codes"); got != 1 {
		t.Fatalf("engage_codes has %d rows after a retry, want 1", got)
	}
}

func TestPlay_UnknownSessionToken(t *testing.T) {
	fx := playSetup(t)
	submitScore(t, fx, "not-a-real-token", 10, 20000, 20).expectErr(404, "session_not_found")
}

// TestPlay_BudgetExhaustionIsSignalledBeforePlaying is the decided behaviour:
// never let a guest clear the top tier and then be told the till is dry.
func TestPlay_BudgetExhaustionIsSignalledBeforePlaying(t *testing.T) {
	fx := playSetup(t)
	// One reward a day, and it has been claimed.
	fx.adminExec(`UPDATE engage_campaigns SET budget_daily_count = 1 WHERE tenant_id = $1`, fx.Tenant)

	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "60 seconds")
	submitScore(t, fx, token, 45, 60000, 60).expectStatus(200)

	var out publicPlayBootstrap
	bootstrap(t, fx, "device-b").expectStatus(200).decode(&out)
	if out.CanWinToday {
		t.Fatal("the next guest was offered a winnable play with the budget spent")
	}
	if out.PracticeReason != "rewards_claimed" {
		t.Fatalf("reason = %q, want rewards_claimed", out.PracticeReason)
	}
}

// TestPlay_TodaysCodeSurvivesARefresh — a guest who reloads must not lose a prize
// they already won.
func TestPlay_TodaysCodeSurvivesARefresh(t *testing.T) {
	fx := playSetup(t)
	token, _, _ := startSession(t, fx, "device-a")
	backdateSession(fx, token, "60 seconds")

	var won struct {
		Code *publicPlayCode `json:"code"`
	}
	submitScore(t, fx, token, 45, 60000, 60).expectStatus(200).decode(&won)

	var out publicPlayBootstrap
	bootstrap(t, fx, "device-a").expectStatus(200).decode(&out)
	if out.TodaysCode == nil || out.TodaysCode.Code != won.Code.Code {
		t.Fatalf("a refresh lost the guest's code: %v", out.TodaysCode)
	}
}

// TestPlay_CrossTenantDeviceIsolation: the same phone at two cafés gets an
// attempt at each, and neither café can correlate it with the other.
func TestPlay_CrossTenantDeviceIsolation(t *testing.T) {
	a := playSetup(t)
	b := playSetup(t)

	_, winnableA, _ := startSession(t, a, "same-phone")
	_, winnableB, _ := startSession(t, b, "same-phone")
	if !winnableA || !winnableB {
		t.Fatal("one device should get an attempt at each café independently")
	}

	// And the stored identity differs, so the two cafés cannot join on it.
	var hashA, hashB string
	a.adminScan([]any{&hashA}, `SELECT device_hash FROM engage_sessions WHERE tenant_id = $1`, a.Tenant)
	b.adminScan([]any{&hashB}, `SELECT device_hash FROM engage_sessions WHERE tenant_id = $1`, b.Tenant)
	if hashA == hashB {
		t.Fatal("the same fingerprint hashes identically at two cafés — they could correlate guests")
	}
}

// =========================================================================
// Contact opt-in
// =========================================================================

func submitContact(t *testing.T, fx *fixture, body map[string]any) *apiResp {
	t.Helper()
	return callHandler(t, fx, SubmitPlayContact(playCfg()), "POST", "/", body, asGuest())
}

// finishedSession plays a run to completion and returns its token.
func finishedSession(t *testing.T, fx *fixture, fingerprint string) string {
	t.Helper()
	token, _, _ := startSession(t, fx, fingerprint)
	backdateSession(fx, token, "60 seconds")
	submitScore(t, fx, token, 45, 60000, 60).expectStatus(200)
	return token
}

func TestPlayContact_RequiresConsent(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")

	submitContact(t, fx, map[string]any{
		"session_token": token, "email": "guest@example.com", "consent": false,
	}).expectErr(400, "consent_required")

	if got := fx.countRows("engage_contacts"); got != 0 {
		t.Fatalf("a contact was stored without consent (%d rows)", got)
	}
}

func TestPlayContact_StoresWithConsentRecord(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")

	submitContact(t, fx, map[string]any{
		"session_token": token, "name": "Guest", "email": "Guest@Example.com",
		"consent": true, "consent_text_version": "v1",
	}).expectStatus(200)

	var email, version string
	var consent bool
	fx.adminScan([]any{&email, &version, &consent},
		`SELECT email, consent_text_version, consent FROM engage_contacts WHERE tenant_id = $1`, fx.Tenant)
	if email != "guest@example.com" {
		t.Fatalf("email = %q, want it normalised to lowercase for dedupe", email)
	}
	if version != "v1" || !consent {
		t.Fatalf("consent record incomplete: version=%q consent=%v", version, consent)
	}
}

func TestPlayContact_DedupesTheSameGuest(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")

	for i := 0; i < 2; i++ {
		submitContact(t, fx, map[string]any{
			"session_token": token, "email": "guest@example.com", "consent": true,
		}).expectStatus(200)
	}

	if got := fx.countRows("engage_contacts"); got != 1 {
		t.Fatalf("engage_contacts has %d rows, want 1", got)
	}
	var seen int
	fx.adminScan([]any{&seen}, `SELECT times_seen FROM engage_contacts WHERE tenant_id = $1`, fx.Tenant)
	if seen != 2 {
		t.Fatalf("times_seen = %d, want 2", seen)
	}
}

func TestPlayContact_NeedsSomethingToReachThemOn(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")
	submitContact(t, fx, map[string]any{
		"session_token": token, "name": "Guest", "consent": true,
	}).expectErr(400, "bad_request")
}

func TestPlayContact_RequiresAFinishedGame(t *testing.T) {
	fx := playSetup(t)
	token, _, _ := startSession(t, fx, "device-a") // started, not finished
	submitContact(t, fx, map[string]any{
		"session_token": token, "email": "guest@example.com", "consent": true,
	}).expectErr(404, "session_not_found")
}

// TestPlayContact_SaysNothingAboutWhetherWeKnewThem — the response must not leak
// one guest's history to whoever is holding the phone.
func TestPlayContact_SaysNothingAboutWhetherWeKnewThem(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")

	first := submitContact(t, fx, map[string]any{
		"session_token": token, "email": "guest@example.com", "consent": true,
	}).expectStatus(200)
	second := submitContact(t, fx, map[string]any{
		"session_token": token, "email": "guest@example.com", "consent": true,
	}).expectStatus(200)

	if string(first.Body) != string(second.Body) {
		t.Fatalf("a returning guest gets a different response:\n%s\n%s", first.Body, second.Body)
	}
}

// =========================================================================
// Feature gate on every public route
// =========================================================================

func TestPlay_EveryPublicRouteIs404WithoutTheFeature(t *testing.T) {
	fx := playSetup(t)
	token := finishedSession(t, fx, "device-a")

	// Revoke it, as a super admin downgrading the café would.
	fx.adminExec(`UPDATE tenants SET feature_overrides = '{}'::jsonb WHERE id = $1`, fx.Tenant)

	bootstrap(t, fx, "device-a").expectStatus(404)
	callHandler(t, fx, StartPlaySession(playCfg()), "POST", "/",
		map[string]any{"fingerprint": "device-a"}, asGuest()).expectStatus(404)
	submitScore(t, fx, token, 10, 20000, 20).expectStatus(404)
	submitContact(t, fx, map[string]any{
		"session_token": token, "email": "g@example.com", "consent": true,
	}).expectStatus(404)
}

// TestPlay_RunsWithNoUserContext is the RLS proof for the whole surface: every
// call above already uses asGuest(), and this makes the intent explicit.
func TestPlay_RunsWithNoUserContext(t *testing.T) {
	fx := playSetup(t)
	token, winnable, _ := startSession(t, fx, "device-a")
	if token == "" || !winnable {
		t.Fatal("the play flow does not work without an app.user_id — an RLS policy is referencing current_user_id()")
	}
}
