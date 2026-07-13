package billing

// billing_test.go — comprehensive coverage for features.go, middleware.go,
// state.go (edge cases missed by state_test.go), and repo.go.
//
// NOTE: intp() is already declared in state_test.go (same package); do NOT
// redeclare it here.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------------
// Shared DB harness (mirrors internal/api/main_test.go, self-contained)
// ---------------------------------------------------------------------------

var (
	billingPool   *pgxpool.Pool
	billingDBSkip string
)

func TestMain(m *testing.M) {
	loadBillingDotEnv()

	dbURL := firstBillingNonEmpty(os.Getenv("DATABASE_URL"), os.Getenv("APP_DATABASE_URL"))
	if dbURL == "" {
		billingDBSkip = "DATABASE_URL / APP_DATABASE_URL not set; skipping DB tests"
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	billingPool, err = pgxpool.New(ctx, dbURL)
	if err == nil {
		err = billingPool.Ping(ctx)
	}
	if err != nil {
		billingDBSkip = fmt.Sprintf("cannot connect to DB: %v", err)
		os.Exit(m.Run())
	}

	code := m.Run()
	billingPool.Close()
	os.Exit(code)
}

func requireBillingDB(t *testing.T) {
	t.Helper()
	if billingDBSkip != "" {
		t.Skip(billingDBSkip)
	}
}

func firstBillingNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func loadBillingDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	var envPath string
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			envPath = filepath.Join(dir, ".env")
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if envPath == "" {
		return
	}
	f, err := os.Open(envPath)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}

// ---------------------------------------------------------------------------
// features.go tests
// ---------------------------------------------------------------------------

func TestFeatureKeyConstants(t *testing.T) {
	if string(FeatureAdvancedAnalytics) != "advanced_analytics" {
		t.Errorf("FeatureAdvancedAnalytics = %q, want %q", FeatureAdvancedAnalytics, "advanced_analytics")
	}
	if string(FeatureEmailShiftSummaries) != "email_shift_summaries" {
		t.Errorf("FeatureEmailShiftSummaries = %q, want %q", FeatureEmailShiftSummaries, "email_shift_summaries")
	}
	if string(FeatureAuditLogs) != "audit_logs" {
		t.Errorf("FeatureAuditLogs = %q, want %q", FeatureAuditLogs, "audit_logs")
	}
}

func TestRegistryContainsAllFeatures(t *testing.T) {
	// Every declared constant must appear exactly once in the Registry.
	expected := map[string]bool{
		string(FeatureAdvancedAnalytics):   false,
		string(FeatureProfitability):       false,
		string(FeatureOwnerFinance):        false,
		string(FeatureHouseTabs):           false,
		string(FeatureStaffHR):             false,
		string(FeatureStaffScheduling):     false,
		string(FeatureCustomRoles):         false,
		string(FeatureEmailShiftSummaries): false,
		string(FeatureMultiOutlet):         false,
		string(FeatureInventory):           false,
		string(FeatureMenuImport):          false,
		string(FeatureThermalPrinting):     false,
		string(FeatureAuditLogs):           false,
	}
	for _, def := range Registry {
		if _, known := expected[string(def.Key)]; !known {
			t.Errorf("Registry contains undeclared key %q", def.Key)
			continue
		}
		if expected[string(def.Key)] {
			t.Errorf("Registry contains duplicate key %q", def.Key)
		}
		expected[string(def.Key)] = true
	}
	for k, seen := range expected {
		if !seen {
			t.Errorf("declared constant %q not found in Registry", k)
		}
	}
}

func TestRegistryDefsHaveLabelsAndDesc(t *testing.T) {
	for _, def := range Registry {
		if string(def.Key) == "" {
			t.Errorf("Registry entry has empty key")
		}
		if def.Label == "" {
			t.Errorf("Registry[%s].Label is empty", def.Key)
		}
		if def.Desc == "" {
			t.Errorf("Registry[%s].Desc is empty", def.Key)
		}
		if def.Group == "" {
			t.Errorf("Registry[%s].Group is empty", def.Key)
		}
	}
}

