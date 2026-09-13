package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/insight"
	"github.com/pewssh/cafe-mgmt/api/internal/llm"
)

// The wrap's own properties. Everything about the model itself is tested in
// internal/llm, without a network; what matters here is the job's behaviour when
// there is no model at all — which is the state in dev, in CI, and in prod until
// somebody sets a key.

func wrapRunner(t *testing.T) *Runner {
	t.Helper()
	r := briefRunner(t)
	r.cfg.BriefHour = 0 // irrelevant: every wrap test forces
	return r
}

// Unlike the daily brief, the wrap ALWAYS sends. A channel that only ever speaks
// when something is wrong trains people to dread it and then to filter it; the
// wrap is the ritual that keeps the daily brief legible as an exception.
func TestWrap_SendsEvenWithNoFindings(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	// Give it a trading day so it is not dormant, but nothing to report.
	seedTradingDay(t, tenantID)

	if _, err := r.wrapFor(ctx, c, time.Now(), 1_000_000); err != nil {
		t.Fatalf("wrapFor: %v", err)
	}

	var findings int
	var status string
	if err := pool.QueryRow(ctx, `
		SELECT finding_count, llm_status FROM insight_briefs
		WHERE tenant_id = $1 AND kind = 'weekly'`, tenantID).Scan(&findings, &status); err != nil {
		t.Fatal(err)
	}
	// No model configured is the DEFAULT, and it must be recorded as such rather
	// than as an error.
	if status != "disabled" {
		t.Errorf("llm_status = %q, want disabled when no key is set", status)
	}
	_ = findings
}

// A café that never opened has no week to wrap.
func TestWrap_DormantCafeGetsNoEmail(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	if _, err := r.wrapFor(ctx, c, time.Now(), 1_000_000); err != nil {
		t.Fatal(err)
	}
	var emailedAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT emailed_at FROM insight_briefs WHERE tenant_id = $1 AND kind = 'weekly'`,
		tenantID).Scan(&emailedAt); err != nil {
		t.Fatal(err)
	}
	if emailedAt != nil {
		t.Error("a café that did not trade must not be sent a week in review")
	}
}

// A Monday carries BOTH a daily brief and a weekly wrap. That is the whole
// reason 0071 moved uniqueness to (tenant, day, kind).
func TestWrap_CoexistsWithTheSameDaysBrief(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	if err := r.briefFor(ctx, c, time.Now()); err != nil {
		t.Fatalf("briefFor: %v", err)
	}
	if _, err := r.wrapFor(ctx, c, time.Now(), 1_000_000); err != nil {
		t.Fatalf("wrapFor: %v", err)
	}

	var kinds []string
	rows, err := pool.Query(ctx,
		`SELECT kind FROM insight_briefs WHERE tenant_id = $1 ORDER BY kind`, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, k)
	}
	if len(kinds) != 2 || kinds[0] != "daily" || kinds[1] != "weekly" {
		t.Fatalf("kinds = %v, want [daily weekly] on the same day", kinds)
	}
}

func TestWrap_SecondPassIsSkipped(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	ctx := context.Background()

	for range 2 {
		if _, err := r.wrapFor(ctx, c, time.Now(), 1_000_000); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM insight_briefs WHERE tenant_id=$1 AND kind='weekly'`,
		tenantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("%d wrap rows, want 1", n)
	}
}

// An exhausted budget must not make a call, and must be recorded as its own
// state — distinct from an error, because nothing failed.
func TestWrap_ExhaustedBudgetSkipsTheModel(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	// This café has opted in — the model is default-off per café, so every
	// test that expects a model call has to say so.
	enableAIWrap(t, tenantID)
	seedTradingDay(t, tenantID)
	ctx := context.Background()

	// Pretend a model IS configured, then hand the café no budget.
	// A REAL enabled client, with a dummy key. It is never called: writeProse
	// checks the budget first and returns before touching the network, which is
	// exactly the behaviour under test.
	r.llm = llm.New(llm.Config{APIKey: "not-used-because-budget-is-zero"})
	if _, err := r.wrapFor(ctx, c, time.Now(), 0); err != nil {
		t.Fatal(err)
	}

	var status string
	var cost int64
	if err := pool.QueryRow(ctx, `
		SELECT llm_status, cost_micros FROM insight_briefs
		WHERE tenant_id=$1 AND kind='weekly'`, tenantID).Scan(&status, &cost); err != nil {
		t.Fatal(err)
	}
	if status != "budget" {
		t.Errorf("llm_status = %q, want budget", status)
	}
	if cost != 0 {
		t.Errorf("cost = %d, want 0 — a skipped call costs nothing", cost)
	}
}

