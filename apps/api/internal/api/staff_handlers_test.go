package api

// Integration tests for staff.go:
//   - ListStaff
//   - CreateStaff
//   - GetStaff
//   - UpdateStaff
//   - DeleteStaff (soft-delete)
//   - UploadStaffDocument
//   - DownloadStaffDocument
//   - DeleteStaffDocument

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
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// =========================================================================
// staff fixture helpers (domain-prefixed: staffSeed*)
// =========================================================================

// staffSeedMember inserts a staff row directly via the admin pool and
// returns its id. status must be "active" or "inactive".
func (fx *fixture) staffSeedMember(fullName, status string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO staff (tenant_id, full_name, status)
		 VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, fullName, status)
	return id
}

// staffSeedDocument inserts a staff_documents row directly and returns its id.
// storageKey is a fake key (no real blob needed for non-download tests).
func (fx *fixture) staffSeedDocument(staffID uuid.UUID, docType, storageKey, mimeType, fileName string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO staff_documents
		 (tenant_id, staff_id, doc_type, label, storage_key, file_name, mime_type, size_bytes, uploaded_by_user_id)
		 VALUES ($1, $2, $3, '', $4, $5, $6, 0, $7) RETURNING id`,
		fx.Tenant, staffID, docType, storageKey, fileName, mimeType, fx.User)
	return id
}

// staffIsDeleted returns true when the row has a non-null deleted_at.
func (fx *fixture) staffIsDeleted(staffID uuid.UUID) bool {
	fx.t.Helper()
	var deleted bool
	fx.adminScan([]any{&deleted},
		`SELECT deleted_at IS NOT NULL FROM staff WHERE id = $1`, staffID)
	return deleted
}

// staffDocDeleted returns true when the document row has deleted_at set.
func (fx *fixture) staffDocDeleted(docID uuid.UUID) bool {
	fx.t.Helper()
	var deleted bool
	fx.adminScan([]any{&deleted},
		`SELECT deleted_at IS NOT NULL FROM staff_documents WHERE id = $1`, docID)
	return deleted
}

// staffDocCount counts live (not deleted) staff_documents for a staff member
// via the admin pool.
func (fx *fixture) staffDocCount(staffID uuid.UUID) int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM staff_documents WHERE staff_id = $1 AND deleted_at IS NULL`, staffID)
	return n
}

// newLocalStore creates a storage.LocalStore backed by a temp directory.
// The error is fatal — a test temp dir should never fail.
func newLocalStore(t *testing.T) storage.Storage {
	t.Helper()
	st, err := storage.NewLocal(t.TempDir(), "/uploads/")
	if err != nil {
		t.Fatalf("storage.NewLocal: %v", err)
	}
	return st
}

// staffUploadRequest builds a real multipart/form-data *http.Request that
// targets UploadStaffDocument. It replicates the context setup that
// callHandler performs (app-pool tx, RLS GUCs, appctx values) so the handler
// runs in a fully-wired environment. The returned recorder captures the
// response; if commit is true the transaction is committed after the handler
// returns (mirroring callHandler's < 500 commit logic).
func staffUploadRequest(
	t *testing.T,
	fx *fixture,
	staffID uuid.UUID,
	docType, label string,
	fileContent []byte,
	fileName string,
) *apiResp {
	t.Helper()
	requireDB(t)

	// Build the multipart body.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("doc_type", docType)
	if label != "" {
		_ = mw.WriteField("label", label)
	}
	if fileContent != nil {
		fw, err := mw.CreateFormFile("file", fileName)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		if _, err := fw.Write(fileContent); err != nil {
			t.Fatalf("write form file: %v", err)
		}
	}
	mw.Close()

	url := "/staff/" + staffID.String() + "/documents"
	req := httptest.NewRequest(http.MethodPost, url, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	// chi route params.
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", staffID.String())
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

	// Open app-pool tx and set RLS GUCs.
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

	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug, Name: fx.Name, Timezone: "Asia/Kathmandu"})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User, Email: email, Name: name})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-upload-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())

	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	st := newLocalStore(t)
	UploadStaffDocument(st).ServeHTTP(rec, req)

	if rec.Code < 500 {
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}

	return &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

// minimalPNG is a 1×1 pixel valid PNG file — enough for http.DetectContentType
// to identify as "image/png".
var minimalPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
	0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, colour type, etc.
	0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
	0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
	0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
	0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
	0x44, 0xae, 0x42, 0x60, 0x82,
}