// TestRegistryMatchesFrontendMirror guards against drift between the backend
// Registry and the FE KNOWN_FEATURES map in apps/web/src/lib/features.ts. The
// two must carry the exact same key set (the FE uses them for owner-facing
// labels + the super editor). Skips gracefully if the web file isn't reachable
// (e.g. an API-only checkout).
func TestRegistryMatchesFrontendMirror(t *testing.T) {
	// billing pkg dir → repo root → apps/web/src/lib/features.ts
	path := filepath.Join("..", "..", "..", "web", "src", "lib", "features.ts")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("cannot read FE features.ts (%v); skipping parity check", err)
	}
	src := string(data)

	// Extract the object keys inside KNOWN_FEATURES. Each entry is `  key: {`.
	start := strings.Index(src, "KNOWN_FEATURES")
	if start < 0 {
		t.Fatal("KNOWN_FEATURES not found in features.ts")
	}
	src = src[start:]
	feKeys := map[string]bool{}
	for _, line := range strings.Split(src, "\n") {
		line = strings.TrimSpace(line)
		// Match `<key>: {` where <key> is a lowercase snake_case identifier.
		if !strings.HasSuffix(line, ": {") {
			continue
		}
		key := strings.TrimSuffix(line, ": {")
		if key == "" || strings.ContainsAny(key, " '\"") {
			continue
		}
		feKeys[key] = true
	}

	beKeys := map[string]bool{}
	for _, def := range Registry {
		beKeys[string(def.Key)] = true
	}

	for k := range beKeys {
		if !feKeys[k] {
			t.Errorf("backend Registry key %q missing from FE KNOWN_FEATURES", k)
		}
	}
	for k := range feKeys {
		if !beKeys[k] {
			t.Errorf("FE KNOWN_FEATURES key %q missing from backend Registry", k)
		}
	}
}

