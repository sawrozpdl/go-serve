package super

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Payment is one row of a tenant's manual payment history.
type Payment struct {
	ID           uuid.UUID  `json:"id"`
	AmountCents  int64      `json:"amount_cents"`
	Currency     string     `json:"currency"`
	Method       string     `json:"method"`
	PeriodStart  *string    `json:"period_start,omitempty"`
	PeriodEnd    string     `json:"period_end"`
	Note         string     `json:"note"`
	RecordedBy   *uuid.UUID `json:"recorded_by,omitempty"`
	RecordedName *string    `json:"recorded_name,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

var paymentMethods = map[string]bool{"cash": true, "bank": true, "online": true, "other": true}

// parseDateOnly accepts a YYYY-MM-DD date (the format the FE date input emits).
func parseDateOnly(s string) (string, bool) {
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return "", false
	}
	return s, true
}

// RecordPayment — POST /v1/super/tenants/{id}/payments
//
//	body: {amount_cents, currency?, method, period_start?, period_end, note?}.
//
// Appends a payment to the ledger AND advances tenants.paid_through_at to the
// end of period_end (GREATEST, so it never moves backward and a NULL/comped
// tenant becomes tracked). This is how a paid tenant stays "current" without a
// payment integration.
func RecordPayment(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		AmountCents int64  `json:"amount_cents"`
		Currency    string `json:"currency"`
		Method      string `json:"method"`
		PeriodStart string `json:"period_start"`
		PeriodEnd   string `json:"period_end"`
		Note        string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.AmountCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents must be >= 0")
		return
	}
	if !paymentMethods[body.Method] {
		writeErr(w, http.StatusBadRequest, "bad_request", "method must be cash, bank, online or other")
		return
	}
	periodEnd, ok := parseDateOnly(body.PeriodEnd)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_request", "period_end must be a YYYY-MM-DD date")
		return
	}
	var periodStart *string
	if body.PeriodStart != "" {
		ps, ok := parseDateOnly(body.PeriodStart)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "period_start must be a YYYY-MM-DD date")
			return
		}
		periodStart = &ps
	}
	currency := body.Currency
	if currency == "" {
		currency = "NPR"
	}

	actor, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	// The tenant must exist (FK would catch it, but a clean 404 is nicer).
	var exists bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if !exists {
		writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO tenant_payments (tenant_id, amount_cents, currency, method, period_start, period_end, note, recorded_by)
		VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8)
	`, id, body.AmountCents, currency, body.Method, periodStart, periodEnd, body.Note, actor.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Advance paid_through_at to the end of period_end (the day after, so the
	// whole period_end day is covered). GREATEST ignores a NULL paid_through_at,
	// so a comped tenant becomes tracked from this payment.
	if _, err := tx.Exec(r.Context(), `
		UPDATE tenants
		SET paid_through_at = GREATEST(paid_through_at, ($1::date + 1)::timestamptz)
		WHERE id = $2
	`, periodEnd, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.record_payment", TargetTenantID: &id,
		Summary: "recorded payment through " + periodEnd,
		Meta:    map[string]any{"amount_cents": body.AmountCents, "currency": currency, "method": body.Method, "period_end": periodEnd}})
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

// ListPayments — GET /v1/super/tenants/{id}/payments. Newest first.
func ListPayments(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT tp.id, tp.amount_cents, tp.currency, tp.method,
		       to_char(tp.period_start, 'YYYY-MM-DD'), to_char(tp.period_end, 'YYYY-MM-DD'),
		       tp.note, tp.recorded_by, u.name, tp.created_at
		FROM tenant_payments tp
		LEFT JOIN users u ON u.id = tp.recorded_by
		WHERE tp.tenant_id = $1
		ORDER BY tp.created_at DESC
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []Payment{}
	for rows.Next() {
		var p Payment
		if err := rows.Scan(&p.ID, &p.AmountCents, &p.Currency, &p.Method,
			&p.PeriodStart, &p.PeriodEnd, &p.Note, &p.RecordedBy, &p.RecordedName, &p.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"payments": out})
}

// SetSubscription — PATCH /v1/super/tenants/{id}/subscription  body:
// {paid_through_at: "YYYY-MM-DD" | null}.
//
// Direct override of the paid-through date without recording a payment. null
// clears it → the tenant becomes comped / perpetual (never flagged past due).
// Use this to mark a tenant as comped, or to correct the date manually.
func SetSubscription(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		PaidThroughAt *string `json:"paid_through_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	var paidThrough *string // YYYY-MM-DD, or nil to clear (comp)
	summary := "marked subscription comped (perpetual)"
	if body.PaidThroughAt != nil {
		d, ok := parseDateOnly(*body.PaidThroughAt)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "paid_through_at must be a YYYY-MM-DD date or null")
			return
		}
		paidThrough = &d
		summary = "set paid-through to " + d
	}
	tx := appctx.Tx(r.Context())
	ct, err := tx.Exec(r.Context(), `
		UPDATE tenants
		SET paid_through_at = CASE WHEN $1::date IS NULL THEN NULL ELSE ($1::date + 1)::timestamptz END
		WHERE id = $2 AND deleted_at IS NULL
	`, paidThrough, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.set_subscription", TargetTenantID: &id, Summary: summary})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