// minimalPDF is just enough bytes for http.DetectContentType to detect "application/pdf".
var minimalPDF = append([]byte("%PDF-1.0\n"), make([]byte, 512-9)...)

// =========================================================================
// ListStaff
// =========================================================================

func TestListStaff_EmptyResult(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 0 {
		t.Fatalf("staff = %d, want 0", len(staff))
	}
}

func TestListStaff_ReturnsActiveAndInactive(t *testing.T) {
	fx := newTenant(t)
	fx.staffSeedMember("Alice Active", "active")
	fx.staffSeedMember("Bob Bench", "inactive")

	r := callHandler(t, fx, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 2 {
		t.Fatalf("staff = %d, want 2", len(staff))
	}
}

func TestListStaff_ExcludesDeleted(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Gone", "active")
	fx.adminExec(`UPDATE staff SET deleted_at = now() WHERE id = $1`, id)
	fx.staffSeedMember("Still Here", "active")

	r := callHandler(t, fx, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 1 {
		t.Fatalf("staff = %d after soft-delete, want 1", len(staff))
	}
}

func TestListStaff_OrderedByStatusThenName(t *testing.T) {
	fx := newTenant(t)
	// Inactive should appear after active; within active, sorted by name.
	fx.staffSeedMember("Zara Active", "active")
	fx.staffSeedMember("Abel Active", "active")
	fx.staffSeedMember("Mel Inactive", "inactive")

	r := callHandler(t, fx, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 3 {
		t.Fatalf("staff = %d, want 3", len(staff))
	}
	names := []string{
		staff[0].(map[string]any)["full_name"].(string),
		staff[1].(map[string]any)["full_name"].(string),
		staff[2].(map[string]any)["full_name"].(string),
	}
	// ORDER BY status (active < inactive lexicographically), lower(full_name)
	if names[0] != "Abel Active" || names[1] != "Zara Active" || names[2] != "Mel Inactive" {
		t.Fatalf("order = %v, want [Abel Active, Zara Active, Mel Inactive]", names)
	}
}

func TestListStaff_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.staffSeedMember("FX1 Employee", "active")

	r := callHandler(t, fx2, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 0 {
		t.Fatalf("tenant isolation broken: fx2 sees %d staff from fx1", len(staff))
	}
}

func TestListStaff_DocCountReflectsLiveDocs(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Docced", "active")
	d1 := fx.staffSeedDocument(sid, "id_card", "tenant/staff/"+sid.String()+"/a.png", "image/png", "id.png")
	d2 := fx.staffSeedDocument(sid, "contract", "tenant/staff/"+sid.String()+"/b.pdf", "application/pdf", "contract.pdf")
	// Soft-delete one document; doc_count should reflect only live docs.
	fx.adminExec(`UPDATE staff_documents SET deleted_at = now() WHERE id = $1`, d2)
	_ = d1

	r := callHandler(t, fx, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 1 {
		t.Fatalf("staff = %d, want 1", len(staff))
	}
	docCount := int(staff[0].(map[string]any)["doc_count"].(float64))
	if docCount != 1 {
		t.Fatalf("doc_count = %d, want 1 (one doc deleted)", docCount)
	}
}

// =========================================================================
// CreateStaff
// =========================================================================

func TestCreateStaff_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/", "{not json").
		expectErr(400, "bad_request")
}

func TestCreateStaff_MissingFullName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"role_title": "Barista"}).
		expectErr(400, "bad_request")
}

func TestCreateStaff_BlankFullName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "   "}).
		expectErr(400, "bad_request")
}

func TestCreateStaff_InvalidStatus(t *testing.T) {
	fx := newTenant(t)
	st := "probation"
	callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "X", "status": st}).
		expectErr(400, "bad_request")
}

func TestCreateStaff_DefaultStatusIsActive(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "New Hire"}).
		expectStatus(201)
	var s Staff
	r.decode(&s)
	if s.Status != "active" {
		t.Fatalf("status = %q, want active (default)", s.Status)
	}
}

func TestCreateStaff_InactiveStatusAllowed(t *testing.T) {
	fx := newTenant(t)
	st := "inactive"
	r := callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "Parted Ways", "status": &st}).
		expectStatus(201)
	var s Staff
	r.decode(&s)
	if s.Status != "inactive" {
		t.Fatalf("status = %q, want inactive", s.Status)
	}
}

