package super

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
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// =========================================================================
// superReqOpts — options for callSuper.
// =========================================================================

type superReqOpts struct {
	params map[string]string // chi URL params
	query  string            // raw query string (no leading '?')
	// actAs overrides the acting platform-admin user. Defaults to the
	// superFixture.AdminUser.
	actAs uuid.UUID
}

type superResp struct {
	t    *testing.T
	Code int
	Body []byte
	Hdr  http.Header
}

// callSuper invokes an http.HandlerFunc in a super-admin context:
//   - begins an app-pool tx
//   - sets app.user_id GUC (NO app.tenant_id — super routes are not tenant-scoped)
//   - builds context with appctx.WithTx / WithUser / WithPlatformAdmin(true) / WithPostCommit
//   - runs the handler
//   - commits when status < 500 (tolerate commit errors, same as db.TxMiddleware)
func callSuper(t *testing.T, sf *superFixture, h http.HandlerFunc, method, target string, body any, opts ...func(*superReqOpts)) *superResp {
	t.Helper()
	requireDB(t)

	o := superReqOpts{params: map[string]string{}}
	for _, fn := range opts {
		fn(&o)
	}
	acting := sf.AdminUser
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
			t.Fatalf("callSuper: marshal body: %v", err)
		}
		rdr = bytes.NewBuffer(raw)
	}

	url := target
	if o.query != "" {
		url += "?" + o.query
	}
	req := httptest.NewRequest(method, url, rdr)
	req.Header.Set("Content-Type", "application/json")

	// Chi route params.
	rctx := chi.NewRouteContext()
	for k, v := range o.params {
		rctx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

	// Begin app-pool tx and set ONLY app.user_id (no tenant for super routes).
	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("callSuper: begin tx: %v", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", acting.String()); err != nil {
		t.Fatalf("callSuper: set user_id: %v", err)
	}

	var email, name string
	_ = adminPool.QueryRow(bg, `SELECT email::text, name FROM users WHERE id = $1`, acting).Scan(&email, &name)
	ctx = appctx.WithUser(ctx, appctx.User{ID: acting, Email: email, Name: name})
	ctx = appctx.WithPlatformAdmin(ctx, true)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-super-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")

	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code < 500 {
		// Mirror db.TxMiddleware: tolerate commit errors on 4xx (tx already aborted).
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}

	return &superResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

// =========================================================================
// superResp assertion helpers — mirror the internal/api harness.
// =========================================================================

func (r *superResp) expectStatus(want int) *superResp {
	r.t.Helper()
	if r.Code != want {
		r.t.Fatalf("status = %d, want %d; body: %s", r.Code, want, string(r.Body))
	}
	return r
}

func (r *superResp) errKind() string {
	r.t.Helper()
	var env struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(r.Body, &env)
	return env.Code
}

func (r *superResp) expectErr(status int, kind string) *superResp {
	r.t.Helper()
	r.expectStatus(status)
	if got := r.errKind(); got != kind {
		r.t.Fatalf("error kind = %q, want %q; body: %s", got, kind, string(r.Body))
	}
	return r
}

func (r *superResp) decode(dst any) *superResp {
	r.t.Helper()
	if err := json.Unmarshal(r.Body, dst); err != nil {
		r.t.Fatalf("decode body %q: %v", string(r.Body), err)
	}
	return r
}

func (r *superResp) json() map[string]any {
	r.t.Helper()
	m := map[string]any{}
	r.decode(&m)
	return m
}

// =========================================================================
// Option helpers.
// =========================================================================

func superParam(k, v string) func(*superReqOpts) {
	return func(o *superReqOpts) { o.params[k] = v }
}
func superQuery(q string) func(*superReqOpts) {
	return func(o *superReqOpts) { o.query = q }
}
func superActAs(id uuid.UUID) func(*superReqOpts) {
	return func(o *superReqOpts) { o.actAs = id }
}

// =========================================================================
// superFixture — throwaway platform-admin user + optional tenant.
// =========================================================================

// superFixture holds the platform-admin user and helper state for a test.
type superFixture struct {
	t         *testing.T
	AdminUser uuid.UUID
	AdminEmail string
	rbacRepo  *rbac.Repo
}

// newSuperFixture seeds a fresh user row and registers it as a platform admin.
// It cleans up both rows at test end.
func newSuperFixture(t *testing.T) *superFixture {
	t.Helper()
	requireDB(t)

	suffix := uuid.NewString()[:8]
	email := "superadmin-" + suffix + "@test.local"
	name := "SuperAdmin " + suffix

	ctx := context.Background()
	var userID uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		email, name,
	).Scan(&userID); err != nil {
		t.Fatalf("newSuperFixture: seed user: %v", err)
	}
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO platform_admins (user_id, source) VALUES ($1, 'manual')`,
		userID,
	); err != nil {
		t.Fatalf("newSuperFixture: seed platform_admin: %v", err)
	}

	sf := &superFixture{
		t:          t,
		AdminUser:  userID,
		AdminEmail: email,
		rbacRepo:   rbac.NewRepo(appPool, rbac.NewCache(16)),
	}

	t.Cleanup(func() {
		bg := context.Background()
		// platform_admins row is deleted via CASCADE on users delete.
		_, _ = adminPool.Exec(bg, `DELETE FROM users WHERE id = $1`, userID)
	})
	return sf
}

// seedTenant inserts a tenant row (via admin pool) with the default "trial"
// plan and returns its ID + slug. The "trial" plan always exists in the seed DB.
func (sf *superFixture) seedTenant(name string) (uuid.UUID, string) {
	sf.t.Helper()
	suffix := uuid.NewString()[:8]
	slug := "tst-" + suffix
	ctx := context.Background()

	var planID uuid.UUID
	if err := adminPool.QueryRow(ctx, `SELECT id FROM plans WHERE key = 'trial'`).Scan(&planID); err != nil {
		sf.t.Fatalf("seedTenant: resolve trial plan: %v", err)
	}

	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO tenants (slug, name, plan_id) VALUES ($1, $2, $3) RETURNING id`,
		slug, name, planID,
	).Scan(&id); err != nil {
		sf.t.Fatalf("seedTenant: %v", err)
	}
	sf.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id, slug
}