func TestIsKnownFeature(t *testing.T) {
	cases := []struct {
		key  string
		want bool
	}{
		{"advanced_analytics", true},
		{"email_shift_summaries", true},
		{"", false},
		{"unknown_feature", false},
		{"ADVANCED_ANALYTICS", false},  // case-sensitive
		{"advanced_analytics ", false}, // trailing space
	}
	for _, tc := range cases {
		got := IsKnownFeature(tc.key)
		if got != tc.want {
			t.Errorf("IsKnownFeature(%q) = %v, want %v", tc.key, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// state.go — edge cases NOT covered by TestComputeState in state_test.go
// ---------------------------------------------------------------------------

func TestComputeState_ExactBoundaries(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)

	t.Run("trial ends exactly now (not in trial)", func(t *testing.T) {
		// trialEndsAt == now → now.Before(now) == false → trial is over
		endsNow := now
		s := ComputeState(now, "standard", intp(5), nil, []string{"email_shift_summaries"}, FeatureOverrides{}, &endsNow, nil, false)
		if s.Phase == PhaseTrial {
			t.Fatal("trial ended exactly now should NOT be PhaseTrial")
		}
		// Should be grace (within 7 days)
		if s.Phase != PhaseGrace {
			t.Fatalf("phase = %q, want grace when trial ends exactly at now", s.Phase)
		}
		if s.WriteLocked {
			t.Fatal("grace should not be write-locked")
		}
	})

	t.Run("trial ends exactly at grace boundary (7 days later)", func(t *testing.T) {
		// Expired exactly 7 days ago → now.Before(trialEndsAt + 7d) checks
		// trialEndsAt = now - 7d; grace end = trialEndsAt + 7d = now
		// now.Before(now) == false → PhaseExpired
		endsAtGraceBoundary := now.Add(-GraceDays * 24 * time.Hour)
		s := ComputeState(now, "standard", intp(5), nil, []string{}, FeatureOverrides{}, &endsAtGraceBoundary, nil, false)
		if s.Phase != PhaseExpired {
			t.Fatalf("phase = %q, want expired at exact grace boundary", s.Phase)
		}
		if !s.WriteLocked {
			t.Fatal("exactly at grace boundary should be write-locked")
		}
	})

	t.Run("trial ends 1ns before now (just entered grace)", func(t *testing.T) {
		justEnded := now.Add(-1)
		s := ComputeState(now, "standard", intp(5), nil, []string{}, FeatureOverrides{}, &justEnded, nil, false)
		if s.Phase != PhaseGrace {
			t.Fatalf("phase = %q, want grace when trial ended 1ns ago", s.Phase)
		}
		if s.WriteLocked {
			t.Fatal("1ns past trial end should still be in grace, not locked")
		}
	})

	t.Run("trial ends 1ns past grace boundary (just expired)", func(t *testing.T) {
		// Expired (7d + 1ns) ago
		justPastGrace := now.Add(-(GraceDays*24*time.Hour + 1))
		s := ComputeState(now, "standard", intp(5), nil, []string{}, FeatureOverrides{}, &justPastGrace, nil, false)
		if s.Phase != PhaseExpired {
			t.Fatalf("phase = %q, want expired when 1ns past grace boundary", s.Phase)
		}
		if !s.WriteLocked {
			t.Fatal("just past grace boundary must be write-locked")
		}
	})
}

func TestComputeState_NilPlanLimit(t *testing.T) {
	// planLimit nil + no override → unlimited
	s := ComputeState(time.Now(), "enterprise", nil, nil, []string{}, FeatureOverrides{}, nil, nil, false)
	if s.EffectiveLimit != nil {
		t.Fatalf("nil planLimit with no override → EffectiveLimit should be nil, got %v", s.EffectiveLimit)
	}
}

func TestComputeState_OverrideZeroNotNil(t *testing.T) {
	// Override pointer is NOT nil but plan limit is nil — override wins.
	override := 10
	s := ComputeState(time.Now(), "enterprise", nil, &override, []string{}, FeatureOverrides{}, nil, nil, false)
	if s.EffectiveLimit == nil || *s.EffectiveLimit != 10 {
		t.Fatalf("EffectiveLimit = %v, want 10", s.EffectiveLimit)
	}
}

func TestComputeState_ManualLockOnExpiredTrial(t *testing.T) {
	// Both manualLock AND trial-expired: PhaseLocked wins (manual overrides expired label).
	now := time.Now()
	longExpired := now.Add(-30 * 24 * time.Hour)
	s := ComputeState(now, "standard", intp(5), nil, []string{}, FeatureOverrides{}, &longExpired, nil, true)
	if s.Phase != PhaseLocked {
		t.Fatalf("phase = %q, want locked when both manual lock and expired trial", s.Phase)
	}
	if !s.WriteLocked {
		t.Fatal("must be write-locked")
	}
}

func TestComputeState_ManualLockOnGraceTenant(t *testing.T) {
	now := time.Now()
	recentEnd := now.Add(-2 * 24 * time.Hour)
	s := ComputeState(now, "standard", intp(5), nil, []string{}, FeatureOverrides{}, &recentEnd, nil, true)
	if s.Phase != PhaseLocked {
		t.Fatalf("phase = %q, want locked", s.Phase)
	}
	if !s.WriteLocked {
		t.Fatal("must be write-locked")
	}
}

func TestComputeState_TrialGrantsAllExceptDefaultOff(t *testing.T) {
	future := time.Now().Add(5 * 24 * time.Hour)
	// Empty plan features — trial should still give everything that isn't
	// default-off (audit_logs is opt-in even during a trial).
	s := ComputeState(time.Now(), "free", nil, nil, []string{}, FeatureOverrides{}, &future, nil, false)
	for _, def := range Registry {
		if def.DefaultOff {
			if s.Has(def.Key) {
				t.Errorf("trial must NOT grant default-off feature %q", def.Key)
			}
			continue
		}
		if !s.Has(def.Key) {
			t.Errorf("trial should grant %q but Has() returned false", def.Key)
		}
	}
}

func TestComputeState_TrialHonorsOverrides(t *testing.T) {
	// During a trial, overrides are now honored: a Revoke drops a feature and a
	// Grant can enable a default-off one.
	future := time.Now().Add(5 * 24 * time.Hour)
	overrides := FeatureOverrides{
		Revoke: []string{string(FeatureAdvancedAnalytics)},
		Grant:  []string{string(FeatureAuditLogs)},
	}
	s := ComputeState(time.Now(), "standard", intp(5), nil, []string{"email_shift_summaries"}, overrides, &future, nil, false)
	if s.Has(FeatureAdvancedAnalytics) {
		t.Fatal("during trial, a Revoke override should drop advanced_analytics")
	}
	if !s.Has(FeatureAuditLogs) {
		t.Fatal("during trial, a Grant override should enable the default-off audit_logs")
	}
}

func TestComputeState_GrantUnknownFeatureKey(t *testing.T) {
	// Granting an unrecognised key is fine for ComputeState (it's just a map entry).
	// Registry-based validation is the super-admin UI's job.
	s := ComputeState(time.Now(), "free", nil, nil, []string{},
		FeatureOverrides{Grant: []string{"future_feature_xyz"}}, nil, nil, false)
	if !s.Features["future_feature_xyz"] {
		t.Fatal("unknown granted feature should still appear in Features map")
	}
}

func TestComputeState_RevokeNonExistentFeature(t *testing.T) {
	// Revoking a feature the plan doesn't have should be a no-op (not panic).
	s := ComputeState(time.Now(), "free", nil, nil, []string{},
		FeatureOverrides{Revoke: []string{"advanced_analytics"}}, nil, nil, false)
	if s.Has(FeatureAdvancedAnalytics) {
		t.Fatal("advanced_analytics was never granted, revoke should leave it absent")
	}
	// Must not panic.
}

func TestComputeState_PlanKeyPreserved(t *testing.T) {
	s := ComputeState(time.Now(), "gold_plan", intp(20), nil, []string{}, FeatureOverrides{}, nil, nil, false)
	if s.PlanKey != "gold_plan" {
		t.Errorf("PlanKey = %q, want %q", s.PlanKey, "gold_plan")
	}
}

func TestComputeState_TrialEndsAtPreserved(t *testing.T) {
	future := time.Now().Add(3 * 24 * time.Hour)
	s := ComputeState(time.Now(), "standard", nil, nil, []string{}, FeatureOverrides{}, &future, nil, false)
	if s.TrialEndsAt == nil {
		t.Fatal("TrialEndsAt should not be nil when a trial is active")
	}
	if !s.TrialEndsAt.Equal(future) {
		t.Errorf("TrialEndsAt = %v, want %v", s.TrialEndsAt, future)
	}
}

func TestComputeState_NoTrialEndsAtNil(t *testing.T) {
	s := ComputeState(time.Now(), "standard", nil, nil, []string{}, FeatureOverrides{}, nil, nil, false)
	if s.TrialEndsAt != nil {
		t.Errorf("TrialEndsAt should be nil when no trial, got %v", s.TrialEndsAt)
	}
}

func TestComputeState_EmptyPlanFeatureList(t *testing.T) {
	s := ComputeState(time.Now(), "free", nil, nil, []string{}, FeatureOverrides{}, nil, nil, false)
	if s.Has(FeatureAdvancedAnalytics) {
		t.Fatal("plan with no features should not have advanced_analytics")
	}
	if s.Has(FeatureEmailShiftSummaries) {
		t.Fatal("plan with no features should not have email_shift_summaries")
	}
}

func TestComputeState_GrantAndRevokeSameKey(t *testing.T) {
	// Revoke runs after Grant per the ComputeState loop order — net result is absent.
	s := ComputeState(time.Now(), "standard", intp(5), nil, []string{},
		FeatureOverrides{
			Grant:  []string{"advanced_analytics"},
			Revoke: []string{"advanced_analytics"},
		}, nil, nil, false)
	if s.Has(FeatureAdvancedAnalytics) {
		t.Fatal("revoke after grant on same key should result in feature being absent")
	}
}

// ---------------------------------------------------------------------------
// State.Has and State.FeatureList
// ---------------------------------------------------------------------------

func TestState_Has(t *testing.T) {
	s := State{
		Features: map[string]bool{
			"advanced_analytics": true,
		},
	}
	if !s.Has(FeatureAdvancedAnalytics) {
		t.Fatal("Has should return true for present feature")
	}
	if s.Has(FeatureEmailShiftSummaries) {
		t.Fatal("Has should return false for absent feature")
	}
}

func TestState_Has_NilFeatureMap(t *testing.T) {
	s := State{} // Features is nil
	// map lookup on nil map returns zero value (false), should not panic
	if s.Has(FeatureAdvancedAnalytics) {
		t.Fatal("nil Features map should behave as empty — Has returns false")
	}
}

func TestState_FeatureList_OrderFollowsRegistry(t *testing.T) {
	// Every registry feature enabled — FeatureList should return them all in
	// registry order.
	all := map[string]bool{}
	for _, def := range Registry {
		all[string(def.Key)] = true
	}
	s := State{Features: all}
	list := s.FeatureList()
	if len(list) != len(Registry) {
		t.Fatalf("FeatureList len = %d, want %d (registry len)", len(list), len(Registry))
	}
	// Order must match Registry order.
	for i, def := range Registry {
		if list[i] != string(def.Key) {
			t.Errorf("FeatureList[%d] = %q, want %q (registry order)", i, list[i], def.Key)
		}
	}
}

func TestState_FeatureList_Partial(t *testing.T) {
	s := State{
		Features: map[string]bool{
			string(FeatureEmailShiftSummaries): true,
			// advanced_analytics absent
		},
	}
	list := s.FeatureList()
	if len(list) != 1 {
		t.Fatalf("expected 1 feature in list, got %d: %v", len(list), list)
	}
	if list[0] != string(FeatureEmailShiftSummaries) {
		t.Errorf("list[0] = %q, want %q", list[0], FeatureEmailShiftSummaries)
	}
}

func TestState_FeatureList_Empty(t *testing.T) {
	s := State{Features: map[string]bool{}}
	list := s.FeatureList()
	if len(list) != 0 {
		t.Fatalf("expected empty list, got %v", list)
	}
}

// ---------------------------------------------------------------------------
// Context helpers: WithState / StateFromContext
// ---------------------------------------------------------------------------

func TestWithState_StateFromContext_RoundTrip(t *testing.T) {
	ctx := context.Background()
	st := State{PlanKey: "pro", WriteLocked: false, Phase: PhaseActive}
	ctx = WithState(ctx, st)
	got, ok := StateFromContext(ctx)
	if !ok {
		t.Fatal("StateFromContext: ok = false, want true")
	}
	if got.PlanKey != "pro" {
		t.Errorf("PlanKey = %q, want %q", got.PlanKey, "pro")
	}
}

func TestStateFromContext_MissingReturnsOkFalse(t *testing.T) {
	_, ok := StateFromContext(context.Background())
	if ok {
		t.Fatal("StateFromContext on empty context should return ok=false")
	}
}

func TestWithState_Overwrites(t *testing.T) {
	ctx := context.Background()
	st1 := State{PlanKey: "free"}
	st2 := State{PlanKey: "pro"}
	ctx = WithState(ctx, st1)
	ctx = WithState(ctx, st2)
	got, ok := StateFromContext(ctx)
	if !ok {
		t.Fatal("StateFromContext: ok = false")
	}
	if got.PlanKey != "pro" {
		t.Errorf("PlanKey = %q, want %q after overwrite", got.PlanKey, "pro")
	}
}

// ---------------------------------------------------------------------------
// middleware.go — WriteGate tests
// ---------------------------------------------------------------------------

// okHandler is a simple http.Handler that writes 200 OK.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func stateCtx(s State) context.Context {
	return WithState(context.Background(), s)
}

func lockedState() State {
	return State{WriteLocked: true, Phase: PhaseLocked}
}

func unlockedState() State {
	return State{WriteLocked: false, Phase: PhaseActive}
}

func TestWriteGate_ReadMethodsAlwaysPass(t *testing.T) {
	handler := WriteGate(okHandler)
	readMethods := []string{http.MethodGet, http.MethodHead, http.MethodOptions}

	for _, method := range readMethods {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/orders", nil)
			req = req.WithContext(WithState(req.Context(), lockedState()))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Errorf("method %s: status = %d, want 200 even when write-locked", method, rr.Code)
			}
		})
	}
}