func TestCreateStaff_AllFieldsPersisted(t *testing.T) {
	fx := newTenant(t)
	email := "barista@cafe.local"
	startedOn := "2024-01-15"
	r := callHandler(t, fx, CreateStaff, "POST", "/", map[string]any{
		"full_name":  "Rama Thapa",
		"role_title": "Head Barista",
		"phone":      "9800000001",
		"email":      email,
		"started_on": startedOn,
		"notes":      "Experienced in espresso",
	}).expectStatus(201)

	var s Staff
	r.decode(&s)
	if s.FullName != "Rama Thapa" {
		t.Fatalf("full_name = %q", s.FullName)
	}
	if s.RoleTitle != "Head Barista" {
		t.Fatalf("role_title = %q", s.RoleTitle)
	}
	if s.Phone != "9800000001" {
		t.Fatalf("phone = %q", s.Phone)
	}
	if s.Email == nil || *s.Email != email {
		t.Fatalf("email = %v, want %q", s.Email, email)
	}
	if s.StartedOn == nil || *s.StartedOn != startedOn {
		t.Fatalf("started_on = %v, want %q", s.StartedOn, startedOn)
	}
	if s.Notes != "Experienced in espresso" {
		t.Fatalf("notes = %q", s.Notes)
	}
	if s.ID == uuid.Nil {
		t.Fatal("id is nil uuid")
	}
	if s.DocCount != 0 {
		t.Fatalf("doc_count = %d, want 0 for new staff", s.DocCount)
	}
}

func TestCreateStaff_BlankEmailStoredAsNull(t *testing.T) {
	fx := newTenant(t)
	email := ""
	r := callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "No Email", "email": &email}).
		expectStatus(201)
	var s Staff
	r.decode(&s)
	if s.Email != nil {
		t.Fatalf("email = %v, want nil for blank input", *s.Email)
	}
}

func TestCreateStaff_BlankStartedOnStoredAsNull(t *testing.T) {
	fx := newTenant(t)
	started := ""
	r := callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "No Date", "started_on": &started}).
		expectStatus(201)
	var s Staff
	r.decode(&s)
	if s.StartedOn != nil {
		t.Fatalf("started_on = %v, want nil for blank input", *s.StartedOn)
	}
}

func TestCreateStaff_DBRowPersisted(t *testing.T) {
	fx := newTenant(t)
	if n := fx.countRows("staff"); n != 0 {
		t.Fatalf("pre-count = %d, want 0", n)
	}
	callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "Row Check"}).
		expectStatus(201)
	if n := fx.countRows("staff"); n != 1 {
		t.Fatalf("post-count = %d, want 1", n)
	}
}

// =========================================================================
// GetStaff
// =========================================================================

func TestGetStaff_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetStaff, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestGetStaff_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetStaff, "GET", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestGetStaff_SoftDeletedIsNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Gone", "active")
	fx.adminExec(`UPDATE staff SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, GetStaff, "GET", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestGetStaff_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Nisha Karki", "active")
	r := callHandler(t, fx, GetStaff, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200)

	var detail staffDetail
	r.decode(&detail)
	if detail.ID != id {
		t.Fatalf("id = %v, want %v", detail.ID, id)
	}
	if detail.FullName != "Nisha Karki" {
		t.Fatalf("full_name = %q", detail.FullName)
	}
	if detail.Documents == nil {
		t.Fatal("documents must not be nil (should be empty slice)")
	}
	if len(detail.Documents) != 0 {
		t.Fatalf("documents = %d, want 0", len(detail.Documents))
	}
}

func TestGetStaff_IncludesLiveDocuments(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Documented Staff", "active")
	d1 := fx.staffSeedDocument(sid, "id_card", "t/staff/"+sid.String()+"/c1.png", "image/png", "id.png")
	d2 := fx.staffSeedDocument(sid, "contract", "t/staff/"+sid.String()+"/c2.pdf", "application/pdf", "c.pdf")
	// Soft-delete d2 — should not appear.
	fx.adminExec(`UPDATE staff_documents SET deleted_at = now() WHERE id = $1`, d2)

	r := callHandler(t, fx, GetStaff, "GET", "/", nil,
		withParam("id", sid.String())).
		expectStatus(200)

	var detail staffDetail
	r.decode(&detail)
	if len(detail.Documents) != 1 {
		t.Fatalf("documents = %d, want 1 (one deleted)", len(detail.Documents))
	}
	if detail.Documents[0].ID != d1 {
		t.Fatalf("document id = %v, want %v", detail.Documents[0].ID, d1)
	}
}

func TestGetStaff_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := fx1.staffSeedMember("FX1 Only", "active")

	callHandler(t, fx2, GetStaff, "GET", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// UpdateStaff
// =========================================================================

func TestUpdateStaff_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"full_name": "X"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateStaff_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Old Name", "active")
	callHandler(t, fx, UpdateStaff, "PATCH", "/", "{bad json",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateStaff_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"full_name": "Ghost"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateStaff_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Deleted", "active")
	fx.adminExec(`UPDATE staff SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"full_name": "New Name"},
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestUpdateStaff_InvalidStatus(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Worker", "active")
	callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"status": "probation"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateStaff_UpdateFullName(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Original Name", "active")
	r := callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"full_name": "Updated Name"},
		withParam("id", id.String())).
		expectStatus(200)
	var s Staff
	r.decode(&s)
	if s.FullName != "Updated Name" {
		t.Fatalf("full_name = %q, want Updated Name", s.FullName)
	}
	if s.ID != id {
		t.Fatalf("id = %v", s.ID)
	}
}