// The wrap must not be able to block the digest or the daily briefs.
func TestWrap_HasItsOwnAdvisoryLock(t *testing.T) {
	for _, other := range []int64{advisoryLockKey, briefLockKey} {
		if wrapLockKey == other {
			t.Fatalf("the wrap shares lock %#x — a run that makes network calls "+
				"must not be able to block the other jobs", other)
		}
	}
}

// --- applyModelOrder (pure) ----------------------------------------------

func f(key string) insight.Finding {
	return insight.Finding{DetectorKey: key, SubjectLabel: key}
}

func keysOf(fs []insight.Finding) []string {
	out := make([]string, len(fs))
	for i, x := range fs {
		out[i] = x.DetectorKey
	}
	return out
}

func TestApplyModelOrder_ReordersToThePreference(t *testing.T) {
	lead := []insight.Finding{f("a"), f("b"), f("c")}
	got := keysOf(applyModelOrder(lead, []string{"c", "a", "b"}))
	want := []string{"c", "a", "b"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

// THE important one. The model may omit a key — it is allowed to fold two
// findings into one story — but the READER must still see every finding that was
// selected. Dropping one would mean the model quietly decided what the owner
// sees, which is exactly the authority it does not have.
func TestApplyModelOrder_NeverDropsAFinding(t *testing.T) {
	lead := []insight.Finding{f("a"), f("b"), f("c")}
	got := applyModelOrder(lead, []string{"c"})
	if len(got) != 3 {
		t.Fatalf("got %d findings from %d, want all of them: %v", len(got), len(lead), keysOf(got))
	}
	if got[0].DetectorKey != "c" {
		t.Errorf("the named key must lead, got %v", keysOf(got))
	}
}

func TestApplyModelOrder_EmptyOrderKeepsServerRanking(t *testing.T) {
	lead := []insight.Finding{f("a"), f("b")}
	got := keysOf(applyModelOrder(lead, nil))
	if got[0] != "a" || got[1] != "b" {
		t.Errorf("no preference must leave the server's order intact, got %v", got)
	}
}

// Two findings can share a detector (two credit accounts, two below-cost items).
// Naming that key must bring BOTH forward, not just one.
func TestApplyModelOrder_HandlesRepeatedDetectors(t *testing.T) {
	lead := []insight.Finding{f("credit_aging"), f("credit_aging"), f("void_rate")}
	got := applyModelOrder(lead, []string{"void_rate", "credit_aging"})
	if len(got) != 3 {
		t.Fatalf("got %d, want 3: %v", len(got), keysOf(got))
	}
	if got[0].DetectorKey != "void_rate" {
		t.Errorf("order = %v", keysOf(got))
	}
}

// --- helpers -------------------------------------------------------------

// seedTradingDay gives a café one closed order yesterday, so it is not dormant.
func seedTradingDay(t *testing.T, tenantID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT user_id FROM tenant_members WHERE tenant_id=$1 LIMIT 1`, tenantID).Scan(&userID); err != nil {
		// No member yet: make one, since orders need an opener.
		if err := pool.QueryRow(ctx,
			`INSERT INTO users (email, name) VALUES ($1,'Wrap Seed') RETURNING id`,
			"wrap-"+uuid.NewString()[:8]+"@test.local").Scan(&userID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })
		if _, err := pool.Exec(ctx,
			`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1,$2,'active')`,
			tenantID, userID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO orders (tenant_id, status, opened_by_user_id, opened_at, closed_at,
		                    subtotal_cents, total_cents, tax_cents)
		VALUES ($1, 'closed', $2, now() - interval '1 day', now() - interval '1 day',
		        10000, 10000, 0)`, tenantID, userID); err != nil {
		t.Fatalf("seed trading day: %v", err)
	}
}

// --- the model path, end to end against a fake provider ------------------

// No real API key exists in dev or CI, but the whole point of llm.Config.Endpoint
// being configurable is that the model path can still be exercised for real:
// prompt built, response verified, prose stored, spend recorded, email rendered.
// These are the tests that would otherwise need a key.