// seedTenantWithPlan inserts a tenant with an explicit plan_id.
func (sf *superFixture) seedTenantWithPlan(name, planKey string) (uuid.UUID, string) {
	sf.t.Helper()
	suffix := uuid.NewString()[:8]
	slug := "tst-" + suffix
	ctx := context.Background()

	var planID uuid.UUID
	if err := adminPool.QueryRow(ctx, `SELECT id FROM plans WHERE key = $1`, planKey).Scan(&planID); err != nil {
		sf.t.Fatalf("seedTenantWithPlan: resolve plan %q: %v", planKey, err)
	}

	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO tenants (slug, name, plan_id) VALUES ($1, $2, $3) RETURNING id`,
		slug, name, planID,
	).Scan(&id); err != nil {
		sf.t.Fatalf("seedTenantWithPlan: %v", err)
	}
	sf.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id, slug
}

// seedUser inserts a plain user row and cleans up at test end.
func (sf *superFixture) seedUser(emailHint string) (uuid.UUID, string) {
	sf.t.Helper()
	suffix := uuid.NewString()[:8]
	email := emailHint + "-" + suffix + "@test.local"
	ctx := context.Background()
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		email, emailHint,
	).Scan(&id); err != nil {
		sf.t.Fatalf("seedUser: %v", err)
	}
	sf.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id, email
}

// seedPlatformAdmin inserts a second admin (for multi-admin tests).
func (sf *superFixture) seedPlatformAdmin(emailHint string) (uuid.UUID, string) {
	sf.t.Helper()
	id, email := sf.seedUser(emailHint)
	ctx := context.Background()
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO platform_admins (user_id, source) VALUES ($1, 'manual')`, id,
	); err != nil {
		sf.t.Fatalf("seedPlatformAdmin: %v", err)
	}
	return id, email
}

// seedRequest inserts a tenant_request row and cleans it up.
func (sf *superFixture) seedRequest(cafeName, email string) uuid.UUID {
	sf.t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO tenant_requests (name, cafe_name, email) VALUES ($1, $2, $3) RETURNING id`,
		"Requester", cafeName, email,
	).Scan(&id); err != nil {
		sf.t.Fatalf("seedRequest: %v", err)
	}
	sf.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenant_requests WHERE id = $1`, id)
	})
	return id
}

// seedPlan inserts a plan and cleans it up at test end.
func (sf *superFixture) seedPlan(key, name string) uuid.UUID {
	sf.t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO plans (key, name) VALUES ($1, $2) RETURNING id`,
		key, name,
	).Scan(&id); err != nil {
		sf.t.Fatalf("seedPlan: %v", err)
	}
	sf.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM plans WHERE id = $1`, id)
	})
	return id
}

// adminScan executes a query via the admin pool and scans a single row.
func (sf *superFixture) adminScan(dst []any, sql string, args ...any) {
	sf.t.Helper()
	if err := adminPool.QueryRow(context.Background(), sql, args...).Scan(dst...); err != nil {
		sf.t.Fatalf("adminScan %q: %v", sql, err)
	}
}

// adminExec executes a statement via the admin pool.
func (sf *superFixture) adminExec(sql string, args ...any) {
	sf.t.Helper()
	if _, err := adminPool.Exec(context.Background(), sql, args...); err != nil {
		sf.t.Fatalf("adminExec %q: %v", sql, err)
	}
}

// countPlatformAudit returns the number of platform_audit rows for an action
// (filtered by target_tenant_id when tenantID is non-nil).
func (sf *superFixture) countPlatformAudit(action string, tenantID *uuid.UUID) int {
	sf.t.Helper()
	var n int
	if tenantID != nil {
		sf.adminScan([]any{&n},
			`SELECT count(*) FROM platform_audit WHERE action = $1 AND target_tenant_id = $2`,
			action, *tenantID)
	} else {
		sf.adminScan([]any{&n},
			`SELECT count(*) FROM platform_audit WHERE action = $1`, action)
	}
	return n
}
