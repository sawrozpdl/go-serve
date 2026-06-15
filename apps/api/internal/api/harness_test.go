package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// testHub is a real hub with no subscribers: BroadcastAfterCommit / Broadcast
// become no-ops, so handlers that broadcast are exercised without needing a
// live WebSocket client.
func testHub() *realtime.Hub { return realtime.New(discardLogger()) }

// fixture is one throwaway tenant + its owner user, created via the admin pool
// and torn down (CASCADE) at test end.
type fixture struct {
	t      *testing.T
	Tenant uuid.UUID
	Slug   string
	Name   string
	User   uuid.UUID // owner
	Email  string
	Roles  []string
}

// newTenant creates a fresh tenant + owner member and registers cleanup.
func newTenant(t *testing.T) *fixture {
	t.Helper()
	requireDB(t)
	ctx := context.Background()
	suffix := uuid.NewString()[:8]

	fx := &fixture{
		t:     t,
		Slug:  "test-" + suffix,
		Name:  "Test Cafe " + suffix,
		Email: "owner-" + suffix + "@test.local",
		Roles: []string{"owner"},
	}

	// vat_mode defaults to 'none' (migration 0036), but the bulk of the suite
	// was written assuming VAT is added on top at 13% (the column default for
	// vat_pct). Seed 'exclusive' so those expectations hold; mode-specific
	// tests override via setTenantVat.
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO tenants (slug, name, vat_mode) VALUES ($1, $2, 'exclusive') RETURNING id`,
		fx.Slug, fx.Name,
	).Scan(&fx.Tenant); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		fx.Email, "Owner "+suffix,
	).Scan(&fx.User); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		fx.Tenant, fx.User); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = adminPool.Exec(bg, `DELETE FROM tenants WHERE id = $1`, fx.Tenant)
		_, _ = adminPool.Exec(bg, `DELETE FROM users WHERE id = $1`, fx.User)
	})
	return fx
}

// addUser creates an additional user and makes them an active member of the
// fixture tenant. Returned id is cleaned up with the test.
func (fx *fixture) addUser(name string) uuid.UUID {
	fx.t.Helper()
	ctx := context.Background()
	suffix := uuid.NewString()[:8]
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		name+"-"+suffix+"@test.local", name,
	).Scan(&id); err != nil {
		fx.t.Fatalf("addUser: %v", err)
	}
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		fx.Tenant, id); err != nil {
		fx.t.Fatalf("addUser member: %v", err)
	}
	fx.t.Cleanup(func() { _, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
	return id
}

// admin runs fn with the superuser pool (RLS bypassed) for raw fixture setup
// and assertions that need to see across tenants.
func (fx *fixture) adminExec(sql string, args ...any) {
	fx.t.Helper()
	if _, err := adminPool.Exec(context.Background(), sql, args...); err != nil {
		fx.t.Fatalf("adminExec %q: %v", sql, err)
	}
}

func (fx *fixture) adminScan(dst []any, sql string, args ...any) {
	fx.t.Helper()
	if err := adminPool.QueryRow(context.Background(), sql, args...).Scan(dst...); err != nil {
		fx.t.Fatalf("adminScan %q: %v", sql, err)
	}
}

// =========================================================================
// callHandler — invoke a handler in an RLS-scoped app-pool transaction, just
// like db.TxMiddleware does at runtime.
// =========================================================================

type reqOpts struct {
	params map[string]string // chi URL params
	query  string            // raw query string (no leading '?')
	// actAs overrides the acting user (defaults to the fixture owner).
	actAs uuid.UUID
	// noTenant runs without a tenant context (identity-scoped handlers).
	noTenant bool
}

type apiResp struct {
	t    *testing.T
	Code int
	Body []byte
	Hdr  http.Header
}

// callHandler builds a request, opens an app-pool tx with the fixture's tenant
// + user set for RLS, runs the handler, and commits when status < 500 (mirrors
// db.TxMiddleware) so writes persist for follow-up calls in the same test.
func callHandler(t *testing.T, fx *fixture, h http.HandlerFunc, method, target string, body any, opts ...func(*reqOpts)) *apiResp {
	t.Helper()
	requireDB(t)

	o := reqOpts{params: map[string]string{}}
	for _, fn := range opts {
		fn(&o)
	}
	acting := fx.User
	if o.actAs != uuid.Nil {
		acting = o.actAs
	}

	var rdr io.Reader
	switch b := body.(type) {
	case nil:
		rdr = nil
	case string:
		rdr = bytes.NewBufferString(b)
	case []byte:
		rdr = bytes.NewBuffer(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rdr = bytes.NewBuffer(raw)
	}

	url := target
	if o.query != "" {
		url += "?" + o.query
	}
	req := httptest.NewRequest(method, url, rdr)
	req.Header.Set("Content-Type", "application/json")

	// chi route params.
	rctx := chi.NewRouteContext()
	for k, v := range o.params {
		rctx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

	// Open the app-pool tx and set RLS GUCs, exactly like TxMiddleware.
	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	if !o.noTenant {
		if _, err := tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
			t.Fatalf("set tenant: %v", err)
		}
		ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug, Name: fx.Name, Timezone: "Asia/Kathmandu"})
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", acting.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}

	var email, name string
	_ = adminPool.QueryRow(bg, `SELECT email, name FROM users WHERE id = $1`, acting).Scan(&email, &name)
	ctx = appctx.WithUser(ctx, appctx.User{ID: acting, Email: email, Name: name})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")

	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code < 500 {
		// Mirror db.TxMiddleware exactly: attempt commit, but TOLERATE a commit
		// error. A handler that hit e.g. a unique-constraint violation aborts
		// the tx yet still returns a 4xx; prod ignores the resulting commit
		// failure (the response already stands) and the defer rolls back. Only
		// run post-commit hooks (broadcasts) when the commit actually succeeds.
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}

	return &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

// =========================================================================
// response assertion helpers
// =========================================================================

func (r *apiResp) expectStatus(want int) *apiResp {
	r.t.Helper()
	if r.Code != want {
		r.t.Fatalf("status = %d, want %d; body: %s", r.Code, want, string(r.Body))
	}
	return r
}

// errKind extracts the machine error code from a respond.Err body, which is
// the canonical {"code":"...","message":"..."} shape.
func (r *apiResp) errKind() string {
	r.t.Helper()
	var env struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(r.Body, &env); err != nil {
		return ""
	}
	return env.Code
}

// errMsg returns the human-readable message from a respond.Err body.
func (r *apiResp) errMsg() string {
	r.t.Helper()
	var env struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(r.Body, &env)
	return env.Message
}

func (r *apiResp) expectErr(status int, kind string) *apiResp {
	r.t.Helper()
	r.expectStatus(status)
	if got := r.errKind(); got != kind {
		r.t.Fatalf("error kind = %q, want %q; body: %s", got, kind, string(r.Body))
	}
	return r
}

// decode unmarshals the JSON body into dst.
func (r *apiResp) decode(dst any) *apiResp {
	r.t.Helper()
	if err := json.Unmarshal(r.Body, dst); err != nil {
		r.t.Fatalf("decode body %q: %v", string(r.Body), err)
	}
	return r
}

// json returns the body parsed into a generic map.
func (r *apiResp) json() map[string]any {
	r.t.Helper()
	m := map[string]any{}
	r.decode(&m)
	return m
}

// option helpers for callHandler.
func withParam(k, v string) func(*reqOpts) { return func(o *reqOpts) { o.params[k] = v } }
func withParams(kv map[string]string) func(*reqOpts) {
	return func(o *reqOpts) {
		for k, v := range kv {
			o.params[k] = v
		}
	}
}
func withQuery(q string) func(*reqOpts)    { return func(o *reqOpts) { o.query = q } }
func actingAs(id uuid.UUID) func(*reqOpts) { return func(o *reqOpts) { o.actAs = id } }
func withoutTenant() func(*reqOpts)        { return func(o *reqOpts) { o.noTenant = true } }

// =========================================================================
// fixture seeding helpers (via admin pool) — fast row creation for setup.
// =========================================================================

func (fx *fixture) seedCategory(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_categories (tenant_id, name) VALUES ($1, $2) RETURNING id`,
		fx.Tenant, name)
	return id
}