func TestUpdateStaff_UpdateStatusToInactive(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Active Worker", "active")
	r := callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"status": "inactive"},
		withParam("id", id.String())).
		expectStatus(200)
	var s Staff
	r.decode(&s)
	if s.Status != "inactive" {
		t.Fatalf("status = %q, want inactive", s.Status)
	}
}

func TestUpdateStaff_PartialUpdatePreservesOtherFields(t *testing.T) {
	fx := newTenant(t)
	// Seed with all fields set via direct INSERT.
	var id uuid.UUID
	email := "worker@cafe.local"
	fx.adminScan([]any{&id},
		`INSERT INTO staff (tenant_id, full_name, role_title, phone, email, started_on, notes)
		 VALUES ($1, 'Full Fields', 'Barista', '9800000002', $2, '2023-06-01', 'original notes')
		 RETURNING id`,
		fx.Tenant, email)

	// Update only notes; all other fields should survive.
	r := callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"notes": "updated notes"},
		withParam("id", id.String())).
		expectStatus(200)
	var s Staff
	r.decode(&s)
	if s.RoleTitle != "Barista" {
		t.Fatalf("role_title changed: %q", s.RoleTitle)
	}
	if s.Phone != "9800000002" {
		t.Fatalf("phone changed: %q", s.Phone)
	}
	if s.Email == nil || *s.Email != email {
		t.Fatalf("email changed: %v", s.Email)
	}
	if s.StartedOn == nil || *s.StartedOn != "2023-06-01" {
		t.Fatalf("started_on changed: %v", s.StartedOn)
	}
	if s.Notes != "updated notes" {
		t.Fatalf("notes = %q, want updated notes", s.Notes)
	}
}

func TestUpdateStaff_DocCountReturnedCorrectly(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Count Check", "active")
	fx.staffSeedDocument(sid, "id_card", "t/staff/"+sid.String()+"/x.png", "image/png", "x.png")

	r := callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"notes": "ping"},
		withParam("id", sid.String())).
		expectStatus(200)
	var s Staff
	r.decode(&s)
	if s.DocCount != 1 {
		t.Fatalf("doc_count = %d after update, want 1", s.DocCount)
	}
}

func TestUpdateStaff_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := fx1.staffSeedMember("FX1 Staff", "active")

	callHandler(t, fx2, UpdateStaff, "PATCH", "/",
		map[string]any{"full_name": "Hijacked"},
		withParam("id", id.String())).
		expectErr(404, "not_found")

	// Verify the name was not changed.
	var name string
	fx1.adminScan([]any{&name}, `SELECT full_name FROM staff WHERE id = $1`, id)
	if name != "FX1 Staff" {
		t.Fatalf("name was mutated by another tenant: %q", name)
	}
}

// =========================================================================
// DeleteStaff (soft-delete)
// =========================================================================

