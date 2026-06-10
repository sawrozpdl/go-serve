package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// =========================================================================
// STAFF MANAGEMENT (0023)
//
// A standalone employee registry (see migration 0023). Staff are NOT login
// members — they're people whose profile + personal documents the cafe tracks.
// Documents are sensitive IDs (citizenship, licence, …): they're stored
// PRIVATELY and only ever streamed back through DownloadStaffDocument, which
// is gated by staff:read and audits each view. Their public URL is never
// exposed — the DB keeps only the private storage key.
// =========================================================================

// Wire types

type Staff struct {
	ID        uuid.UUID `json:"id"`
	FullName  string    `json:"full_name"`
	RoleTitle string    `json:"role_title"`
	Phone     string    `json:"phone"`
	Email     *string   `json:"email,omitempty"`
	Status    string    `json:"status"`
	StartedOn *string   `json:"started_on,omitempty"` // "YYYY-MM-DD"
	Notes     string    `json:"notes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	DocCount  int       `json:"doc_count"`
}

type StaffDocument struct {
	ID        uuid.UUID `json:"id"`
	StaffID   uuid.UUID `json:"staff_id"`
	DocType   string    `json:"doc_type"`
	Label     string    `json:"label"`
	FileName  string    `json:"file_name"`
	MimeType  string    `json:"mime_type"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

type staffDetail struct {
	Staff
	Documents []StaffDocument `json:"documents"`
}

const staffSelect = `
	SELECT s.id, s.full_name, s.role_title, s.phone, s.email,
	       s.status, to_char(s.started_on, 'YYYY-MM-DD'), s.notes,
	       s.created_at, s.updated_at,
	       (SELECT count(*) FROM staff_documents d
	          WHERE d.staff_id = s.id AND d.deleted_at IS NULL) AS doc_count
	FROM staff s`

func scanStaff(row pgx.Row) (Staff, error) {
	var s Staff
	err := row.Scan(&s.ID, &s.FullName, &s.RoleTitle, &s.Phone, &s.Email,
		&s.Status, &s.StartedOn, &s.Notes, &s.CreatedAt, &s.UpdatedAt, &s.DocCount)
	return s, err
}

// blank converts an empty/whitespace string pointer to nil so it persists as
// NULL rather than ''. Used for the optional email + started_on fields.
func blankToNil(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

// =========================================================================
// STAFF PROFILES
// =========================================================================

func ListStaff(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.list")
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), staffSelect+`
		WHERE s.deleted_at IS NULL
		ORDER BY s.status, lower(s.full_name)`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []Staff{}
	for rows.Next() {
		s, err := scanStaff(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"staff": out})
}

func GetStaff(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.get", "id", id)
	tx := appctx.Tx(r.Context())

	s, err := scanStaff(tx.QueryRow(r.Context(), staffSelect+`
		WHERE s.id = $1 AND s.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	docs, err := listStaffDocuments(r, tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, staffDetail{Staff: s, Documents: docs})
}

func CreateStaff(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	var body struct {
		FullName  string  `json:"full_name"`
		RoleTitle string  `json:"role_title"`
		Phone     string  `json:"phone"`
		Email     *string `json:"email"`
		Status    *string `json:"status"`
		StartedOn *string `json:"started_on"`
		Notes     string  `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	body.FullName = strings.TrimSpace(body.FullName)
	if body.FullName == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "full_name required")
		return
	}
	status := "active"
	if body.Status != nil {
		status = *body.Status
	}
	if status != "active" && status != "inactive" {
		writeErr(w, http.StatusBadRequest, "bad_request", "status must be active or inactive")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.create", "name", body.FullName)
	tx := appctx.Tx(r.Context())

	s, err := scanStaff(tx.QueryRow(r.Context(), `
		INSERT INTO staff (tenant_id, full_name, role_title, phone, email, status, started_on, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
		RETURNING id, full_name, role_title, phone, email, status,
		          to_char(started_on, 'YYYY-MM-DD'), notes, created_at, updated_at, 0`,
		t.ID, body.FullName, body.RoleTitle, body.Phone, blankToNil(body.Email),
		status, blankToNil(body.StartedOn), body.Notes))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "staff", EntityID: &s.ID,
		Summary: fmt.Sprintf("added staff %s", audit.Quote(s.FullName)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

func UpdateStaff(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		FullName  *string `json:"full_name"`
		RoleTitle *string `json:"role_title"`
		Phone     *string `json:"phone"`
		Email     *string `json:"email"`
		Status    *string `json:"status"`
		StartedOn *string `json:"started_on"`
		Notes     *string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.Status != nil && *body.Status != "active" && *body.Status != "inactive" {
		writeErr(w, http.StatusBadRequest, "bad_request", "status must be active or inactive")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.update", "id", id)
	tx := appctx.Tx(r.Context())

	s, err := scanStaff(tx.QueryRow(r.Context(), `
		UPDATE staff SET
			full_name  = COALESCE($2, full_name),
			role_title = COALESCE($3, role_title),
			phone      = COALESCE($4, phone),
			email      = COALESCE($5, email),
			status     = COALESCE($6, status),
			started_on = COALESCE($7::date, started_on),
			notes      = COALESCE($8, notes)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, full_name, role_title, phone, email, status,
		          to_char(started_on, 'YYYY-MM-DD'), notes, created_at, updated_at,
		          (SELECT count(*) FROM staff_documents d WHERE d.staff_id = staff.id AND d.deleted_at IS NULL)`,
		id, body.FullName, body.RoleTitle, body.Phone, blankToNil(body.Email),
		body.Status, blankToNil(body.StartedOn), body.Notes))
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "staff", EntityID: &s.ID,
		Summary: fmt.Sprintf("updated staff %s", audit.Quote(s.FullName)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func DeleteStaff(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.delete", "id", id)
	tx := appctx.Tx(r.Context())

	var name string
	if err := tx.QueryRow(r.Context(),
		`UPDATE staff SET deleted_at = now()
		 WHERE id = $1 AND deleted_at IS NULL RETURNING full_name`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "staff", EntityID: &id,
		Summary: fmt.Sprintf("removed staff %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// STAFF DOCUMENTS
// =========================================================================

const maxStaffDocBytes = 10 * 1024 * 1024 // 10MB

// allowedStaffDocTypes maps a sniffed content type to a file extension.
// Only image scans and PDFs for now (per the feature scope).
var allowedStaffDocTypes = map[string]string{
	"image/png":       ".png",
	"image/jpeg":      ".jpg",
	"image/webp":      ".webp",
	"application/pdf": ".pdf",
}

func listStaffDocuments(r *http.Request, tx pgx.Tx, staffID uuid.UUID) ([]StaffDocument, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT id, staff_id, doc_type, label, file_name, mime_type, size_bytes, created_at
		FROM staff_documents
		WHERE staff_id = $1 AND deleted_at IS NULL
		ORDER BY created_at DESC`, staffID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StaffDocument{}
	for rows.Next() {
		var d StaffDocument
		if err := rows.Scan(&d.ID, &d.StaffID, &d.DocType, &d.Label,
			&d.FileName, &d.MimeType, &d.SizeBytes, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// staffExists confirms the staff row is live for the current tenant (RLS).
func staffExists(r *http.Request, tx pgx.Tx, staffID uuid.UUID) (bool, error) {
	var one int
	err := tx.QueryRow(r.Context(),
		`SELECT 1 FROM staff WHERE id = $1 AND deleted_at IS NULL`, staffID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func UploadStaffDocument(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		u, _ := appctx.UserFromContext(r.Context())
		staffID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		tx := appctx.Tx(r.Context())

		ok, err := staffExists(r, tx, staffID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !ok {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}

		if err := r.ParseMultipartForm(maxStaffDocBytes + 1024); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "multipart parse: "+err.Error())
			return
		}
		docType := strings.TrimSpace(r.FormValue("doc_type"))
		if docType == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "doc_type required")
			return
		}
		label := strings.TrimSpace(r.FormValue("label"))

		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "file field missing")
			return
		}
		defer file.Close()
		if header.Size > maxStaffDocBytes {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "document must be ≤ 10 MB")
			return
		}

		head := make([]byte, 512)
		n, _ := io.ReadFull(file, head)
		contentType := http.DetectContentType(head[:n])
		ext, ok := allowedStaffDocTypes[contentType]
		if !ok {
			writeErr(w, http.StatusUnsupportedMediaType, "bad_type",
				"only PDF, PNG, JPEG, or WEBP allowed")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "staff.upload_document",
			"staff_id", staffID, "doc_type", docType, "content_type", contentType, "size", header.Size)

		rnd := make([]byte, 12)
		_, _ = rand.Read(rnd)
		key := t.Slug + "/staff/" + staffID.String() + "/" + hex.EncodeToString(rnd) + ext

		body := io.MultiReader(bytes.NewReader(head[:n]), file)
		// Sensitive — stays private (the PutOpts default) and is never served
		// via a public URL, only through the staff:read-gated /file proxy.
		if _, err := store.Put(r.Context(), key, body, storage.PutOpts{
			ContentType: contentType,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		var d StaffDocument
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_documents
				(tenant_id, staff_id, doc_type, label, storage_key, file_name, mime_type, size_bytes, uploaded_by_user_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id, staff_id, doc_type, label, file_name, mime_type, size_bytes, created_at`,
			t.ID, staffID, docType, label, key, header.Filename, contentType, header.Size, u.ID,
		).Scan(&d.ID, &d.StaffID, &d.DocType, &d.Label, &d.FileName, &d.MimeType, &d.SizeBytes, &d.CreatedAt); err != nil {
			// Best-effort cleanup of the orphaned object before failing.
			_ = store.Delete(r.Context(), key)
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		docLabel := docType
		if label != "" {
			docLabel = docType + " (" + label + ")"
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "staff_document", EntityID: &d.ID,
			Summary: fmt.Sprintf("uploaded %s document for staff %s", audit.Quote(docLabel), staffID.String()),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, d)
	}
}

// DownloadStaffDocument streams a private staff document back to an authorised
// caller. Gated by staff:read; the file's content-type comes from the row, not
// from the bytes. Every view is recorded in the audit log.
func DownloadStaffDocument(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		staffID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		docID, err := uuid.Parse(chi.URLParam(r, "docId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid doc id")
			return
		}
		tx := appctx.Tx(r.Context())

		var storageKey, mimeType, fileName string
		err = tx.QueryRow(r.Context(), `
			SELECT storage_key, mime_type, file_name
			FROM staff_documents
			WHERE id = $1 AND staff_id = $2 AND deleted_at IS NULL`, docID, staffID,
		).Scan(&storageKey, &mimeType, &fileName)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Audit the view before streaming (once the body starts we can't change status).
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "read", Entity: "staff_document", EntityID: &docID,
			Summary: fmt.Sprintf("viewed a document for staff %s", staffID.String()),
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
		// Private, never cache on shared proxies. Inline so images/PDFs render.
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

func DeleteStaffDocument(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		staffID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		docID, err := uuid.Parse(chi.URLParam(r, "docId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid doc id")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "staff.delete_document", "staff_id", staffID, "doc_id", docID)
		tx := appctx.Tx(r.Context())

		var storageKey, docType string
		if err := tx.QueryRow(r.Context(), `
			UPDATE staff_documents SET deleted_at = now()
			WHERE id = $1 AND staff_id = $2 AND deleted_at IS NULL
			RETURNING storage_key, doc_type`, docID, staffID,
		).Scan(&storageKey, &docType); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "staff_document", EntityID: &docID,
			Summary: fmt.Sprintf("deleted %s document for staff %s", audit.Quote(docType), staffID.String()),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Best-effort blob removal — the row is the source of truth, so a
		// transient storage error shouldn't fail the (already committed) delete.
		if err := store.Delete(r.Context(), storageKey); err != nil {
			log.WarnContext(r.Context(), "staff.delete_document.blob_orphaned",
				"key", storageKey, "err", err.Error())
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
