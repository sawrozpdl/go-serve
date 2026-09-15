package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/billread"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// Expense bills: the supplier invoice behind a number in the books.
//
// PRIVATE, like a staff document and unlike a menu photo. A supplier invoice
// carries the vendor's bank details, their PAN, sometimes a phone number and
// always their prices — so it follows staff_documents' pattern exactly: the row
// stores a storage key, the bytes are served only through an authenticated
// permission-checked proxy, and every view is audited. expenses.receipt_url,
// which has existed unused since 0006, is the wrong shape for this: a bare URL
// implies a public object. See migration 0084.

const maxExpenseBillBytes = 10 * 1024 * 1024 // 10MB

// allowedExpenseBillTypes maps a SNIFFED content type to a file extension.
// Sniffed, never the client's Content-Type header — that is caller-controlled
// and is not evidence of anything. PDF first because that is what a real
// supplier sends.
var allowedExpenseBillTypes = map[string]string{
	"application/pdf": ".pdf",
	"image/png":       ".png",
	"image/jpeg":      ".jpg",
	"image/webp":      ".webp",
}

// aiSuggestibleFields bounds what a client may claim a model proposed. The list
// is an honesty record rather than a security control (see 0084), but an
// unbounded text[] written straight from a request body is not something to
// leave open regardless.
var aiSuggestibleFields = map[string]bool{
	"vendor":       true,
	"amount_cents": true,
	"paid_at":      true,
	"reference":    true,
}

// ExpenseDocument is one bill attached to (or waiting to be attached to) an
// expense.
type ExpenseDocument struct {
	ID        uuid.UUID  `json:"id"`
	ExpenseID *uuid.UUID `json:"expense_id"`
	FileName  string     `json:"file_name"`
	MimeType  string     `json:"mime_type"`
	SizeBytes int64      `json:"size_bytes"`
	CreatedAt time.Time  `json:"created_at"`
}

// UploadExpenseBill stores a bill privately and returns an UNCLAIMED document
// row.
//
// It deliberately does not read the bill. Extraction is a separate endpoint so
// that a slow third party is never in the path of storing the evidence: the
// bill is safe on disk whether or not any model ever answers.
func UploadExpenseBill(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		u, _ := appctx.UserFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		if err := r.ParseMultipartForm(maxExpenseBillBytes + 1024); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "multipart parse: "+err.Error())
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "file field missing")
			return
		}
		defer file.Close()
		if header.Size > maxExpenseBillBytes {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "bill must be ≤ 10 MB")
			return
		}

		head := make([]byte, 512)
		n, _ := io.ReadFull(file, head)
		contentType := http.DetectContentType(head[:n])
		ext, ok := allowedExpenseBillTypes[contentType]
		if !ok {
			writeErr(w, http.StatusUnsupportedMediaType, "bad_type",
				"only PDF, PNG, JPEG, or WEBP allowed")
			return
		}

		rnd := make([]byte, 12)
		_, _ = rand.Read(rnd)
		key := t.Slug + "/expenses/" + hex.EncodeToString(rnd) + ext

		body := io.MultiReader(bytes.NewReader(head[:n]), file)
		// Private: the PutOpts default. Never Public — see this file's header.
		if _, err := store.Put(r.Context(), key, body, storage.PutOpts{
			ContentType: contentType,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		var d ExpenseDocument
		err = tx.QueryRow(r.Context(), `
			INSERT INTO expense_documents
			  (tenant_id, expense_id, storage_key, file_name, mime_type, size_bytes, uploaded_by_user_id)
			VALUES ($1, NULL, $2, $3, $4, $5, $6)
			RETURNING id, expense_id, file_name, mime_type, size_bytes, created_at
		`, t.ID, key, header.Filename, contentType, header.Size, u.ID).Scan(
			&d.ID, &d.ExpenseID, &d.FileName, &d.MimeType, &d.SizeBytes, &d.CreatedAt)
		if err != nil {
			// Do not leave the blob behind when its row failed to land: an
			// object nothing references is an object nothing will ever delete.
			_ = store.Delete(r.Context(), key)
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, d)
	}
}

// DownloadExpenseBill streams a private bill to an expense:read caller.
func DownloadExpenseBill(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID, err := uuid.Parse(chi.URLParam(r, "docId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid doc id")
			return
		}
		tx := appctx.Tx(r.Context())

		// RLS confines this to the caller's own tenant, so another cafe's id
		// simply does not exist here.
		var storageKey, mimeType, fileName string
		err = tx.QueryRow(r.Context(), `
			SELECT storage_key, mime_type, file_name
			FROM expense_documents
			WHERE id = $1 AND deleted_at IS NULL`, docID,
		).Scan(&storageKey, &mimeType, &fileName)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Audit the view BEFORE streaming — once the body starts the status
		// can no longer be changed.
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "read", Entity: "expense_document", EntityID: &docID,
			Summary: "viewed a supplier bill",
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		rc, err := store.Get(r.Context(), storageKey)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		defer rc.Close()

		if mimeType != "" {
			w.Header().Set("Content-Type", mimeType)
		}
		w.Header().Set("Cache-Control", "private, no-store")
		disp := "inline"
		if fileName != "" {
			disp = fmt.Sprintf("inline; filename=%q", fileName)
		}
		w.Header().Set("Content-Disposition", disp)
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, rc)
	}
}

