package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
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
	ID            uuid.UUID       `json:"id"`
	FullName      string          `json:"full_name"`
	RoleTitle     string          `json:"role_title"`
	Phone         string          `json:"phone"`
	Email         *string         `json:"email,omitempty"`
	Status        string          `json:"status"`
	StartedOn     *string         `json:"started_on,omitempty"` // "YYYY-MM-DD"
	EndedOn       *string         `json:"ended_on,omitempty"`   // "YYYY-MM-DD"
	SalaryAmount  *float64        `json:"salary_amount,omitempty"`
	SalaryCadence string          `json:"salary_cadence"` // monthly | hourly | per_shift
	Schedule      json.RawMessage `json:"schedule"`       // weekly template, {"0":{"start","end"},…}
	UserID        *uuid.UUID      `json:"user_id,omitempty"`
	UserEmail     *string         `json:"user_email,omitempty"` // linked team-member account (display only)
	UserName      *string         `json:"user_name,omitempty"`
	Notes         string          `json:"notes"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	DocCount      int             `json:"doc_count"`
}

// StaffPay is one recorded salary payment (the pay-history ledger, 0033).
type StaffPay struct {
	ID          uuid.UUID `json:"id"`
	StaffID     uuid.UUID `json:"staff_id"`
	PaidOn      string    `json:"paid_on"` // "YYYY-MM-DD"
	Amount      float64   `json:"amount"`
	PeriodLabel string    `json:"period_label"`
	Note        string    `json:"note"`
	CreatedAt   time.Time `json:"created_at"`
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
	       s.status, to_char(s.started_on, 'YYYY-MM-DD'), to_char(s.ended_on, 'YYYY-MM-DD'),
	       s.salary_amount, s.salary_cadence, s.schedule,
	       s.user_id, u.email, NULLIF(u.name, ''),
	       s.notes, s.created_at, s.updated_at,
	       (SELECT count(*) FROM staff_documents d
	          WHERE d.staff_id = s.id AND d.deleted_at IS NULL) AS doc_count
	FROM staff s
	LEFT JOIN users u ON u.id = s.user_id`

func scanStaff(row pgx.Row) (Staff, error) {
	var s Staff
	err := row.Scan(&s.ID, &s.FullName, &s.RoleTitle, &s.Phone, &s.Email,
		&s.Status, &s.StartedOn, &s.EndedOn, &s.SalaryAmount, &s.SalaryCadence, &s.Schedule,
		&s.UserID, &s.UserEmail, &s.UserName, &s.Notes, &s.CreatedAt, &s.UpdatedAt, &s.DocCount)
	return s, err
}

// validCadence reports whether c is one of the allowed salary cadences.
func validCadence(c string) bool {
	return c == "monthly" || c == "hourly" || c == "per_shift"
}

// hhmm matches a 24-hour HH:MM time.
var hhmmRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// validateSchedule parses the weekly-template jsonb and checks each present day
// (keys "0".."6") has a well-formed HH:MM range with start < end. An empty or
// absent payload is valid (means "no schedule set").
func validateSchedule(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var days map[string]struct {
		Start string `json:"start"`
		End   string `json:"end"`
	}
	if err := json.Unmarshal(raw, &days); err != nil {
		return fmt.Errorf("schedule: %w", err)
	}
	for k, v := range days {
		if k < "0" || k > "6" || len(k) != 1 {
			return fmt.Errorf("schedule: invalid day key %q", k)
		}
		if !hhmmRe.MatchString(v.Start) || !hhmmRe.MatchString(v.End) {
			return fmt.Errorf("schedule: day %s times must be HH:MM", k)
		}
		if v.Start >= v.End {
			return fmt.Errorf("schedule: day %s start must be before end", k)
		}
	}
	return nil
}

