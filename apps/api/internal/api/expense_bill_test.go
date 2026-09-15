package api

import (
	"bytes"
	"context"
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
// Expense bills (0084)
//
// A supplier invoice carries the vendor's bank details and their prices, so the
// thing these tests guard is that it stays PRIVATE: a storage key rather than a
// URL, served only through a permission-checked proxy, and confined to its own
// cafe by RLS.
// =========================================================================

// uploadBill fires a multipart POST as the fixture owner. Mirrors bugCreate's
// context wiring, which is the established way to test a multipart handler here.
func uploadBill(t *testing.T, fx *fixture, store storage.Storage, name string, body []byte) *apiResp {
	t.Helper()
	requireDB(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	_, _ = fw.Write(body)
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/expenses/documents", &buf)
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
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, chi.NewRouteContext())
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug, Name: fx.Name, Timezone: "Asia/Kathmandu"})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-bill-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	UploadExpenseBill(store).ServeHTTP(rec, req)
	if rec.Code < 500 {
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}
	return &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

func TestUploadBill_IsPrivateAndReturnsNoURL(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, fx, store, "invoice.png", minimalPNG).
		expectStatus(http.StatusCreated).decode(&d)

	// The response must not hand out anything fetchable without auth. A menu
	// photo returns {"url": ...}; a supplier bill deliberately does not.
	if bytes.Contains(uploadBill(t, fx, store, "invoice.png", minimalPNG).Body, []byte(`"url"`)) {
		t.Fatal("the upload response contained a URL — a bill is served only through the authed proxy")
	}

	var key string
	fx.adminScan([]any{&key}, `SELECT storage_key FROM expense_documents WHERE id = $1`, d.ID)
	if key == "" {
		t.Fatal("no storage key recorded")
	}
	// Unclaimed until an expense is saved.
	if d.ExpenseID != nil {
		t.Fatal("a freshly uploaded bill was already attached to an expense")
	}
}

func TestUploadBill_AcceptsPDF(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, fx, store, "invoice.pdf", minimalPDF).
		expectStatus(http.StatusCreated).decode(&d)
	if d.MimeType != "application/pdf" {
		t.Fatalf("mime = %q, want application/pdf — a real supplier sends a PDF", d.MimeType)
	}
}

func TestUploadBill_RejectsAnythingElse(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	// The type is SNIFFED, so a .png filename on a script body is still refused.
	uploadBill(t, fx, store, "invoice.png", []byte("#!/bin/sh\nrm -rf /\n")).
		expectStatus(http.StatusUnsupportedMediaType)

	if n := fx.countRows("expense_documents"); n != 0 {
		t.Fatalf("a rejected upload still wrote %d row(s)", n)
	}
}

func TestExpenseBill_ClaimedOnSaveAndListedOnRead(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, fx, store, "invoice.pdf", minimalPDF).
		expectStatus(http.StatusCreated).decode(&d)

	var e Expense
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor":              "Fresh Foods",
		"amount_cents":        125050,
		"paid_from":           "bank",
		"document_ids":        []string{d.ID.String()},
		"ai_suggested_fields": []string{"vendor", "amount_cents"},
		"ai_model":            "gemini-2.5-flash",
	}).expectStatus(http.StatusCreated).decode(&e)

	if len(e.Documents) != 1 || e.Documents[0].ID != d.ID {
		t.Fatalf("documents = %+v, want the uploaded bill attached", e.Documents)
	}
	if len(e.AISuggestedFields) != 2 {
		t.Fatalf("ai_suggested_fields = %v, want the two the operator left alone", e.AISuggestedFields)
	}
}

func TestExpenseBill_RejectsAnUnknownProvenanceField(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	before := fx.countRows("expenses")
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor":              "Fresh Foods",
		"amount_cents":        1000,
		"paid_from":           "bank",
		"ai_suggested_fields": []string{"vendor", "bank_account"},
	}).expectStatus(http.StatusBadRequest)

	// A 4xx still COMMITS, so the expense must not exist either.
	if after := fx.countRows("expenses"); after != before {
		t.Fatalf("a rejected provenance list still wrote an expense: %d -> %d", before, after)
	}
}