// DeleteExpenseBill soft-deletes the row and removes the blob.
func DeleteExpenseBill(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID, err := uuid.Parse(chi.URLParam(r, "docId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid doc id")
			return
		}
		tx := appctx.Tx(r.Context())

		var storageKey string
		err = tx.QueryRow(r.Context(), `
			UPDATE expense_documents SET deleted_at = now()
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING storage_key`, docID).Scan(&storageKey)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "expense_document", EntityID: &docID,
			Summary: "removed a supplier bill",
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Best effort: the row is already gone as far as the product is
		// concerned, and a failed blob delete must not fail the request.
		_ = store.Delete(r.Context(), storageKey)
		w.WriteHeader(http.StatusNoContent)
	}
}

// listExpenseDocuments returns the bills attached to one expense.
func listExpenseDocuments(r *http.Request, tx pgx.Tx, expenseID uuid.UUID) ([]ExpenseDocument, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT id, expense_id, file_name, mime_type, size_bytes, created_at
		FROM expense_documents
		WHERE expense_id = $1 AND deleted_at IS NULL
		ORDER BY created_at`, expenseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ExpenseDocument{}
	for rows.Next() {
		var d ExpenseDocument
		if err := rows.Scan(&d.ID, &d.ExpenseID, &d.FileName, &d.MimeType,
			&d.SizeBytes, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// claimExpenseDocuments attaches unclaimed bills to a freshly written expense.
//
// Only UNCLAIMED rows are claimable, so a document already attached to another
// expense cannot be moved by guessing its id, and RLS confines the whole thing
// to the caller's own tenant. The worst a malicious client achieves is
// attaching its own cafe's orphan to its own cafe's expense.
func claimExpenseDocuments(r *http.Request, tx pgx.Tx, expenseID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := tx.Exec(r.Context(), `
		UPDATE expense_documents
		   SET expense_id = $1
		 WHERE id = ANY($2) AND expense_id IS NULL AND deleted_at IS NULL`,
		expenseID, ids)
	return err
}

// validateAISuggestedFields bounds the provenance list.
func validateAISuggestedFields(fields []string) error {
	if len(fields) > len(aiSuggestibleFields) {
		return fmt.Errorf("ai_suggested_fields: too many entries")
	}
	for _, f := range fields {
		if !aiSuggestibleFields[f] {
			return fmt.Errorf("ai_suggested_fields: unknown field %q", f)
		}
	}
	return nil
}

// BillRead reads an uploaded bill and returns a SUGGESTION.
//
// It writes nothing but a usage-ledger row. A nil *billread.Client returns
// {"suggestion": null}, which the form treats as "nothing prefilled" — the
// ordinary case, and the one every cafe gets until somebody configures a key.
func BillRead(store storage.Storage, reader *billread.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		docID, err := uuid.Parse(chi.URLParam(r, "docId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid doc id")
			return
		}

		if !reader.Enabled() {
			writeJSON(w, http.StatusOK, map[string]any{"suggestion": nil})
			return
		}

		var storageKey, mimeType string
		err = tx.QueryRow(r.Context(), `
			SELECT storage_key, mime_type FROM expense_documents
			WHERE id = $1 AND deleted_at IS NULL`, docID).Scan(&storageKey, &mimeType)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// The monthly ceiling is a real limit, not a dashboard.
		var spent int64
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(SUM(cost_micros), 0)::bigint FROM ai_usage
			WHERE purpose = 'bill_read'
			  AND created_at >= date_trunc('month', now())`).Scan(&spent); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if spent >= reader.BudgetMicros() {
			// Over budget is not an error the operator can act on — it is the
			// same outcome as the feature being off. They type the fields.
			writeJSON(w, http.StatusOK, map[string]any{"suggestion": nil})
			return
		}

		today, err := tenantToday(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		todayT, _ := time.Parse("2006-01-02", today)

		rc, err := store.Get(r.Context(), storageKey)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		data, err := io.ReadAll(io.LimitReader(rc, billread.MaxBillBytes+1))
		rc.Close()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		s, err := reader.Extract(r.Context(), billread.Bill{
			Data:     data,
			MimeType: mimeType,
			TZ:       t.Timezone,
			Today:    todayT,
		})

		status := "ok"
		switch {
		case err != nil && billread.IsRejected(err):
			status = "rejected"
		case err != nil:
			status = "error"
		}
		// Ledger every call, including the ones that failed: a month of
		// timeouts is a thing somebody should be able to see.
		if _, ledgerErr := tx.Exec(r.Context(), `
			INSERT INTO ai_usage (tenant_id, purpose, model, input_tokens, output_tokens, cost_micros, status)
			VALUES ($1, 'bill_read', $2, $3, $4, $5, $6)
		`, t.ID, reader.Model(), s.Usage.InputTokens, s.Usage.OutputTokens,
			s.Usage.CostMicros, status); ledgerErr != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", ledgerErr.Error())
			return
		}

		if err != nil {
			// Every failure is the same outcome for the operator: nothing is
			// prefilled and they fill the form themselves. Rule 4.
			writeJSON(w, http.StatusOK, map[string]any{"suggestion": nil})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"suggestion": s})
	}
}