// activeMember reports whether userID is an active member of the current tenant
// (RLS scopes tenant_members to the request's tenant).
func activeMember(r *http.Request, tx pgx.Tx, userID uuid.UUID) (bool, error) {
	var one int
	err := tx.QueryRow(r.Context(),
		`SELECT 1 FROM tenant_members WHERE user_id = $1 AND status = 'active'`, userID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// blank converts an empty/whitespace string pointer to nil so it persists as
// NULL rather than ”. Used for the optional email + started_on fields.
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
		FullName      string          `json:"full_name"`
		RoleTitle     string          `json:"role_title"`
		Phone         string          `json:"phone"`
		Email         *string         `json:"email"`
		Status        *string         `json:"status"`
		StartedOn     *string         `json:"started_on"`
		EndedOn       *string         `json:"ended_on"`
		SalaryAmount  *float64        `json:"salary_amount"`
		SalaryCadence *string         `json:"salary_cadence"`
		Schedule      json.RawMessage `json:"schedule"`
		UserID        *uuid.UUID      `json:"user_id"`
		Notes         string          `json:"notes"`
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
	cadence := "monthly"
	if body.SalaryCadence != nil {
		cadence = *body.SalaryCadence
	}
	if !validCadence(cadence) {
		writeErr(w, http.StatusBadRequest, "bad_request", "salary_cadence must be monthly, hourly, or per_shift")
		return
	}
	if err := validateSchedule(body.Schedule); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	schedule := body.Schedule
	if len(schedule) == 0 || string(schedule) == "null" {
		schedule = json.RawMessage(`{}`)
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.create", "name", body.FullName)
	tx := appctx.Tx(r.Context())

	if body.UserID != nil {
		ok, err := activeMember(r, tx, *body.UserID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "user_id is not an active team member")
			return
		}
	}

	var newID uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO staff (tenant_id, full_name, role_title, phone, email, status,
		                   started_on, ended_on, salary_amount, salary_cadence, schedule, user_id, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13)
		RETURNING id`,
		t.ID, body.FullName, body.RoleTitle, body.Phone, blankToNil(body.Email),
		status, blankToNil(body.StartedOn), blankToNil(body.EndedOn),
		body.SalaryAmount, cadence, schedule, body.UserID, body.Notes).Scan(&newID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	s, err := scanStaff(tx.QueryRow(r.Context(), staffSelect+`
		WHERE s.id = $1 AND s.deleted_at IS NULL`, newID))
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
		FullName      *string         `json:"full_name"`
		RoleTitle     *string         `json:"role_title"`
		Phone         *string         `json:"phone"`
		Email         *string         `json:"email"`
		Status        *string         `json:"status"`
		StartedOn     *string         `json:"started_on"`
		EndedOn       *string         `json:"ended_on"`
		SalaryAmount  *float64        `json:"salary_amount"`
		SalaryCadence *string         `json:"salary_cadence"`
		Schedule      json.RawMessage `json:"schedule"`
		UserID        *uuid.UUID      `json:"user_id"`
		// ClearUserID lets the client explicitly unlink the team member, since a
		// nil UserID is ambiguous with "unchanged" in a partial update.
		ClearUserID bool    `json:"clear_user_id"`
		Notes       *string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.Status != nil && *body.Status != "active" && *body.Status != "inactive" {
		writeErr(w, http.StatusBadRequest, "bad_request", "status must be active or inactive")
		return
	}
	if body.SalaryCadence != nil && !validCadence(*body.SalaryCadence) {
		writeErr(w, http.StatusBadRequest, "bad_request", "salary_cadence must be monthly, hourly, or per_shift")
		return
	}
	if body.Schedule != nil {
		if err := validateSchedule(body.Schedule); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "staff.update", "id", id)
	tx := appctx.Tx(r.Context())

	// Resolve the optional team-member link. clear_user_id wins; otherwise a
	// provided user_id must be an active member of this tenant.
	var linkUserID *uuid.UUID
	if body.ClearUserID {
		linkUserID = nil
	} else if body.UserID != nil {
		ok, err := activeMember(r, tx, *body.UserID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "user_id is not an active team member")
			return
		}
		linkUserID = body.UserID
	}

	var updatedID uuid.UUID
	err = tx.QueryRow(r.Context(), `
		UPDATE staff SET
			full_name      = COALESCE($2, full_name),
			role_title     = COALESCE($3, role_title),
			phone          = COALESCE($4, phone),
			email          = COALESCE($5, email),
			status         = COALESCE($6, status),
			started_on     = COALESCE($7::date, started_on),
			ended_on       = COALESCE($8::date, ended_on),
			salary_amount  = COALESCE($9, salary_amount),
			salary_cadence = COALESCE($10, salary_cadence),
			schedule       = COALESCE($11, schedule),
			user_id        = CASE WHEN $12 THEN $13::uuid ELSE COALESCE($13::uuid, user_id) END,
			notes          = COALESCE($14, notes)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id`,
		id, body.FullName, body.RoleTitle, body.Phone, blankToNil(body.Email),
		body.Status, blankToNil(body.StartedOn), blankToNil(body.EndedOn),
		body.SalaryAmount, body.SalaryCadence, body.Schedule,
		body.ClearUserID, linkUserID, body.Notes).Scan(&updatedID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	s, err := scanStaff(tx.QueryRow(r.Context(), staffSelect+`
		WHERE s.id = $1 AND s.deleted_at IS NULL`, updatedID))
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
// STAFF PAY LEDGER (0033)
//
// A simple pay-history: each recorded salary payment for a staff member. Gated
// by staff:read (list) / staff:update (record + delete). Soft-deleted to keep
// the trail intact.
// =========================================================================

func ListStaffPay(w http.ResponseWriter, r *http.Request) {
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

	rows, err := tx.Query(r.Context(), `
		SELECT id, staff_id, to_char(paid_on, 'YYYY-MM-DD'), amount, period_label, note, created_at
		FROM staff_pay
		WHERE staff_id = $1 AND deleted_at IS NULL
		ORDER BY paid_on DESC, created_at DESC`, staffID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []StaffPay{}
	for rows.Next() {
		var p StaffPay
		if err := rows.Scan(&p.ID, &p.StaffID, &p.PaidOn, &p.Amount, &p.PeriodLabel, &p.Note, &p.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"pay": out})
}

func CreateStaffPay(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	u, _ := appctx.UserFromContext(r.Context())
	staffID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		PaidOn      string     `json:"paid_on"`
		Amount      float64    `json:"amount"`
		PeriodLabel string     `json:"period_label"`
		Note        string     `json:"note"`
		PaidFrom    string     `json:"paid_from"` // 'bank' | 'drawer' | 'owner_cash'
		OwnerID     *uuid.UUID `json:"owner_id"`  // required when paid_from='owner_cash'
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(body.PaidOn) == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "paid_on required")
		return
	}
	paidOn, err := time.Parse("2006-01-02", strings.TrimSpace(body.PaidOn))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "paid_on must be YYYY-MM-DD")
		return
	}
	if body.Amount <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount must be greater than 0")
		return
	}

	// A salary payment is real spending: it also books an expense (category
	// "Salaries") so payroll shows up in the books and moves the cafe balance
	// via the chosen source, exactly like a manual expense.
	if body.PaidFrom == "" {
		body.PaidFrom = "bank"
	}
	var payMethod string
	switch body.PaidFrom {
	case "bank":
		payMethod = "bank"
		body.OwnerID = nil
	case "drawer":
		payMethod = "cash"
		body.OwnerID = nil
	case "owner_cash":
		payMethod = "cash"
		if body.OwnerID == nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "paid_from='owner_cash' requires owner_id")
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "bad_request", "paid_from must be 'bank', 'drawer', or 'owner_cash'")
		return
	}

	tx := appctx.Tx(r.Context())

	var staffName string
	if err := tx.QueryRow(r.Context(),
		`SELECT full_name FROM staff WHERE id = $1 AND deleted_at IS NULL`, staffID).Scan(&staffName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Resolve (or create) the tenant's "Salaries" expense category so payroll
	// is grouped in the expense reports.
	catID, err := resolveSalariesCategory(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	amountCents := int64(math.Round(body.Amount * 100))
	notes := strings.TrimSpace(body.Note)
	if label := strings.TrimSpace(body.PeriodLabel); label != "" {
		if notes != "" {
			notes = "salary " + label + " — " + notes
		} else {
			notes = "salary " + label
		}
	} else if notes == "" {
		notes = "salary"
	}
	expenseID, err := recordExpense(r.Context(), tx, t.ID, u.ID, expenseParams{
		ExpenseCategoryID: catID,
		Vendor:            staffName,
		AmountCents:       amountCents,
		PaidAt:            &paidOn,
		PaymentMethod:     payMethod,
		Notes:             notes,
		PaidFrom:          body.PaidFrom,
		OwnerID:           body.OwnerID,
	})
	if err != nil {
		var ee *expenseError
		if errors.As(err, &ee) {
			writeErr(w, ee.status, ee.code, ee.msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	var p StaffPay
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO staff_pay (tenant_id, staff_id, paid_on, amount, period_label, note, created_by_user_id, expense_id)
		VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
		RETURNING id, staff_id, to_char(paid_on, 'YYYY-MM-DD'), amount, period_label, note, created_at`,
		t.ID, staffID, body.PaidOn, body.Amount, strings.TrimSpace(body.PeriodLabel), strings.TrimSpace(body.Note), u.ID, expenseID,
	).Scan(&p.ID, &p.StaffID, &p.PaidOn, &p.Amount, &p.PeriodLabel, &p.Note, &p.CreatedAt); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "staff_pay", EntityID: &p.ID,
		Summary: fmt.Sprintf("recorded a %s salary payment for %s", audit.Money(amountCents), audit.Quote(staffName)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

// resolveSalariesCategory returns the id of the tenant's "Salaries" expense
// category, creating it on first use so salary payments always land in a
// consistent bucket.
func resolveSalariesCategory(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (*uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id FROM expense_categories
		WHERE tenant_id = $1 AND lower(name) = 'salaries' AND deleted_at IS NULL
		ORDER BY created_at LIMIT 1`, tenantID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.QueryRow(ctx, `
			INSERT INTO expense_categories (tenant_id, name) VALUES ($1, 'Salaries') RETURNING id`,
			tenantID).Scan(&id); err != nil {
			return nil, err
		}
		return &id, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func DeleteStaffPay(w http.ResponseWriter, r *http.Request) {
	staffID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	payID, err := uuid.Parse(chi.URLParam(r, "payId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid pay id")
		return
	}
	tx := appctx.Tx(r.Context())

	// Soft-delete the pay row and recover its linked expense id (if any) so we
	// can reverse the matching expense + its money side-effects in the same tx.
	var expenseID *uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		UPDATE staff_pay SET deleted_at = now()
		WHERE id = $1 AND staff_id = $2 AND deleted_at IS NULL
		RETURNING expense_id`, payID, staffID).Scan(&expenseID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if expenseID != nil {
		if _, _, err := reverseExpense(r.Context(), tx, *expenseID); err != nil {
			var ee *expenseError
			// A not_found expense (e.g. already deleted) is fine — nothing to reverse.
			if errors.As(err, &ee) {
				if ee.status != http.StatusNotFound {
					writeErr(w, ee.status, ee.code, ee.msg)
					return
				}
			} else {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "staff_pay", EntityID: &payID,
		Summary: fmt.Sprintf("deleted a payment for staff %s", staffID.String()),
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