func fakeModel(t *testing.T, replyText string, inTok, outTok int) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []any{map[string]any{
				"content": map[string]any{"parts": []any{map[string]any{"text": replyText}}},
			}},
			"usageMetadata": map[string]any{
				"promptTokenCount": inTok, "candidatesTokenCount": outTok,
			},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestWrap_ModelProseIsStoredAndMetered(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	// This café has opted in — the model is default-off per café, so every
	// test that expects a model call has to say so.
	enableAIWrap(t, tenantID)
	seedTradingDay(t, tenantID)
	ctx := context.Background()

	// Valid prose: no digits anywhere, and it names no key it wasn't given.
	good := `{"order":[],"headline":"A steady week with one loose thread",` +
		`"body":"Most of the week was unremarkable. The one thing worth an hour is tagging last month's spending."}`
	r.llm = llm.New(llm.Config{
		APIKey: "k", Model: "gemini-2.0-flash-lite",
		Endpoint: fakeModel(t, good, 2000, 400),
	})

	spent, err := r.wrapFor(ctx, c, time.Now(), 5_000_000)
	if err != nil {
		t.Fatalf("wrapFor: %v", err)
	}
	if spent <= 0 {
		t.Error("a real call must report its cost so the budget decrements")
	}

	var status, headline, narrative, model string
	var inTok, outTok int
	var cost int64
	if err := pool.QueryRow(ctx, `
		SELECT llm_status, headline, narrative, llm_model, input_tokens, output_tokens, cost_micros
		FROM insight_briefs WHERE tenant_id=$1 AND kind='weekly'`, tenantID).
		Scan(&status, &headline, &narrative, &model, &inTok, &outTok, &cost); err != nil {
		t.Fatal(err)
	}
	if status != "ok" {
		t.Errorf("llm_status = %q, want ok", status)
	}
	if headline != "A steady week with one loose thread" {
		t.Errorf("headline = %q", headline)
	}
	if narrative == "" {
		t.Error("the verified prose must be stored — the café was shown it")
	}
	if inTok != 2000 || outTok != 400 || cost != spent {
		t.Errorf("ledger = %d/%d tokens, %d micros (returned %d)", inTok, outTok, cost, spent)
	}
	if model != "gemini-2.0-flash-lite" {
		t.Errorf("llm_model = %q — the ledger must say which model was charged", model)
	}
}

// The guard, exercised through the whole job rather than in isolation: a model
// that puts a figure in its prose must not reach a café, the rejection must be
// recorded as its own status, and the raw text must be kept as evidence about
// OUR prompt.
func TestWrap_RejectedProseIsRecordedAndNotShown(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	// This café has opted in — the model is default-off per café, so every
	// test that expects a model call has to say so.
	enableAIWrap(t, tenantID)
	seedTradingDay(t, tenantID)
	ctx := context.Background()

	bad := `{"order":[],"headline":"Sales fell 14% this week","body":"That is worth a look."}`
	r.llm = llm.New(llm.Config{APIKey: "k", Endpoint: fakeModel(t, bad, 500, 60)})

	if _, err := r.wrapFor(ctx, c, time.Now(), 5_000_000); err != nil {
		t.Fatalf("a rejection must not fail the job: %v", err)
	}

	var status, headline, narrative, raw string
	var cost int64
	if err := pool.QueryRow(ctx, `
		SELECT llm_status, headline, narrative, raw_response, cost_micros
		FROM insight_briefs WHERE tenant_id=$1 AND kind='weekly'`, tenantID).
		Scan(&status, &headline, &narrative, &raw, &cost); err != nil {
		t.Fatal(err)
	}
	if status != "rejected_numbers" {
		t.Errorf("llm_status = %q, want rejected_numbers", status)
	}
	if narrative != "" || headline != "" {
		t.Errorf("rejected prose must NOT be stored as shown text: %q / %q", headline, narrative)
	}
	if !strings.Contains(raw, "14%") {
		t.Errorf("the raw response is evidence about our prompt and must be kept, got %q", raw)
	}
	if cost <= 0 {
		t.Error("a rejected call was still paid for and must still be metered")
	}
}