func (fx *fixture) seedMenuItem(catID uuid.UUID, name string, priceCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents) VALUES ($1, $2, $3, $4) RETURNING id`,
		fx.Tenant, catID, name, priceCents)
	return id
}

func (fx *fixture) seedTable(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO service_tables (tenant_id, name) VALUES ($1, $2) RETURNING id`,
		fx.Tenant, name)
	return id
}

// seedOpenOrder inserts an order row directly (status open) and returns its id.
func (fx *fixture) seedOpenOrder(tableID *uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO orders (tenant_id, service_table_id, opened_by_user_id, status)
		 VALUES ($1, $2, $3, 'open') RETURNING id`,
		fx.Tenant, tableID, fx.User)
	return id
}

// seedOrderItem adds a line to an order.
func (fx *fixture) seedOrderItem(orderID, menuItemID uuid.UUID, qty int, unitPriceCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO order_items (tenant_id, order_id, menu_item_id, qty, unit_price_cents)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		fx.Tenant, orderID, menuItemID, qty, unitPriceCents)
	return id
}

// seedOpenShift opens a cash drawer shift and returns its id.
func (fx *fixture) seedOpenShift(openingFloatCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents)
		 VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, fx.User, openingFloatCents)
	return id
}

func (fx *fixture) seedHouseTab(name string, active bool) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO house_tabs (tenant_id, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, name, active)
	return id
}

// seedPayment inserts a payment row directly. shift may be nil.
func (fx *fixture) seedPayment(orderID uuid.UUID, method string, amountCents int64, shift *uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO payments (tenant_id, order_id, shift_id, method, amount_cents, recorded_by_user_id)
		 VALUES ($1, $2, $3, $4::payment_method, $5, $6) RETURNING id`,
		fx.Tenant, orderID, shift, method, amountCents, fx.User)
	return id
}