func TestWriteGate_MutatingMethodsBlockedWhenLocked(t *testing.T) {
	handler := WriteGate(okHandler)
	mutateMethods := []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodPut}

	for _, method := range mutateMethods {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/orders", nil)
			req = req.WithContext(WithState(req.Context(), lockedState()))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != http.StatusPaymentRequired {
				t.Errorf("method %s: status = %d, want 402 when write-locked", method, rr.Code)
			}
		})
	}
}

func TestWriteGate_MutatingMethodsPassWhenNotLocked(t *testing.T) {
	handler := WriteGate(okHandler)
	mutateMethods := []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodPut}

	for _, method := range mutateMethods {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/orders", nil)
			req = req.WithContext(WithState(req.Context(), unlockedState()))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Errorf("method %s: status = %d, want 200 when not locked", method, rr.Code)
			}
		})
	}
}

func TestWriteGate_NoStateInContext_DoesNotBlock(t *testing.T) {
	// If no billing state is present (shouldn't happen in prod but must not panic).
	handler := WriteGate(okHandler)
	req := httptest.NewRequest(http.MethodPost, "/orders", nil)
	// No state in context.
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 when no billing state in context", rr.Code)
	}
}

func TestWriteGate_LockedReturns402JSONBody(t *testing.T) {
	handler := WriteGate(okHandler)
	req := httptest.NewRequest(http.MethodPost, "/orders", nil)
	req = req.WithContext(WithState(req.Context(), lockedState()))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rr.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("response body is not valid JSON: %v", err)
	}
	if body["code"] != "write_locked" {
		t.Errorf("code = %q, want %q", body["code"], "write_locked")
	}
	if body["message"] == "" {
		t.Error("message field should not be empty")
	}
}

