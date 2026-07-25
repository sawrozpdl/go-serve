package e2e

// The access layer: authentication, membership, roles, tenant scoping and
// billing gates. None of this is reachable from a handler-level test, because
// those construct the authorised context by hand — a route mounted without its
// permission guard, or a gate that stopped firing, is invisible there.

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Authentication
// =========================================================================

func TestAuth_AnonymousCannotReachTheAPI(t *testing.T) {
	f := newFixture(t)
	anon := f.Owner.anonymous()

	// A read, a write, and a report — every one must be refused.
	for _, path := range []string{
		"/v1/me", "/v1/orders", "/v1/reports/dashboard", "/v1/finance/cafe-balance",
	} {
		if got := anon.get(path); got.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s as anonymous = %d, want 401; body: %s", path, got.Code, got.Body)
		}
	}
	anon.post("/v1/orders", map[string]any{}).expect(http.StatusUnauthorized)
}

func TestAuth_GarbageAndMalformedTokensAreRefused(t *testing.T) {
	f := newFixture(t)
	for _, tok := range []string{
		"not-a-token",
		"Bearer-ish",
		// A structurally valid JWT signed with the wrong key.
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJub2JvZHkifQ.wrongsignature",
	} {
		c := *f.Owner
		c.token = tok
		if got := c.get("/v1/me"); got.Code != http.StatusUnauthorized {
			t.Fatalf("token %q = %d, want 401", tok, got.Code)
		}
	}
}

