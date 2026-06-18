package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

const (
	maxBugAttachmentBytes = 5 * 1024 * 1024 // 5 MB per screenshot
	maxBugAttachments     = 5
)

// allowedBugImageTypes maps a sniffed content type to a file extension.
// Screenshots only — images, so no executable/document surface.
var allowedBugImageTypes = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif":  ".gif",
}

var validBugKinds = map[string]bool{"bug": true, "idea": true, "question": true, "other": true}

// BugReportMine is one row of the reporter's own "Your reports" list.
type BugReportMine struct {
	ID              uuid.UUID `json:"id"`
	Kind            string    `json:"kind"`
	Mood            *int16    `json:"mood,omitempty"`
	Title           string    `json:"title"`
	Description     string    `json:"description"`
	Status          string    `json:"status"`
	Priority        string    `json:"priority"`
	AttachmentCount int       `json:"attachment_count"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// CreateBugReport — POST /v1/bug-reports. One multipart request carries the
// report fields plus 0..5 screenshots, all committed in the request tx so a
// half-written report can never linger. Open to every member (no permission
// gate) — anyone hitting a snag should be able to tell us.
func CreateBugReport(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		u, _ := appctx.UserFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		// Allow the whole batch of attachments plus form fields in memory/temp.
		if err := r.ParseMultipartForm(maxBugAttachmentBytes*maxBugAttachments + 1<<20); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "multipart parse: "+err.Error())
			return
		}

		kind := strings.TrimSpace(r.FormValue("kind"))
		if kind == "" {
			kind = "bug"
		}
		if !validBugKinds[kind] {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid kind")
			return
		}
		description := strings.TrimSpace(r.FormValue("description"))
		if description == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "description required")
			return
		}
		if len(description) > 10000 {
			description = description[:10000]
		}
		title := strings.TrimSpace(r.FormValue("title"))

		var mood *int16
		if ms := strings.TrimSpace(r.FormValue("mood")); ms != "" {
			if mv, err := strconv.Atoi(ms); err == nil && mv >= 1 && mv <= 5 {
				m := int16(mv)
				mood = &m
			}
		}

		pageURL := trimTo(r.FormValue("page_url"), 1000)
		appVersion := trimTo(r.FormValue("app_version"), 100)
		userAgent := trimTo(r.FormValue("user_agent"), 500)
		viewport := trimTo(r.FormValue("viewport"), 50)

		var reportID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO bug_reports
				(tenant_id, tenant_slug, cafe_name, reporter_user_id, reporter_name, reporter_email,
				 kind, mood, title, description, page_url, app_version, user_agent, viewport)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
			RETURNING id`,
			t.ID, t.Slug, t.Name, u.ID, u.Name, u.Email,
			kind, mood, title, description, pageURL, appVersion, userAgent, viewport,
		).Scan(&reportID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Store each screenshot privately, then record it. Track the object keys
		// so we can delete them if the tx later rolls back (5xx) and orphans them.
		files := r.MultipartForm.File["files"]
		if len(files) > maxBugAttachments {
			files = files[:maxBugAttachments]
		}
		var putKeys []string
		fail := func(code int, kindStr, msg string) {
			for _, k := range putKeys {
				_ = store.Delete(r.Context(), k)
			}
			writeErr(w, code, kindStr, msg)
		}

		for _, fh := range files {
			if fh.Size > maxBugAttachmentBytes {
				fail(http.StatusRequestEntityTooLarge, "too_large", "each screenshot must be ≤ 5 MB")
				return
			}
			f, err := fh.Open()
			if err != nil {
				fail(http.StatusBadRequest, "bad_request", "could not read upload")
				return
			}
			head := make([]byte, 512)
			n, _ := io.ReadFull(f, head)
			contentType := http.DetectContentType(head[:n])
			ext, ok := allowedBugImageTypes[contentType]
			if !ok {
				f.Close()
				fail(http.StatusUnsupportedMediaType, "bad_type", "only PNG, JPEG, WEBP, or GIF screenshots allowed")
				return
			}

			rnd := make([]byte, 12)
			_, _ = rand.Read(rnd)
			key := t.Slug + "/bug_reports/" + reportID.String() + "/" + hex.EncodeToString(rnd) + ext

			body := io.MultiReader(bytes.NewReader(head[:n]), f)
			if _, err := store.Put(r.Context(), key, body, storage.PutOpts{ContentType: contentType}); err != nil {
				f.Close()
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			f.Close()
			putKeys = append(putKeys, key)

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO bug_report_attachments
					(bug_report_id, tenant_id, storage_key, file_name, mime_type, size_bytes)
				VALUES ($1, $2, $3, $4, $5, $6)`,
				reportID, t.ID, key, fh.Filename, contentType, fh.Size,
			); err != nil {
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "bug_report", EntityID: &reportID,
			Summary: fmt.Sprintf("reported a %s%s", kind, summarySuffix(title)),
		}); err != nil {
			for _, k := range putKeys {
				_ = store.Delete(r.Context(), k)
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"id":  reportID,
			"ref": bugRef(reportID),
		})
	}
}

// ListMyBugReports — GET /v1/bug-reports/mine. The reporter's own submissions,
// so they can watch a report travel from open to resolved. RLS already pins
// this to the active tenant; the WHERE pins it to the caller.
func ListMyBugReports(w http.ResponseWriter, r *http.Request) {
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), `
		SELECT b.id, b.kind, b.mood, b.title, b.description, b.status, b.priority,
		       (SELECT count(*) FROM bug_report_attachments a WHERE a.bug_report_id = b.id),
		       b.created_at, b.updated_at
		FROM bug_reports b
		WHERE b.reporter_user_id = $1 AND b.deleted_at IS NULL
		ORDER BY b.created_at DESC
		LIMIT 100`, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []BugReportMine{}
	for rows.Next() {
		var b BugReportMine
		if err := rows.Scan(&b.ID, &b.Kind, &b.Mood, &b.Title, &b.Description, &b.Status,
			&b.Priority, &b.AttachmentCount, &b.CreatedAt, &b.UpdatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": out})
}

// DownloadBugAttachment — GET /v1/bug-reports/{id}/attachments/{attId}.
// Streams a private screenshot back to a member of the owning tenant (RLS).
// Mirrors DownloadStaffDocument: never cached, served inline.
func DownloadBugAttachment(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		attID, err := uuid.Parse(chi.URLParam(r, "attId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid attachment id")
			return
		}
		streamBugAttachment(w, r, store, reportID, attID)
	}
}

// streamBugAttachment is the shared body for the tenant + platform download
// proxies. The SELECT is RLS-gated, so the policy (tenant isolation or platform
// admin) decides whether the row is visible at all.
func streamBugAttachment(w http.ResponseWriter, r *http.Request, store storage.Storage, reportID, attID uuid.UUID) {
	tx := appctx.Tx(r.Context())
	var storageKey, mimeType, fileName string
	err := tx.QueryRow(r.Context(), `
		SELECT storage_key, mime_type, file_name
		FROM bug_report_attachments
		WHERE id = $1 AND bug_report_id = $2`, attID, reportID,
	).Scan(&storageKey, &mimeType, &fileName)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
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

// bugRef is the short, friendly reference shown to the user ("Ref #A1B2C3").
func bugRef(id uuid.UUID) string {
	return strings.ToUpper(id.String()[:6])
}

func summarySuffix(title string) string {
	if title == "" {
		return ""
	}
	return ": " + audit.Quote(title)
}

func trimTo(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max]
	}
	return s
}