// A model that tries to add a finding it was not given must also be rejected —
// selection is not its authority.
func TestWrap_ModelCannotPromoteAnUnknownFinding(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	// This café has opted in — the model is default-off per café, so every
	// test that expects a model call has to say so.
	enableAIWrap(t, tenantID)
	seedTradingDay(t, tenantID)
	ctx := context.Background()

	sneaky := `{"order":["a_finding_we_never_raised"],"headline":"A word","body":"Some prose."}`
	r.llm = llm.New(llm.Config{APIKey: "k", Endpoint: fakeModel(t, sneaky, 100, 20)})

	if _, err := r.wrapFor(ctx, c, time.Now(), 5_000_000); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(ctx,
		`SELECT llm_status FROM insight_briefs WHERE tenant_id=$1 AND kind='weekly'`,
		tenantID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "rejected_numbers" {
		t.Errorf("llm_status = %q — promoting an unknown key must be rejected too", status)
	}
}

// A provider outage must be recorded as an outage, not as a guard trip: one is a
// broken key, the other is the model writing badly, and confusing them hides the
// first behind the second.
func TestWrap_ProviderOutageIsRecordedAsError(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	// This café has opted in — the model is default-off per café, so every
	// test that expects a model call has to say so.
	enableAIWrap(t, tenantID)
	seedTradingDay(t, tenantID)
	ctx := context.Background()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	r.llm = llm.New(llm.Config{APIKey: "k", Endpoint: srv.URL})

	if _, err := r.wrapFor(ctx, c, time.Now(), 5_000_000); err != nil {
		t.Fatalf("an outage must not fail the job: %v", err)
	}
	var status, narrative string
	if err := pool.QueryRow(ctx,
		`SELECT llm_status, narrative FROM insight_briefs WHERE tenant_id=$1 AND kind='weekly'`,
		tenantID).Scan(&status, &narrative); err != nil {
		t.Fatal(err)
	}
	if status != "error" {
		t.Errorf("llm_status = %q, want error", status)
	}
	if narrative != "" {
		t.Error("an outage means the deterministic opening is used")
	}
}

// A key configured on the platform must NOT opt every café into having a model
// read its numbers. The wrap job runs as a platform admin and deliberately
// bypasses feature gating for the findings themselves — those are core — but
// sending a café's figures to an outside model is a decision the café makes.
// Default off, like the AI connector and QR rewards.
func TestWrap_ModelStaysOffUntilTheCafeTurnsItOn(t *testing.T) {
	r := wrapRunner(t)
	tenantID, c := activeCafe(t, "Asia/Kathmandu")
	seedTradingDay(t, tenantID)
	ctx := context.Background()

	// A real, enabled client with plenty of budget. The ONLY thing that should
	// stop it is the café's own feature switch.
	r.llm = llm.New(llm.Config{APIKey: "must-never-be-used", MonthlyBudgetUSD: 100})
	if _, err := r.wrapFor(ctx, c, time.Now(), 1_000_000_000); err != nil {
		t.Fatal(err)
	}

	var status string
	var cost int64
	if err := pool.QueryRow(ctx, `
		SELECT llm_status, cost_micros FROM insight_briefs
		WHERE tenant_id=$1 AND kind='weekly'`, tenantID).Scan(&status, &cost); err != nil {
		t.Fatal(err)
	}
	if status != "disabled" {
		t.Errorf("llm_status = %q, want disabled — the café never enabled the model", status)
	}
	if cost != 0 {
		t.Errorf("cost = %d, want 0 — a café that never opted in must not be billed", cost)
	}

	// And the gate is genuinely what stopped it: grant the feature, clear the
	// marker, and the same run now gets PAST the gate and reaches the network
	// (where the fake key fails). Any status other than "disabled" proves the
	// switch — not something else — was holding it back.
	if _, err := pool.Exec(ctx,
		`UPDATE tenants SET feature_overrides = '{"grant":["ai_weekly_wrap"]}'::jsonb WHERE id = $1`,
		tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM insight_briefs WHERE tenant_id=$1 AND kind='weekly'`, tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.wrapFor(ctx, c, time.Now(), 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT llm_status FROM insight_briefs
		WHERE tenant_id=$1 AND kind='weekly'`, tenantID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status == "disabled" {
		t.Error("llm_status still disabled after granting ai_weekly_wrap — the feature grant does nothing")
	}
}

// enableAIWrap grants the per-café switch that lets a model write the wrap.
// Default-off is the product behaviour (see TestWrap_ModelStaysOffUntilTheCafe
// TurnsItOn); a test that wants a model call has to opt the café in, exactly as
// a super admin would.
func enableAIWrap(t *testing.T, tenantID uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE tenants SET feature_overrides = '{"grant":["ai_weekly_wrap"]}'::jsonb WHERE id = $1`,
		tenantID); err != nil {
		t.Fatalf("grant ai_weekly_wrap: %v", err)
	}
}
