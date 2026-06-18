package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/api/super"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// bugCreate fires a multipart POST /bug-reports as the fixture owner, optionally
// attaching one PNG screenshot. Mirrors staffUploadRequest's context wiring.
func bugCreate(t *testing.T, fx *fixture, store storage.Storage, kind, desc string, mood string, withFile bool) *apiResp {
	t.Helper()
	requireDB(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("kind", kind)
	_ = mw.WriteField("description", desc)
	if mood != "" {
		_ = mw.WriteField("mood", mood)
	}
	if withFile {
		fw, err := mw.CreateFormFile("files", "shot.png")
		if err != nil {
			t.Fatalf("form file: %v", err)
		}
		_, _ = fw.Write(minimalPNG)
	}
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/bug-reports", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

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
	if _, err := tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", fx.User.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	var email, name string
	_ = adminPool.QueryRow(bg, `SELECT email, name FROM users WHERE id = $1`, fx.User).Scan(&email, &name)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, chi.NewRouteContext())
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug, Name: fx.Name, Timezone: "Asia/Kathmandu"})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User, Email: email, Name: name})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-bug-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	CreateBugReport(store).ServeHTTP(rec, req)
	if rec.Code < 500 {
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}
	return &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

// newPlatformAdmin creates a standalone (no tenant) user registered in
// platform_admins, so the platform-admin RLS policy grants cross-tenant access.
func newPlatformAdmin(t *testing.T) uuid.UUID {
	t.Helper()
	requireDB(t)
	suffix := uuid.NewString()[:8]
	var id uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"admin-"+suffix+"@test.local", "Platform Admin",
	).Scan(&id); err != nil {
		t.Fatalf("seed admin user: %v", err)
	}
	if _, err := adminPool.Exec(context.Background(),
		`INSERT INTO platform_admins (user_id) VALUES ($1)`, id); err != nil {
		t.Fatalf("seed platform_admin: %v", err)
	}
	t.Cleanup(func() { _, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
	return id
}

// callSuperBug runs a /super handler with NO tenant context and the given acting
// user — exactly how the super route group is wired (app.user_id set, no tenant).
func callSuperBug(t *testing.T, acting uuid.UUID, h http.HandlerFunc, method, target string, body any, params map[string]string) *apiResp {
	t.Helper()
	requireDB(t)
	return callHandlerNoTenant(t, acting, h, method, target, body, params)
}

func callHandlerNoTenant(t *testing.T, acting uuid.UUID, h http.HandlerFunc, method, target string, body any, params map[string]string) *apiResp {
	t.Helper()
	var rdr *bytes.Buffer
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = bytes.NewBuffer(raw)
	} else {
		rdr = bytes.NewBuffer(nil)
	}
	req := httptest.NewRequest(method, target, rdr)
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

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
	// No app.tenant_id — this is the cross-tenant control plane.
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", acting.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	var email, name string
	_ = adminPool.QueryRow(bg, `SELECT email, name FROM users WHERE id = $1`, acting).Scan(&email, &name)
	ctx = appctx.WithUser(ctx, appctx.User{ID: acting, Email: email, Name: name})
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-super-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code < 500 {
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}
	return &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

// =========================================================================
// tenant submit path
// =========================================================================

func TestCreateBugReport_Success(t *testing.T) {
	fx := newTenant(t)
	store := newLocalStore(t)

	r := bugCreate(t, fx, store, "bug", "The settle button does nothing on tablet.", "2", true).expectStatus(http.StatusCreated)
	got := r.json()
	if got["ref"] == nil || got["ref"] == "" {
		t.Fatalf("expected a ref, got %v", got)
	}
	if n := fx.countRows("bug_reports"); n != 1 {
		t.Fatalf("bug_reports = %d, want 1", n)
	}
	if n := fx.countRows("bug_report_attachments"); n != 1 {
		t.Fatalf("attachments = %d, want 1", n)
	}

	// Snapshots are frozen onto the row.
	var slug, cafe, email string
	fx.adminScan([]any{&slug, &cafe, &email},
		`SELECT tenant_slug, cafe_name, reporter_email FROM bug_reports WHERE tenant_id = $1`, fx.Tenant)
	if slug != fx.Slug || cafe != fx.Name || email != fx.Email {
		t.Fatalf("snapshot mismatch: slug=%q cafe=%q email=%q", slug, cafe, email)
	}
}

func TestCreateBugReport_MissingDescription(t *testing.T) {
	fx := newTenant(t)
	store := newLocalStore(t)
	bugCreate(t, fx, store, "bug", "   ", "", false).expectErr(http.StatusBadRequest, "bad_request")
	if n := fx.countRows("bug_reports"); n != 0 {
		t.Fatalf("expected no rows, got %d", n)
	}
}

func TestMyBugReports_ReturnsOwn(t *testing.T) {
	fx := newTenant(t)
	store := newLocalStore(t)
	bugCreate(t, fx, store, "idea", "Add a dark-mode receipt.", "5", false).expectStatus(http.StatusCreated)

	r := callHandler(t, fx, ListMyBugReports, "GET", "/bug-reports/mine", nil).expectStatus(http.StatusOK)
	var resp struct {
		Reports []BugReportMine `json:"reports"`
	}
	r.decode(&resp)
	if len(resp.Reports) != 1 {
		t.Fatalf("mine = %d, want 1", len(resp.Reports))
	}
	if resp.Reports[0].Kind != "idea" || resp.Reports[0].Status != "open" {
		t.Fatalf("unexpected report: %+v", resp.Reports[0])
	}
}

// =========================================================================
// RLS isolation
// =========================================================================

func TestBugReport_TenantIsolation(t *testing.T) {
	a := newTenant(t)
	b := newTenant(t)
	store := newLocalStore(t)
	bugCreate(t, a, store, "bug", "A's private report.", "", false).expectStatus(http.StatusCreated)

	var reportID uuid.UUID
	a.adminScan([]any{&reportID}, `SELECT id FROM bug_reports WHERE tenant_id = $1`, a.Tenant)

	// Under tenant A's context the row is visible; under tenant B it is not.
	if got := bugRowVisible(t, a.Tenant, a.User, reportID); got != 1 {
		t.Fatalf("owner tenant should see its report, got %d", got)
	}
	if got := bugRowVisible(t, b.Tenant, b.User, reportID); got != 0 {
		t.Fatalf("RLS leak: tenant B saw tenant A's report (count=%d)", got)
	}
}

// bugRowVisible counts how many times reportID is visible from the app pool
// under the given tenant + user RLS context.
func bugRowVisible(t *testing.T, tenantID, userID, reportID uuid.UUID) int {
	t.Helper()
	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(bg)
	_, _ = tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", tenantID.String())
	_, _ = tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", userID.String())
	var n int
	if err := tx.QueryRow(bg, `SELECT count(*) FROM bug_reports WHERE id = $1`, reportID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// =========================================================================
// super-admin triage
// =========================================================================

func TestSuperBugReports_CrossTenantListResolveDelete(t *testing.T) {
	a := newTenant(t)
	b := newTenant(t)
	store := newLocalStore(t)
	bugCreate(t, a, store, "bug", "A report.", "1", true).expectStatus(http.StatusCreated)
	bugCreate(t, b, store, "question", "B question.", "", false).expectStatus(http.StatusCreated)
	admin := newPlatformAdmin(t)

	var aReport uuid.UUID
	a.adminScan([]any{&aReport}, `SELECT id FROM bug_reports WHERE tenant_id = $1`, a.Tenant)

	// A non-admin (with no tenant) sees nothing — the platform policy gates it.
	nonAdmin := a.User
	rNon := callSuperBug(t, nonAdmin, super.ListBugReports, "GET", "/?status=all", nil, nil).expectStatus(http.StatusOK)
	var nonResp struct {
		Reports []super.BugReportRow `json:"reports"`
	}
	rNon.decode(&nonResp)
	if len(nonResp.Reports) != 0 {
		t.Fatalf("non-admin saw %d reports, want 0", len(nonResp.Reports))
	}

	// The platform admin sees both tenants' reports.
	rList := callSuperBug(t, admin, super.ListBugReports, "GET", "/?status=all", nil, nil).expectStatus(http.StatusOK)
	var list struct {
		Reports []super.BugReportRow `json:"reports"`
		Summary map[string]int       `json:"summary"`
	}
	rList.decode(&list)
	if len(list.Reports) < 2 {
		t.Fatalf("admin list = %d, want >= 2", len(list.Reports))
	}
	if list.Summary["total"] < 2 {
		t.Fatalf("summary total = %d, want >= 2", list.Summary["total"])
	}

	// Detail surfaces the attachment metadata for A's report.
	rDetail := callSuperBug(t, admin, super.GetBugReport, "GET", "/", nil, map[string]string{"id": aReport.String()}).
		expectStatus(http.StatusOK)
	var detail super.BugReportDetail
	rDetail.decode(&detail)
	if len(detail.Attachments) != 1 {
		t.Fatalf("detail attachments = %d, want 1", len(detail.Attachments))
	}

	// Resolve stamps resolved_at / resolved_by.
	callSuperBug(t, admin, super.UpdateBugReport, "PATCH", "/",
		map[string]any{"status": "resolved", "priority": "high", "resolution_note": "fixed in 1.2.1"},
		map[string]string{"id": aReport.String()}).expectStatus(http.StatusOK)

	var status, prio string
	var resolvedBy *uuid.UUID
	var resolvedAt *string
	a.adminScan([]any{&status, &prio, &resolvedBy, &resolvedAt},
		`SELECT status, priority, resolved_by_user_id, resolved_at::text FROM bug_reports WHERE id = $1`, aReport)
	if status != "resolved" || prio != "high" {
		t.Fatalf("after resolve: status=%q priority=%q", status, prio)
	}
	if resolvedAt == nil || resolvedBy == nil || *resolvedBy != admin {
		t.Fatalf("resolve did not stamp resolver: at=%v by=%v", resolvedAt, resolvedBy)
	}

	// A platform_audit row was written for the update.
	var auditN int
	a.adminScan([]any{&auditN},
		`SELECT count(*) FROM platform_audit WHERE action = 'bug_report.update' AND target_id = $1`, aReport.String())
	if auditN != 1 {
		t.Fatalf("platform_audit rows = %d, want 1", auditN)
	}

	// Soft delete drops it from the list.
	callSuperBug(t, admin, super.DeleteBugReport, "POST", "/",
		nil, map[string]string{"id": aReport.String()}).expectStatus(http.StatusOK)
	var deletedAt *string
	a.adminScan([]any{&deletedAt}, `SELECT deleted_at::text FROM bug_reports WHERE id = $1`, aReport)
	if deletedAt == nil {
		t.Fatalf("expected deleted_at to be set")
	}
}
