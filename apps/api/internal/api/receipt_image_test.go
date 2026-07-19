package api

// Integration tests for UploadReceiptImage — the customer-receipt image
// (e.g. a payment QR) persisted on preferences.receiptImageUrl.

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// uploadReceiptImage fires a multipart POST as the fixture owner. When
// contentBytes is nil the file field is omitted entirely.
func uploadReceiptImage(t *testing.T, fx *fixture, store storage.Storage, filename string, contentBytes []byte) *apiResp {
	t.Helper()
	requireDB(t)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if contentBytes != nil {
		fw, err := mw.CreateFormFile("file", filename)
		if err != nil {
			t.Fatalf("form file: %v", err)
		}
		_, _ = fw.Write(contentBytes)
	} else {
		_ = mw.WriteField("noop", "1")
	}
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/tenant/receipt-image", &buf)
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
	ctx = appctx.WithRequestID(ctx, "test-receipt-img")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	ctx = appctx.WithLogger(ctx, discardLogger())
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	UploadReceiptImage(store).ServeHTTP(rec, req)
	if rec.Code < 500 {
		if err := tx.Commit(bg); err == nil {
			committed = true
			appctx.RunPostCommit(ctx)
		}
	}
	return &apiResp{t: t, Code: rec.Code, Body: rec.Body.Bytes(), Hdr: rec.Result().Header}
}

func TestUploadReceiptImage_Success(t *testing.T) {
	fx := newTenant(t)
	store := newLocalStore(t)

	resp := uploadReceiptImage(t, fx, store, "qr.png", minimalPNG)
	resp.expectStatus(http.StatusCreated)
	m := resp.json()
	if m["receipt_image_url"] == nil || m["receipt_image_url"] == "" {
		t.Fatalf("receipt_image_url missing in response: %v", m)
	}

	// Persisted on preferences.receiptImageUrl.
	var url string
	fx.adminScan([]any{&url},
		`SELECT preferences->>'receiptImageUrl' FROM tenants WHERE id = $1`, fx.Tenant)
	if url == "" {
		t.Fatal("preferences.receiptImageUrl not persisted")
	}
}

func TestUploadReceiptImage_MissingFile(t *testing.T) {
	fx := newTenant(t)
	store := newLocalStore(t)
	uploadReceiptImage(t, fx, store, "", nil).expectErr(http.StatusBadRequest, "bad_request")
}

func TestUploadReceiptImage_BadType(t *testing.T) {
	fx := newTenant(t)
	store := newLocalStore(t)
	// A plain-text payload sniffs as text/plain → unsupported.
	uploadReceiptImage(t, fx, store, "note.txt", []byte("just some text, not an image at all")).
		expectErr(http.StatusUnsupportedMediaType, "bad_type")
}