func TestExpenseBill_ClaimingCannotStealAnAttachedBill(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, fx, store, "invoice.pdf", minimalPDF).
		expectStatus(http.StatusCreated).decode(&d)

	var first Expense
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Fresh Foods", "amount_cents": 1000, "paid_from": "bank",
		"document_ids": []string{d.ID.String()},
	}).expectStatus(http.StatusCreated).decode(&first)

	// A second expense naming the same bill must not move it.
	var second Expense
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Other Supplier", "amount_cents": 2000, "paid_from": "bank",
		"document_ids": []string{d.ID.String()},
	}).expectStatus(http.StatusCreated).decode(&second)

	if len(second.Documents) != 0 {
		t.Fatal("an already-attached bill was re-claimed by a second expense")
	}
	var owner uuid.UUID
	fx.adminScan([]any{&owner}, `SELECT expense_id FROM expense_documents WHERE id = $1`, d.ID)
	if owner != first.ID {
		t.Fatalf("the bill moved to another expense: %v", owner)
	}
}

func TestExpenseBill_DeletingTheExpenseKeepsItsBill(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, fx, store, "invoice.pdf", minimalPDF).
		expectStatus(http.StatusCreated).decode(&d)
	var e Expense
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Fresh Foods", "amount_cents": 1000, "paid_from": "bank",
		"document_ids": []string{d.ID.String()},
	}).expectStatus(http.StatusCreated).decode(&e)

	callHandler(t, fx, DeleteExpense, http.MethodDelete, "/", nil,
		withParam("id", e.ID.String())).expectStatus(http.StatusNoContent)

	// The expense is soft-deleted and the bill is the evidence for WHY it was
	// ever recorded. Destroying it with the row would destroy the audit trail.
	var deletedAt *string
	fx.adminScan([]any{&deletedAt},
		`SELECT to_char(deleted_at, 'YYYY-MM-DD') FROM expense_documents WHERE id = $1`, d.ID)
	if deletedAt != nil {
		t.Fatal("the bill was deleted along with its expense")
	}
}

func TestExpenseBill_CrossTenantReadIsNotFound(t *testing.T) {
	requireDB(t)
	a := newTenant(t)
	b := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, a, store, "invoice.pdf", minimalPDF).
		expectStatus(http.StatusCreated).decode(&d)

	// Tenant B knows the id and still cannot reach it: RLS, not a check in the
	// handler, is what makes that true.
	callHandler(t, b, DownloadExpenseBill(store), http.MethodGet, "/",
		nil, withParam("docId", d.ID.String())).
		expectStatus(http.StatusNotFound)
}

func TestExpenseBill_TablesAreGrantedToTheAppRole(t *testing.T) {
	requireDB(t)

	// Tests run as SUPERUSER, so a missing GRANT is invisible to every other
	// test in this file and fails only in the live API. This repo has been
	// bitten by exactly that twice, so the grant is asserted directly.
	for _, c := range []struct{ table, priv string }{
		{"expense_documents", "SELECT"},
		{"expense_documents", "INSERT"},
		{"expense_documents", "UPDATE"},
		{"ai_usage", "SELECT"},
		{"ai_usage", "INSERT"},
	} {
		var ok bool
		if err := adminPool.QueryRow(context.Background(),
			`SELECT has_table_privilege('app', $1, $2)`, c.table, c.priv).Scan(&ok); err != nil {
			t.Fatalf("privilege check: %v", err)
		}
		if !ok {
			t.Fatalf("app lacks %s on %s — this only fails in production", c.priv, c.table)
		}
	}
}

func TestBillRead_DisabledReturnsNoSuggestion(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store := newLocalStore(t)

	var d ExpenseDocument
	uploadBill(t, fx, store, "invoice.pdf", minimalPDF).
		expectStatus(http.StatusCreated).decode(&d)

	// A nil reader is the normal state for every cafe until somebody configures
	// a key. It must be a 200 with nothing to prefill, not an error.
	m := callHandler(t, fx, BillRead(store, nil), http.MethodPost, "/", nil,
		withParam("docId", d.ID.String())).expectStatus(http.StatusOK).json()
	if m["suggestion"] != nil {
		t.Fatalf("suggestion = %v, want null when the feature is off", m["suggestion"])
	}
	if n := fx.countRows("ai_usage"); n != 0 {
		t.Fatalf("a disabled reader wrote %d ledger row(s)", n)
	}
}