func TestWriteGate_WsTicketBypassWithChiRouteContext(t *testing.T) {
	// Mount a chi router so the RoutePattern is set to "/ws-ticket".
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			// Inject a locked billing state.
			req = req.WithContext(WithState(req.Context(), lockedState()))
			next.ServeHTTP(w, req)
		})
	})
	r.With(WriteGate).Post("/ws-ticket", okHandler)

	req := httptest.NewRequest(http.MethodPost, "/ws-ticket", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("ws-ticket bypass: status = %d, want 200 even when write-locked", rr.Code)
	}
}

func TestWriteGate_OtherPostRoutesNotBypassed(t *testing.T) {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req = req.WithContext(WithState(req.Context(), lockedState()))
			next.ServeHTTP(w, req)
		})
	})
	r.With(WriteGate).Post("/orders", okHandler)

	req := httptest.NewRequest(http.MethodPost, "/orders", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusPaymentRequired {
		t.Errorf("orders: status = %d, want 402", rr.Code)
	}
}

func TestWriteGate_GracePhaseWritesAllowed(t *testing.T) {
	// Grace phase: WriteLocked == false, writes should pass.
	s := State{WriteLocked: false, Phase: PhaseGrace}
	handler := WriteGate(okHandler)
	req := httptest.NewRequest(http.MethodPost, "/orders", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("grace phase: status = %d, want 200", rr.Code)
	}
}