func TestDeleteStaff_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteStaff, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteStaff_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteStaff, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteStaff_AlreadyDeletedIsNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Already Gone", "active")
	fx.adminExec(`UPDATE staff SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, DeleteStaff, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestDeleteStaff_SoftDeleteSetsDeletedAt(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("To Delete", "active")
	callHandler(t, fx, DeleteStaff, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	if !fx.staffIsDeleted(id) {
		t.Fatal("deleted_at is still NULL after DeleteStaff")
	}
}

func TestDeleteStaff_RowStillExistsAfterDelete(t *testing.T) {
	// Confirm soft-delete: the row must remain in the table.
	fx := newTenant(t)
	id := fx.staffSeedMember("Soft Row", "active")
	callHandler(t, fx, DeleteStaff, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)

	var count int
	fx.adminScan([]any{&count}, `SELECT count(*) FROM staff WHERE id = $1`, id)
	if count != 1 {
		t.Fatalf("row count = %d after soft-delete, want 1 (row must persist)", count)
	}
}

func TestDeleteStaff_DisappearsFromList(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Will Vanish", "active")
	callHandler(t, fx, DeleteStaff, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)

	r := callHandler(t, fx, ListStaff, "GET", "/", nil).
		expectStatus(200).json()
	staff, _ := r["staff"].([]any)
	if len(staff) != 0 {
		t.Fatalf("staff in list = %d after delete, want 0", len(staff))
	}
}

func TestDeleteStaff_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := fx1.staffSeedMember("FX1 Target", "active")

	callHandler(t, fx2, DeleteStaff, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")

	// Row must not have been deleted.
	if fx1.staffIsDeleted(id) {
		t.Fatal("another tenant's delete call soft-deleted fx1's staff row")
	}
}

// =========================================================================
// UploadStaffDocument
// =========================================================================

func TestUploadStaffDocument_BadStaffID(t *testing.T) {
	fx := newTenant(t)
	// Pass an invalid UUID for the staff id param directly via chi route context.
	// We use staffUploadRequest which already sets the param from staffID, so
	// test the bad-UUID path by constructing a minimal inline call.
	requireDB(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "not-a-uuid")
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck

	if _, err := tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", fx.User.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	UploadStaffDocument(newLocalStore(t)).ServeHTTP(rec, req)

	resp := &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes()}
	resp.expectErr(400, "bad_request")
}

func TestUploadStaffDocument_StaffNotFound(t *testing.T) {
	fx := newTenant(t)
	resp := staffUploadRequest(t, fx, uuid.New(), "id_card", "", minimalPNG, "id.png")
	resp.expectErr(404, "not_found")
}

func TestUploadStaffDocument_SoftDeletedStaffNotFound(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Deleted", "active")
	fx.adminExec(`UPDATE staff SET deleted_at = now() WHERE id = $1`, sid)
	staffUploadRequest(t, fx, sid, "id_card", "", minimalPNG, "id.png").
		expectErr(404, "not_found")
}

func TestUploadStaffDocument_MissingDocType(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Worker", "active")
	// Empty doc_type should be rejected.
	staffUploadRequest(t, fx, sid, "", "", minimalPNG, "id.png").
		expectErr(400, "bad_request")
}

func TestUploadStaffDocument_MissingFileField(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Worker", "active")
	// Build a multipart body with doc_type but no "file" field.
	requireDB(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("doc_type", "id_card")
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/staff/"+sid.String()+"/documents", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", sid.String())
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck

	if _, err := tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", fx.User.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	UploadStaffDocument(newLocalStore(t)).ServeHTTP(rec, req)

	resp := &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes()}
	resp.expectErr(400, "bad_request")
}

func TestUploadStaffDocument_DisallowedMimeType(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Worker", "active")
	// Plain text is not in allowedStaffDocTypes.
	textContent := []byte("this is plain text content, not a valid document type")
	staffUploadRequest(t, fx, sid, "id_card", "", textContent, "text.txt").
		expectErr(415, "bad_type")
}

func TestUploadStaffDocument_SuccessPNG(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Documented Worker", "active")

	r := staffUploadRequest(t, fx, sid, "id_card", "National ID", minimalPNG, "id_card.png")
	r.expectStatus(201)

	var d StaffDocument
	r.decode(&d)
	if d.ID == uuid.Nil {
		t.Fatal("document id is nil uuid")
	}
	if d.StaffID != sid {
		t.Fatalf("staff_id = %v, want %v", d.StaffID, sid)
	}
	if d.DocType != "id_card" {
		t.Fatalf("doc_type = %q, want id_card", d.DocType)
	}
	if d.Label != "National ID" {
		t.Fatalf("label = %q, want National ID", d.Label)
	}
	if d.MimeType != "image/png" {
		t.Fatalf("mime_type = %q, want image/png", d.MimeType)
	}
	if d.FileName != "id_card.png" {
		t.Fatalf("file_name = %q, want id_card.png", d.FileName)
	}
	if d.SizeBytes <= 0 {
		t.Fatalf("size_bytes = %d, want > 0", d.SizeBytes)
	}

	// Row must be persisted in DB.
	if n := fx.staffDocCount(sid); n != 1 {
		t.Fatalf("staff_documents rows = %d, want 1", n)
	}
}

func TestUploadStaffDocument_SuccessPDF(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("PDF Worker", "active")

	r := staffUploadRequest(t, fx, sid, "contract", "", minimalPDF, "contract.pdf")
	r.expectStatus(201)

	var d StaffDocument
	r.decode(&d)
	if d.MimeType != "application/pdf" {
		t.Fatalf("mime_type = %q, want application/pdf", d.MimeType)
	}
}

func TestUploadStaffDocument_MultipleDocsForSameStaff(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Multi Doc", "active")

	staffUploadRequest(t, fx, sid, "id_card", "", minimalPNG, "id.png").expectStatus(201)
	staffUploadRequest(t, fx, sid, "contract", "", minimalPDF, "contract.pdf").expectStatus(201)

	if n := fx.staffDocCount(sid); n != 2 {
		t.Fatalf("doc count = %d after two uploads, want 2", n)
	}
}

func TestUploadStaffDocument_StorageKeyIsPrivate(t *testing.T) {
	// The handler stores a private storage_key (never a public URL).
	// Verify the storage_key column is populated and looks like a private path
	// (contains tenant slug / staff prefix), not a bare public URL.
	fx := newTenant(t)
	sid := fx.staffSeedMember("Private Doc", "active")

	staffUploadRequest(t, fx, sid, "passport", "", minimalPNG, "passport.png").expectStatus(201)

	var storageKey string
	fx.adminScan([]any{&storageKey},
		`SELECT storage_key FROM staff_documents WHERE staff_id = $1 AND deleted_at IS NULL`, sid)
	if storageKey == "" {
		t.Fatal("storage_key is blank")
	}
	// Key must not be an http:// or https:// URL — it is a path in private storage.
	if len(storageKey) > 4 && (storageKey[:7] == "http://" || storageKey[:8] == "https://") {
		t.Fatalf("storage_key %q is a public URL — documents must be private", storageKey)
	}
}

func TestUploadStaffDocument_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	sid := fx1.staffSeedMember("FX1 Staff", "active")

	// fx2 tries to upload a document for fx1's staff member.
	// The staffExists check uses RLS, so it must return not_found.
	r := staffUploadRequest(t, fx2, sid, "id_card", "", minimalPNG, "id.png")
	r.expectErr(404, "not_found")

	if n := fx1.staffDocCount(sid); n != 0 {
		t.Fatalf("fx1 staff gained %d doc(s) from a cross-tenant upload", n)
	}
}

// =========================================================================
// DownloadStaffDocument
// =========================================================================

// staffUploadAndGetDoc is a helper that uploads a PNG document for a staff
// member and returns the resulting StaffDocument metadata.
func staffUploadAndGetDoc(t *testing.T, fx *fixture, sid uuid.UUID) StaffDocument {
	t.Helper()
	r := staffUploadRequest(t, fx, sid, "id_card", "test doc", minimalPNG, "id.png")
	r.expectStatus(201)
	var d StaffDocument
	r.decode(&d)
	return d
}

// staffDownloadRequest wraps callHandler for DownloadStaffDocument with the
// correct chi params.
func staffDownloadRequest(t *testing.T, fx *fixture, staffID, docID uuid.UUID) *apiResp {
	t.Helper()
	return callHandler(t, fx, DownloadStaffDocument(newLocalStore(t)), "GET", "/", nil,
		withParams(map[string]string{"id": staffID.String(), "docId": docID.String()}))
}

func TestDownloadStaffDocument_BadStaffID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DownloadStaffDocument(newLocalStore(t)), "GET", "/", nil,
		withParams(map[string]string{"id": "not-a-uuid", "docId": uuid.NewString()})).
		expectErr(400, "bad_request")
}

func TestDownloadStaffDocument_BadDocID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DownloadStaffDocument(newLocalStore(t)), "GET", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "docId": "not-a-uuid"})).
		expectErr(400, "bad_request")
}

func TestDownloadStaffDocument_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DownloadStaffDocument(newLocalStore(t)), "GET", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "docId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestDownloadStaffDocument_DocBelongsToDifferentStaff(t *testing.T) {
	fx := newTenant(t)
	s1 := fx.staffSeedMember("Staff One", "active")
	s2 := fx.staffSeedMember("Staff Two", "active")
	// Upload a doc for s1.
	d := staffUploadAndGetDoc(t, fx, s1)

	// Try to download it scoped to s2's id — must be not_found.
	staffDownloadRequest(t, fx, s2, d.ID).expectErr(404, "not_found")
}

func TestDownloadStaffDocument_SoftDeletedDocNotFound(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Worker", "active")
	// Seed a document row (soft-deleted) — no real blob needed for the 404 path.
	docID := fx.staffSeedDocument(sid, "id_card", "t/staff/"+sid.String()+"/x.png", "image/png", "x.png")
	fx.adminExec(`UPDATE staff_documents SET deleted_at = now() WHERE id = $1`, docID)

	staffDownloadRequest(t, fx, sid, docID).expectErr(404, "not_found")
}

func TestDownloadStaffDocument_StreamsBytes(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Stream Test", "active")
	d := staffUploadAndGetDoc(t, fx, sid)

	// DownloadStaffDocument must use a store that can actually read back what
	// UploadStaffDocument wrote. We use a shared temp dir for both.
	tmpDir := t.TempDir()
	st, err := storage.NewLocal(tmpDir, "/uploads/")
	if err != nil {
		t.Fatalf("storage.NewLocal: %v", err)
	}

	// Re-upload using the same store so the blob exists on disk.
	requireDB(t)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("doc_type", "id_card")
	fw, _ := mw.CreateFormFile("file", "id.png")
	_, _ = fw.Write(minimalPNG)
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/staff/"+sid.String()+"/documents", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", sid.String())
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)

	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", fx.User.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}
	var email, name string
	_ = adminPool.QueryRow(bg, `SELECT email, name FROM users WHERE id = $1`, fx.User).Scan(&email, &name)
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User, Email: email, Name: name})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	recUp := httptest.NewRecorder()
	UploadStaffDocument(st).ServeHTTP(recUp, req)
	if recUp.Code != 201 {
		t.Fatalf("upload status = %d; body: %s", recUp.Code, recUp.Body.String())
	}
	if err := tx.Commit(bg); err != nil {
		t.Fatalf("commit upload tx: %v", err)
	}
	var uploadedDoc StaffDocument
	if err := json.Unmarshal(recUp.Body.Bytes(), &uploadedDoc); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}

	// Now download via the same store and same staff id.
	dl := callHandler(t, fx, DownloadStaffDocument(st), "GET", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": uploadedDoc.ID.String()}))
	dl.expectStatus(200)

	// Body must be the PNG bytes we uploaded (not empty, not an error envelope).
	if len(dl.Body) == 0 {
		t.Fatal("download body is empty")
	}
	// Content-Type header must be image/png.
	ct := dl.Hdr.Get("Content-Type")
	if ct != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", ct)
	}
	// Cache-Control must be private.
	cc := dl.Hdr.Get("Cache-Control")
	if cc == "" {
		t.Fatal("Cache-Control header missing")
	}
	// Must contain "private" — never cache on shared proxies for sensitive docs.
	if len(cc) < 7 || cc[:7] != "private" {
		t.Fatalf("Cache-Control = %q — must start with private for sensitive docs", cc)
	}
	// Verify Content-Disposition is inline (not attachment — browser should render).
	disp := dl.Hdr.Get("Content-Disposition")
	if disp == "" {
		t.Fatal("Content-Disposition header missing")
	}
	if disp[:6] != "inline" {
		t.Fatalf("Content-Disposition = %q, want inline prefix", disp)
	}
	_ = d // uploaded in a separate store above; we used the fresh one for round-trip
}

func TestDownloadStaffDocument_NoPublicURL(t *testing.T) {
	// Confirm that the download endpoint does NOT redirect to a public URL —
	// it must stream the bytes directly. A public URL in the response would
	// bypass the staff:read gate entirely.
	fx := newTenant(t)
	sid := fx.staffSeedMember("Private Only", "active")
	d := staffUploadAndGetDoc(t, fx, sid)

	// Attempt download with the same temp-store as the upload — it will fail
	// because staffUploadAndGetDoc uses a fresh store per call, so the blob
	// file won't exist. The key point: the response must NOT be a redirect
	// (3xx). It will be either 200 (blob found) or 500 (blob missing in temp
	// store). Either way, never 3xx.
	resp := staffDownloadRequest(t, fx, sid, d.ID)
	if resp.Code/100 == 3 {
		t.Fatalf("DownloadStaffDocument returned a redirect (%d) — documents must never be served via public URL", resp.Code)
	}
}

func TestDownloadStaffDocument_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	sid := fx1.staffSeedMember("FX1 Staff", "active")
	// Seed a doc row for fx1's staff without a real blob (404 is expected).
	docID := fx1.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/x.png", "image/png", "x.png")

	// fx2 tries to download fx1's document — RLS must block it.
	callHandler(t, fx2, DownloadStaffDocument(newLocalStore(t)), "GET", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID.String()})).
		expectErr(404, "not_found")
}

// =========================================================================
// DeleteStaffDocument
// =========================================================================

func TestDeleteStaffDocument_BadStaffID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": "not-a-uuid", "docId": uuid.NewString()})).
		expectErr(400, "bad_request")
}

func TestDeleteStaffDocument_BadDocID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "docId": "not-a-uuid"})).
		expectErr(400, "bad_request")
}

func TestDeleteStaffDocument_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "docId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestDeleteStaffDocument_DocBelongsToDifferentStaff(t *testing.T) {
	fx := newTenant(t)
	s1 := fx.staffSeedMember("Staff One", "active")
	s2 := fx.staffSeedMember("Staff Two", "active")
	docID := fx.staffSeedDocument(s1, "id_card", "t/"+s1.String()+"/x.png", "image/png", "x.png")

	// Attempting to delete s1's doc scoped to s2 must be not_found.
	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": s2.String(), "docId": docID.String()})).
		expectErr(404, "not_found")

	// Document must still exist.
	if fx.staffDocDeleted(docID) {
		t.Fatal("doc was deleted despite belonging to a different staff member")
	}
}

func TestDeleteStaffDocument_AlreadyDeletedIsNotFound(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Worker", "active")
	docID := fx.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/x.png", "image/png", "x.png")
	fx.adminExec(`UPDATE staff_documents SET deleted_at = now() WHERE id = $1`, docID)

	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID.String()})).
		expectErr(404, "not_found")
}

func TestDeleteStaffDocument_SoftDeletesSetsDeletedAt(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Doc Owner", "active")
	docID := fx.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/x.png", "image/png", "x.png")

	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID.String()})).
		expectStatus(204)

	if !fx.staffDocDeleted(docID) {
		t.Fatal("deleted_at is still NULL after DeleteStaffDocument")
	}
}

func TestDeleteStaffDocument_RowStillExistsAfterDelete(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Doc Owner", "active")
	docID := fx.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/x.png", "image/png", "x.png")

	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID.String()})).
		expectStatus(204)

	var count int
	fx.adminScan([]any{&count}, `SELECT count(*) FROM staff_documents WHERE id = $1`, docID)
	if count != 1 {
		t.Fatalf("row count = %d after soft-delete, want 1 (row must persist)", count)
	}
}

func TestDeleteStaffDocument_DocCountDecrements(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Count Worker", "active")
	docID1 := fx.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/a.png", "image/png", "a.png")
	_ = fx.staffSeedDocument(sid, "contract", "t/"+sid.String()+"/b.pdf", "application/pdf", "b.pdf")

	if n := fx.staffDocCount(sid); n != 2 {
		t.Fatalf("pre-delete doc count = %d, want 2", n)
	}

	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID1.String()})).
		expectStatus(204)

	if n := fx.staffDocCount(sid); n != 1 {
		t.Fatalf("post-delete doc count = %d, want 1", n)
	}
}

func TestDeleteStaffDocument_NotVisibleAfterDeleteInGetStaff(t *testing.T) {
	fx := newTenant(t)
	sid := fx.staffSeedMember("Worker", "active")
	docID := fx.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/x.png", "image/png", "x.png")

	callHandler(t, fx, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID.String()})).
		expectStatus(204)

	// GetStaff must not return the deleted document.
	r := callHandler(t, fx, GetStaff, "GET", "/", nil,
		withParam("id", sid.String())).
		expectStatus(200)
	var detail staffDetail
	r.decode(&detail)
	if len(detail.Documents) != 0 {
		t.Fatalf("GetStaff returned %d documents after delete, want 0", len(detail.Documents))
	}
}

func TestDeleteStaffDocument_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	sid := fx1.staffSeedMember("FX1 Staff", "active")
	docID := fx1.staffSeedDocument(sid, "id_card", "t/"+sid.String()+"/x.png", "image/png", "x.png")

	callHandler(t, fx2, DeleteStaffDocument(newLocalStore(t)), "DELETE", "/", nil,
		withParams(map[string]string{"id": sid.String(), "docId": docID.String()})).
		expectErr(404, "not_found")

	if fx1.staffDocDeleted(docID) {
		t.Fatal("another tenant's delete call soft-deleted fx1's document")
	}
}
