package super

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

var validBugStatuses = map[string]bool{
	"open": true, "in_progress": true, "resolved": true, "wont_fix": true, "closed": true,
}
var validBugPriorities = map[string]bool{"low": true, "normal": true, "high": true, "urgent": true}

// BugReportRow is one row of the cross-tenant triage list.
type BugReportRow struct {
	ID              uuid.UUID `json:"id"`
	TenantSlug      string    `json:"tenant_slug"`
	CafeName        string    `json:"cafe_name"`
	ReporterName    string    `json:"reporter_name"`
	ReporterEmail   string    `json:"reporter_email"`
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

// BugAttachmentMeta describes a screenshot without its bytes (streamed separately).
type BugAttachmentMeta struct {
	ID        uuid.UUID `json:"id"`
	FileName  string    `json:"file_name"`
	MimeType  string    `json:"mime_type"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// BugReportDetail is the full report shown in the triage drawer.
type BugReportDetail struct {
	BugReportRow
	PageURL        string              `json:"page_url"`
	AppVersion     string              `json:"app_version"`
	UserAgent      string              `json:"user_agent"`
	Viewport       string              `json:"viewport"`
	ResolutionNote string              `json:"resolution_note"`
	ResolvedAt     *time.Time          `json:"resolved_at,omitempty"`
	Attachments    []BugAttachmentMeta `json:"attachments"`
}

const bugListSelect = `
	SELECT b.id, b.tenant_slug, b.cafe_name, b.reporter_name, b.reporter_email,
	       b.kind, b.mood, b.title, b.description, b.status, b.priority,
	       (SELECT count(*) FROM bug_report_attachments a WHERE a.bug_report_id = b.id),
	       b.created_at, b.updated_at
	FROM bug_reports b`

// ListBugReports — GET /v1/super/bug-reports?status=&kind=&priority=&q=&from=&to=&sort=.
// Plain filtered SQL: the platform-admin RLS policy lets this read across every
// tenant, and the denormalized columns mean no joins are needed.
func ListBugReports(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	q := r.URL.Query()

	conds := []string{"b.deleted_at IS NULL"}
	args := []any{}
	eq := func(col, val string) {
		if val != "" && val != "all" {
			args = append(args, val)
			conds = append(conds, fmt.Sprintf("b.%s = $%d", col, len(args)))
		}
	}
	eq("status", q.Get("status"))
	eq("kind", q.Get("kind"))
	eq("priority", q.Get("priority"))

	if term := strings.TrimSpace(q.Get("q")); term != "" {
		args = append(args, "%"+term+"%")
		p := len(args)
		conds = append(conds, fmt.Sprintf(
			"(b.title ILIKE $%d OR b.description ILIKE $%d OR b.cafe_name ILIKE $%d OR b.reporter_email ILIKE $%d)",
			p, p, p, p))
	}
	if from := q.Get("from"); from != "" {
		if ts, err := time.Parse(time.RFC3339, from); err == nil {
			args = append(args, ts)
			conds = append(conds, fmt.Sprintf("b.created_at >= $%d", len(args)))
		}
	}
	if to := q.Get("to"); to != "" {
		if ts, err := time.Parse(time.RFC3339, to); err == nil {
			args = append(args, ts)
			conds = append(conds, fmt.Sprintf("b.created_at <= $%d", len(args)))
		}
	}

	order := "b.created_at DESC"
	switch q.Get("sort") {
	case "oldest":
		order = "b.created_at ASC"
	case "priority":
		order = "(CASE b.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) DESC, b.created_at DESC"
	}

	sql := bugListSelect + " WHERE " + strings.Join(conds, " AND ") + " ORDER BY " + order + " LIMIT 500"
	rows, err := tx.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	reports, err := scanBugRows(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Status tallies for the KPI chips + nav badge — over all live reports,
	// independent of the active filter.
	summary := map[string]int{"open": 0, "in_progress": 0, "resolved": 0, "total": 0}
	srows, err := tx.Query(r.Context(),
		`SELECT status, count(*) FROM bug_reports WHERE deleted_at IS NULL GROUP BY status`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer srows.Close()
	for srows.Next() {
		var st string
		var c int
		if err := srows.Scan(&st, &c); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		summary[st] = c
		summary["total"] += c
	}
	if err := srows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"reports": reports, "summary": summary})
}

func scanBugRows(rows pgx.Rows) ([]BugReportRow, error) {
	defer rows.Close()
	out := []BugReportRow{}
	for rows.Next() {
		var b BugReportRow
		if err := rows.Scan(&b.ID, &b.TenantSlug, &b.CafeName, &b.ReporterName, &b.ReporterEmail,
			&b.Kind, &b.Mood, &b.Title, &b.Description, &b.Status, &b.Priority,
			&b.AttachmentCount, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// GetBugReport — GET /v1/super/bug-reports/{id}. Full report + attachment list.
func GetBugReport(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())

	var d BugReportDetail
	err = tx.QueryRow(r.Context(), `
		SELECT b.id, b.tenant_slug, b.cafe_name, b.reporter_name, b.reporter_email,
		       b.kind, b.mood, b.title, b.description, b.status, b.priority,
		       (SELECT count(*) FROM bug_report_attachments a WHERE a.bug_report_id = b.id),
		       b.created_at, b.updated_at,
		       b.page_url, b.app_version, b.user_agent, b.viewport, b.resolution_note, b.resolved_at
		FROM bug_reports b
		WHERE b.id = $1 AND b.deleted_at IS NULL`, id,
	).Scan(&d.ID, &d.TenantSlug, &d.CafeName, &d.ReporterName, &d.ReporterEmail,
		&d.Kind, &d.Mood, &d.Title, &d.Description, &d.Status, &d.Priority,
		&d.AttachmentCount, &d.CreatedAt, &d.UpdatedAt,
		&d.PageURL, &d.AppVersion, &d.UserAgent, &d.Viewport, &d.ResolutionNote, &d.ResolvedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	arows, err := tx.Query(r.Context(), `
		SELECT id, file_name, mime_type, size_bytes, created_at
		FROM bug_report_attachments
		WHERE bug_report_id = $1 ORDER BY created_at`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer arows.Close()
	d.Attachments = []BugAttachmentMeta{}
	for arows.Next() {
		var a BugAttachmentMeta
		if err := arows.Scan(&a.ID, &a.FileName, &a.MimeType, &a.SizeBytes, &a.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		d.Attachments = append(d.Attachments, a)
	}
	if err := arows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// UpdateBugReport — PATCH /v1/super/bug-reports/{id}. Triage: change status,
// priority, and/or resolution note. Moving into a closed state stamps
// resolved_at/by; reopening clears them.
func UpdateBugReport(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Status         *string `json:"status"`
		Priority       *string `json:"priority"`
		ResolutionNote *string `json:"resolution_note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.Status != nil && !validBugStatuses[*body.Status] {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid status")
		return
	}
	if body.Priority != nil && !validBugPriorities[*body.Priority] {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid priority")
		return
	}

	user, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	var status string
	var tenantID uuid.UUID
	err = tx.QueryRow(r.Context(), `
		UPDATE bug_reports SET
			status          = COALESCE($2, status),
			priority        = COALESCE($3, priority),
			resolution_note = COALESCE($4, resolution_note),
			resolved_at = CASE
				WHEN $2 IN ('resolved','wont_fix','closed') AND resolved_at IS NULL THEN now()
				WHEN $2 IN ('open','in_progress') THEN NULL
				ELSE resolved_at END,
			resolved_by_user_id = CASE
				WHEN $2 IN ('resolved','wont_fix','closed') AND resolved_by_user_id IS NULL THEN $5
				WHEN $2 IN ('open','in_progress') THEN NULL
				ELSE resolved_by_user_id END,
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING status, tenant_id`,
		id, body.Status, body.Priority, body.ResolutionNote, user.ID,
	).Scan(&status, &tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{
		Action:         "bug_report.update",
		TargetTenantID: &tenantID,
		TargetID:       id.String(),
		Summary:        "updated bug report → " + status,
	})
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": status})
}

// DeleteBugReport — POST /v1/super/bug-reports/{id}/delete. Soft delete; the
// row drops out of every list but the attachments stay in storage.
func DeleteBugReport(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	var tenantID uuid.UUID
	err = tx.QueryRow(r.Context(),
		`UPDATE bug_reports SET deleted_at = now(), updated_at = now()
		 WHERE id = $1 AND deleted_at IS NULL RETURNING tenant_id`, id,
	).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{
		Action:         "bug_report.delete",
		TargetTenantID: &tenantID,
		TargetID:       id.String(),
		Summary:        "deleted a bug report",
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