// setOrderStatus forces an order into a terminal status (closed/cancelled) for
// "not open" assertions.
func (fx *fixture) setOrderStatus(orderID uuid.UUID, status string) {
	fx.t.Helper()
	fx.adminExec(`UPDATE orders SET status = $2::order_status WHERE id = $1`, orderID, status)
}

// closeShift stamps closed_at so reclassify "shift_closed" paths can be tested.
func (fx *fixture) closeShift(shiftID uuid.UUID) {
	fx.t.Helper()
	fx.adminExec(`UPDATE shifts SET closed_at = now(), closed_by_user_id = $2 WHERE id = $1`, shiftID, fx.User)
}

// orderStatus reads an order's current status.
func (fx *fixture) orderStatus(orderID uuid.UUID) string {
	fx.t.Helper()
	var s string
	fx.adminScan([]any{&s}, `SELECT status::text FROM orders WHERE id = $1`, orderID)
	return s
}

// tableStatus reads a service table's current status.
func (fx *fixture) tableStatus(tableID uuid.UUID) string {
	fx.t.Helper()
	var s string
	fx.adminScan([]any{&s}, `SELECT status::text FROM service_tables WHERE id = $1`, tableID)
	return s
}

// setTenantPref merges a key into the tenant preferences jsonb.
func (fx *fixture) setTenantPref(key string, value any) {
	fx.t.Helper()
	raw, _ := json.Marshal(value)
	fx.adminExec(
		`UPDATE tenants SET preferences = preferences || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`,
		fx.Tenant, key, string(raw))
}

// setTenantRates sets the service-charge and VAT percentages (as strings like
// "10" / "13.00").
func (fx *fixture) setTenantRates(servicePct, vatPct string) {
	fx.t.Helper()
	fx.adminExec(
		`UPDATE tenants SET service_charge_pct = $2::numeric, vat_pct = $3::numeric WHERE id = $1`,
		fx.Tenant, servicePct, vatPct)
}

// setTenantVat sets the VAT mode ('none' | 'inclusive' | 'exclusive') and rate.
func (fx *fixture) setTenantVat(mode, vatPct string) {
	fx.t.Helper()
	fx.adminExec(
		`UPDATE tenants SET vat_mode = $2, vat_pct = $3::numeric WHERE id = $1`,
		fx.Tenant, mode, vatPct)
}

// countRows returns COUNT(*) for a table scoped to the fixture tenant, via the
// admin pool (RLS bypassed) so assertions see committed handler writes.
func (fx *fixture) countRows(table string) int {
	fx.t.Helper()
	var n int
	// table is a trusted test-supplied constant, not user input.
	fx.adminScan([]any{&n}, "SELECT count(*) FROM "+table+" WHERE tenant_id = $1", fx.Tenant)
	return n
}

func ptrUUID(id uuid.UUID) *uuid.UUID { return &id }