func TestWriteGate_ExpiredPhaseWritesBlocked(t *testing.T) {
	s := State{WriteLocked: true, Phase: PhaseExpired}
	handler := WriteGate(okHandler)
	req := httptest.NewRequest(http.MethodPost, "/orders", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusPaymentRequired {
		t.Errorf("expired phase: status = %d, want 402", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// middleware.go — RequireFeature tests
// ---------------------------------------------------------------------------

func TestRequireFeature_PassesWhenFeaturePresent(t *testing.T) {
	s := State{
		Features: map[string]bool{string(FeatureAdvancedAnalytics): true},
	}
	handler := RequireFeature(FeatureAdvancedAnalytics)(okHandler)
	req := httptest.NewRequest(http.MethodGet, "/reports/top-sellers", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 when feature present", rr.Code)
	}
}

func TestRequireFeature_BlocksWhenFeatureAbsent(t *testing.T) {
	s := State{
		Features: map[string]bool{},
	}
	handler := RequireFeature(FeatureAdvancedAnalytics)(okHandler)
	req := httptest.NewRequest(http.MethodGet, "/reports/top-sellers", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 when feature absent", rr.Code)
	}
}

func TestRequireFeature_BlocksWhenNoStateInContext(t *testing.T) {
	handler := RequireFeature(FeatureAdvancedAnalytics)(okHandler)
	req := httptest.NewRequest(http.MethodGet, "/reports/top-sellers", nil)
	// No state in context.
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 when no billing state in context", rr.Code)
	}
}

func TestRequireFeature_BlocksReturn403JSONBody(t *testing.T) {
	s := State{Features: map[string]bool{}}
	handler := RequireFeature(FeatureEmailShiftSummaries)(okHandler)
	req := httptest.NewRequest(http.MethodGet, "/reports/heatmap", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("response body is not valid JSON: %v", err)
	}
	if body["code"] != "plan_upgrade_required" {
		t.Errorf("code = %q, want %q", body["code"], "plan_upgrade_required")
	}
	if !strings.Contains(body["message"], string(FeatureEmailShiftSummaries)) {
		t.Errorf("message %q should mention the feature key", body["message"])
	}
}

func TestRequireFeature_TrialGrantsPassAll(t *testing.T) {
	// During trial ComputeState sets all non-default-off Registry features to
	// true. Default-off features (audit_logs) stay gated even in trial.
	future := time.Now().Add(5 * 24 * time.Hour)
	s := ComputeState(time.Now(), "free", nil, nil, []string{}, FeatureOverrides{}, &future, nil, false)

	for _, def := range Registry {
		if def.DefaultOff {
			continue
		}
		t.Run(string(def.Key), func(t *testing.T) {
			handler := RequireFeature(def.Key)(okHandler)
			req := httptest.NewRequest(http.MethodGet, "/reports/heatmap", nil)
			req = req.WithContext(WithState(req.Context(), s))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Errorf("trial tenant: feature %q blocked (got %d), want 200", def.Key, rr.Code)
			}
		})
	}
}

func TestRequireFeature_MultipleMiddlewaresChained(t *testing.T) {
	// Both features enabled — should pass through the chain.
	s := State{
		Features: map[string]bool{
			string(FeatureAdvancedAnalytics):   true,
			string(FeatureEmailShiftSummaries): true,
		},
	}
	handler := RequireFeature(FeatureAdvancedAnalytics)(
		RequireFeature(FeatureEmailShiftSummaries)(okHandler),
	)
	req := httptest.NewRequest(http.MethodGet, "/reports/top-sellers", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("chained features both present: status = %d, want 200", rr.Code)
	}
}

func TestRequireFeature_MultipleMiddlewaresFirstMissing(t *testing.T) {
	// First feature absent — should 403 before reaching second.
	s := State{
		Features: map[string]bool{
			string(FeatureEmailShiftSummaries): true,
			// FeatureAdvancedAnalytics absent
		},
	}
	handler := RequireFeature(FeatureAdvancedAnalytics)(
		RequireFeature(FeatureEmailShiftSummaries)(okHandler),
	)
	req := httptest.NewRequest(http.MethodGet, "/reports/heatmap", nil)
	req = req.WithContext(WithState(req.Context(), s))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("first feature absent: status = %d, want 403", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// isReadMethod tests (tested via WriteGate; also directly via internal func)
// ---------------------------------------------------------------------------

func TestIsReadMethod(t *testing.T) {
	cases := []struct {
		method string
		want   bool
	}{
		{http.MethodGet, true},
		{http.MethodHead, true},
		{http.MethodOptions, true},
		{http.MethodPost, false},
		{http.MethodPatch, false},
		{http.MethodDelete, false},
		{http.MethodPut, false},
		{"get", true}, // lowercase — function does ToUpper
		{"POST", false},
	}
	for _, tc := range cases {
		got := isReadMethod(tc.method)
		if got != tc.want {
			t.Errorf("isReadMethod(%q) = %v, want %v", tc.method, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// repo.go — LoadStateTx integration tests (skipped when DB unavailable)
// ---------------------------------------------------------------------------

func TestLoadStateTx_BasicActiveTenant(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	// Create a plan with no features.
	planID := uuid.New()
	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-test-%s", tenantID.String()[:8])

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx,
		`INSERT INTO plans (id, key, name, member_limit, active) VALUES ($1, $2, $3, $4, true)`,
		planID, "billing-test-plan-"+tenantID.String()[:8], "Billing Test Plan", 10,
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, plan_id, billing_state)
		 VALUES ($1, $2, 'Test Cafe', $3, 'ok')`,
		tenantID, slug, planID,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx: %v", err)
	}
	if state.WriteLocked {
		t.Error("fresh tenant should not be write-locked")
	}
	if state.Phase != PhaseActive {
		t.Errorf("phase = %q, want active", state.Phase)
	}
	if state.EffectiveLimit == nil || *state.EffectiveLimit != 10 {
		t.Errorf("EffectiveLimit = %v, want 10", state.EffectiveLimit)
	}
}

func TestLoadStateTx_WriteLocked(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	planID := uuid.New()
	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-lock-%s", tenantID.String()[:8])

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx,
		`INSERT INTO plans (id, key, name, active) VALUES ($1, $2, $3, true)`,
		planID, "billing-lock-plan-"+tenantID.String()[:8], "Lock Test Plan",
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, plan_id, billing_state)
		 VALUES ($1, $2, 'Locked Cafe', $3, 'write_locked')`,
		tenantID, slug, planID,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx: %v", err)
	}
	if !state.WriteLocked {
		t.Error("billing_state=write_locked should produce WriteLocked=true")
	}
	if state.Phase != PhaseLocked {
		t.Errorf("phase = %q, want locked", state.Phase)
	}
}

func TestLoadStateTx_WithPlanFeatures(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	planID := uuid.New()
	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-feat-%s", tenantID.String()[:8])

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx,
		`INSERT INTO plans (id, key, name, active) VALUES ($1, $2, $3, true)`,
		planID, "billing-feat-plan-"+tenantID.String()[:8], "Feature Plan",
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO plan_features (plan_id, feature_key) VALUES ($1, $2)`,
		planID, string(FeatureAdvancedAnalytics),
	)
	if err != nil {
		t.Fatalf("insert plan_feature: %v", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, plan_id, billing_state)
		 VALUES ($1, $2, 'Feature Cafe', $3, 'ok')`,
		tenantID, slug, planID,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx: %v", err)
	}
	if !state.Has(FeatureAdvancedAnalytics) {
		t.Error("plan has advanced_analytics in plan_features but state does not include it")
	}
	if state.Has(FeatureEmailShiftSummaries) {
		t.Error("plan does not have email_shift_summaries but state includes it")
	}
}

func TestLoadStateTx_FeatureOverridesApplied(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	planID := uuid.New()
	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-ovrd-%s", tenantID.String()[:8])

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx,
		`INSERT INTO plans (id, key, name, active) VALUES ($1, $2, $3, true)`,
		planID, "billing-ovrd-plan-"+tenantID.String()[:8], "Override Plan",
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	// Plan has email_shift_summaries; tenant override revokes it and grants advanced_analytics.
	_, err = tx.Exec(ctx,
		`INSERT INTO plan_features (plan_id, feature_key) VALUES ($1, $2)`,
		planID, string(FeatureEmailShiftSummaries),
	)
	if err != nil {
		t.Fatalf("insert plan_feature: %v", err)
	}

	overridesJSON := `{"grant":["advanced_analytics"],"revoke":["email_shift_summaries"]}`
	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, plan_id, billing_state, feature_overrides)
		 VALUES ($1, $2, 'Override Cafe', $3, 'ok', $4)`,
		tenantID, slug, planID, overridesJSON,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx: %v", err)
	}
	if !state.Has(FeatureAdvancedAnalytics) {
		t.Error("grant override for advanced_analytics not applied")
	}
	if state.Has(FeatureEmailShiftSummaries) {
		t.Error("revoke override for email_shift_summaries not applied")
	}
}

func TestLoadStateTx_ActiveTrial(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	planID := uuid.New()
	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-trial-%s", tenantID.String()[:8])
	future := time.Now().Add(10 * 24 * time.Hour)

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx,
		`INSERT INTO plans (id, key, name, active) VALUES ($1, $2, $3, true)`,
		planID, "billing-trial-plan-"+tenantID.String()[:8], "Trial Plan",
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, plan_id, billing_state, trial_ends_at)
		 VALUES ($1, $2, 'Trial Cafe', $3, 'ok', $4)`,
		tenantID, slug, planID, future,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx: %v", err)
	}
	if state.Phase != PhaseTrial {
		t.Errorf("phase = %q, want trial", state.Phase)
	}
	if state.WriteLocked {
		t.Error("trial tenant should not be write-locked")
	}
	// All non-default-off features should be active during trial; default-off
	// ones (audit_logs) stay off unless explicitly granted.
	for _, def := range Registry {
		if def.DefaultOff {
			if state.Has(def.Key) {
				t.Errorf("trial must NOT grant default-off feature %q", def.Key)
			}
			continue
		}
		if !state.Has(def.Key) {
			t.Errorf("trial should grant feature %q", def.Key)
		}
	}
}

func TestLoadStateTx_MemberLimitOverride(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	planID := uuid.New()
	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-mlim-%s", tenantID.String()[:8])

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx,
		`INSERT INTO plans (id, key, name, member_limit, active) VALUES ($1, $2, $3, 5, true)`,
		planID, "billing-mlim-plan-"+tenantID.String()[:8], "Limit Plan",
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, plan_id, billing_state, member_limit_override)
		 VALUES ($1, $2, 'Limit Cafe', $3, 'ok', 50)`,
		tenantID, slug, planID,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx: %v", err)
	}
	if state.EffectiveLimit == nil || *state.EffectiveLimit != 50 {
		t.Errorf("EffectiveLimit = %v, want 50 (override beats plan limit)", state.EffectiveLimit)
	}
}

func TestLoadStateTx_NoPlanRow(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	tenantID := uuid.New()
	slug := fmt.Sprintf("billing-noplan-%s", tenantID.String()[:8])

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Tenant with no plan_id (NULL).
	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, billing_state)
		 VALUES ($1, $2, 'No Plan Cafe', 'ok')`,
		tenantID, slug,
	)
	if err != nil {
		t.Fatalf("insert tenant: %v", err)
	}

	state, err := LoadStateTx(ctx, tx, tenantID)
	if err != nil {
		t.Fatalf("LoadStateTx with null plan_id should not error: %v", err)
	}
	// plan key coalesces to "" when plan is null.
	if state.PlanKey != "" {
		t.Errorf("PlanKey = %q, want empty string for null plan", state.PlanKey)
	}
	if state.Phase != PhaseActive {
		t.Errorf("phase = %q, want active", state.Phase)
	}
}

func TestLoadStateTx_NonExistentTenantReturnsError(t *testing.T) {
	requireBillingDB(t)
	ctx := context.Background()

	tx, err := billingPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = LoadStateTx(ctx, tx, uuid.New())
	if err == nil {
		t.Fatal("LoadStateTx with non-existent tenantID should return an error")
	}
}