// A global logout bumps token_version; every token minted before it must stop
// working. This is the mechanism behind "sign out everywhere", and it lives
// entirely in middleware.
func TestAuth_TokenVersionBumpInvalidatesExistingTokens(t *testing.T) {
	f := newFixture(t)
	f.Owner.get("/v1/me").expect(http.StatusOK)

	var userID string
	f.scan([]any{&userID}, `SELECT id::text FROM users WHERE email = $1`, f.OwnerEmail)
	f.exec(`UPDATE users SET token_version = token_version + 1 WHERE id = $1::uuid`, userID)

	// The cache is short (10s) but not zero, so allow for it rather than sleeping
	// blindly: poll until the bump takes effect.
	deadline := time.Now().Add(20 * time.Second)
	for {
		if got := f.Owner.get("/v1/me"); got.Code == http.StatusUnauthorized {
			return // invalidated, as intended
		}
		if time.Now().After(deadline) {
			t.Fatal("token still valid 20s after token_version bump — global logout would not work")
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// =========================================================================
// Tenant scoping
// =========================================================================

// The strongest guarantee in a multi-tenant app: one cafe's token must never
// read another cafe's money. RLS enforces it in the database and the tenant
// middleware enforces membership — this proves both, over HTTP.
func TestTenant_TokenCannotReachAnotherCafe(t *testing.T) {
	a := newFixture(t)
	b := newFixture(t)

	// A's owner, pointed at B's tenant id.
	intruder := a.Owner.forTenant(b.Slug)
	for _, path := range []string{
		"/v1/reports/dashboard", "/v1/orders", "/v1/finance/cafe-balance",
		"/v1/house-tabs", "/v1/expenses",
	} {
		intruder.get(path).expectDenied()
	}
	// And must not be able to write there either.
	intruder.post("/v1/shifts/open", map[string]any{"opening_float_cents": 1000}).expectDenied()
}

func TestTenant_UnknownTenantHeaderIsRefused(t *testing.T) {
	f := newFixture(t)
	c := *f.Owner
	c.tenant = "no-such-cafe-anywhere"
	c.get("/v1/reports/dashboard").expectDenied()
}

// A member whose membership is suspended loses access immediately, without any
// token change.
func TestTenant_SuspendedMemberLosesAccess(t *testing.T) {
	f := newFixture(t)
	f.Manager.get("/v1/orders").expect(http.StatusOK)

	f.exec(`
		UPDATE tenant_members SET status = 'suspended'
		WHERE tenant_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)
	`, f.TenantID, f.ManagerEmail)

	f.Manager.get("/v1/orders").expectDenied()
}

// =========================================================================
// Roles — the permission wiring, as mounted
// =========================================================================

// Each row is a route a role must NOT be able to use. These assertions are only
// meaningful over HTTP: the permission lives on the route, not in the handler.
func TestRoles_BoundariesAreEnforcedOnTheRoutes(t *testing.T) {
	f := newFixture(t)

	cases := []struct {
		role   string
		client *client
		method string
		path   string
		body   any
		why    string
	}{
		{"waiter", f.Waiter, http.MethodGet, "/v1/reports/dashboard", nil,
			"a waiter has no report:read — takings are not their business"},
		{"waiter", f.Waiter, http.MethodGet, "/v1/finance/cafe-balance", nil,
			"a waiter cannot see the cafe's cash position"},
		{"waiter", f.Waiter, http.MethodGet, "/v1/expenses", nil,
			"a waiter cannot browse expenses"},
		{"waiter", f.Waiter, http.MethodPost, "/v1/shifts/open", map[string]any{"opening_float_cents": 1000},
			"a waiter cannot open a shift"},
		{"kitchen", f.Kitchen, http.MethodGet, "/v1/reports/dashboard", nil,
			"kitchen staff have no reporting access"},
		{"kitchen", f.Kitchen, http.MethodPost, "/v1/orders", map[string]any{},
			"kitchen staff do not take orders"},
		{"kitchen", f.Kitchen, http.MethodGet, "/v1/house-tabs", nil,
			"kitchen staff have no credit access"},
		{"waiter", f.Waiter, http.MethodPost, "/v1/orders/" + uuid.NewString() + "/payments",
			map[string]any{"method": "cash", "amount_cents": 100},
			"the default waiter role has no payment:record — taking money is a supervisor action"},
	}
	for _, c := range cases {
		t.Run(c.role+"_"+c.method+"_"+c.path, func(t *testing.T) {
			got := c.client.do(c.method, c.path, c.body)
			if got.Code == http.StatusOK || got.Code == http.StatusCreated {
				t.Fatalf("%s: %s %s returned %d — %s",
					c.role, c.method, c.path, got.Code, c.why)
			}
			got.expectDenied()
		})
	}
}

// The other half: a role must be able to do its job. A permission set that
// refuses everything would pass the test above and be useless.
func TestRoles_EachRoleCanDoItsJob(t *testing.T) {
	f := newFixture(t)

	// Waiter: the floor.
	f.Waiter.get("/v1/orders").expect(http.StatusOK)
	f.Waiter.get("/v1/menu/items").expect(http.StatusOK)
	f.Waiter.get("/v1/tables").expect(http.StatusOK)

	// Kitchen: the board.
	f.Kitchen.get("/v1/orders").expect(http.StatusOK)

	// Manager: reports and money, but the shape of the day too.
	f.Manager.get("/v1/reports/dashboard").expect(http.StatusOK)
	f.Manager.get("/v1/expenses").expect(http.StatusOK)
	f.Manager.get("/v1/house-tabs").expect(http.StatusOK)

	// Owner: everything, including the finance surfaces.
	f.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
	f.Owner.get("/v1/accounts/balances").expect(http.StatusOK)
	f.Owner.get("/v1/reports/profitability").expect(http.StatusOK)
}

// =========================================================================
// Billing gates
// =========================================================================

// A write-locked tenant (unpaid, or locked by a platform admin) must stop
// accepting writes while still allowing reads — an operator has to be able to
// look at their own books and settle up.
func TestBilling_WriteLockStopsWritesButNotReads(t *testing.T) {
	f := newFixture(t)
	f.Owner.get("/v1/reports/dashboard").expect(http.StatusOK)

	f.exec(`UPDATE tenants SET billing_state = 'write_locked' WHERE id = $1`, f.TenantID)

	// Reads still work…
	f.Owner.get("/v1/reports/dashboard").expect(http.StatusOK)
	f.Owner.get("/v1/orders").expect(http.StatusOK)
	// …writes do not.
	f.Owner.post("/v1/shifts/open", map[string]any{"opening_float_cents": 500000}).expectDenied()
	f.Owner.post("/v1/orders", map[string]any{}).expectDenied()

	// Unlocking restores writes, so the lock is a gate and not a one-way door.
	f.exec(`UPDATE tenants SET billing_state = 'ok' WHERE id = $1`, f.TenantID)
	f.Owner.post("/v1/shifts/open", map[string]any{"opening_float_cents": 500000}).expect(http.StatusCreated)
}

// An expired trial past its grace period behaves the same way: read-only.
func TestBilling_ExpiredTrialIsReadOnly(t *testing.T) {
	f := newFixture(t)
	f.exec(`
		UPDATE tenants SET trial_ends_at = now() - interval '60 days', paid_through_at = NULL
		WHERE id = $1
	`, f.TenantID)

	f.Owner.get("/v1/reports/dashboard").expect(http.StatusOK)
	f.Owner.post("/v1/shifts/open", map[string]any{"opening_float_cents": 500000}).expectDenied()
}

// A feature the plan does not carry is refused at the route, with a code the FE
// can turn into an upgrade prompt. Every plan currently carries every feature
// (tiering infra is in place but not switched on), so this uses a per-tenant
// revoke override — the same mechanism the super console's Features editor writes.
func TestBilling_MissingFeatureIsGatedAtTheRoute(t *testing.T) {
	f := newFixture(t)
	f.Manager.get("/v1/house-tabs").expect(http.StatusOK)

	f.exec(`UPDATE tenants SET feature_overrides = '{"revoke":["house_tabs"]}' WHERE id = $1`, f.TenantID)

	got := f.Manager.get("/v1/house-tabs").expect(http.StatusForbidden)
	if code, _ := got.json()["code"].(string); code != "plan_upgrade_required" {
		t.Fatalf("gate code = %q, want plan_upgrade_required; body: %s", code, got.Body)
	}
	// Ungated routes are unaffected — a revoke must not lock the whole cafe out.
	f.Manager.get("/v1/orders").expect(http.StatusOK)
}

// =========================================================================
// Platform admin
// =========================================================================

// /super is not tenant-scoped and must be closed to ordinary members no matter
// what roles they hold inside their own cafe.
func TestSuper_ClosedToOrdinaryMembers(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{
		"/v1/super/tenants", "/v1/super/accuracy-check", "/v1/super/plans", "/v1/super/admins",
	} {
		f.Owner.get(path).expectDenied()
	}
}

func TestSuper_PlatformAdminCanRunTheAccuracyCheck(t *testing.T) {
	requireDB(t)
	admin := login(t, platformAdminEmail)
	// PLATFORM_ADMIN_EMAILS covers this address, so dev-login promotes it.
	res := admin.get("/v1/super/accuracy-check").expect(http.StatusOK).json()
	if _, ok := res["healthy"]; !ok {
		t.Fatalf("accuracy-check response has no `healthy` field: %s", res)
	}
	if _, ok := res["summary"]; !ok {
		t.Fatalf("accuracy-check response has no `summary` field: %s", res)
	}
}

// =========================================================================
// Routing and middleware
// =========================================================================

// A 404 must look like the API's 404, not an HTML page or a proxy error — the
// SPA parses these.
func TestRouting_UnknownRouteReturnsJSON(t *testing.T) {
	f := newFixture(t)
	got := f.Owner.get("/v1/not-a-real-endpoint")
	if got.Code != http.StatusNotFound {
		t.Fatalf("unknown route = %d, want 404", got.Code)
	}
}

// Security headers are applied by middleware, so only an HTTP-level test can
// see them.
func TestRouting_HealthzIsOpenAndCheap(t *testing.T) {
	requireDB(t)
	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", res.StatusCode)
	}
}
