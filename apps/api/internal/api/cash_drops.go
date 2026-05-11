package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// CASH_DROPS  (per-shift drawer ledger)
//
// Wire-level shape for cash that physically left or entered the till during
// a shift. The close-shift math reads this table to reconcile.
// =========================================================================

type CashDrop struct {
	ID                  uuid.UUID  `json:"id"`
	ShiftID             uuid.UUID  `json:"shift_id"`
	Direction           string     `json:"direction"`
	Kind                string     `json:"kind"`
	AmountCents         int64      `json:"amount_cents"`
	Reason              string     `json:"reason"`
	Notes               string     `json:"notes"`
	ExpenseID           *uuid.UUID `json:"expense_id,omitempty"`
	ExpenseVendor       *string    `json:"expense_vendor,omitempty"`
	RecordedByUserID    uuid.UUID  `json:"recorded_by_user_id"`
	RecordedByEmail     *string    `json:"recorded_by_email,omitempty"`
	RecordedAt          time.Time  `json:"recorded_at"`
}

// validCashDropKinds — keep aligned with the cash_drop_kind enum.
var validCashDropKinds = map[string]bool{
	"owner_draw":   true,
	"bank_deposit": true,
	"transfer":     true, // reserved for /v1/transfers; manual posts of this kind are blocked.
	"paid_out":     true,
	"paid_in":      true,
	"petty_change": true,
	"correction":   true,
	"other":        true,
}

// directionForKind returns the canonical direction for a kind. Some kinds
// (correction) accept either; for those we trust the body.
func directionForKind(kind string) (string, bool) {
	switch kind {
	case "owner_draw", "bank_deposit", "paid_out":
		return "out", true
	case "paid_in", "petty_change":
		return "in", true
	default:
		return "", false
	}
}

// =========================================================================
// GET /v1/shifts/{id}/cash-drops
// =========================================================================

func ListCashDrops(w http.ResponseWriter, r *http.Request) {
	shiftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid shift id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "cash_drops.list", "shift_id", shiftID)
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT cd.id, cd.shift_id, cd.direction::text, cd.kind::text, cd.amount_cents,
		       cd.reason, cd.notes, cd.expense_id, e.vendor,
		       cd.recorded_by_user_id, u.email::text, cd.recorded_at
		FROM cash_drops cd
		LEFT JOIN expenses e ON e.id = cd.expense_id
		LEFT JOIN users u    ON u.id = cd.recorded_by_user_id
		WHERE cd.shift_id = $1
		ORDER BY cd.recorded_at DESC
	`, shiftID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []CashDrop{}
	for rows.Next() {
		var d CashDrop
		if err := rows.Scan(&d.ID, &d.ShiftID, &d.Direction, &d.Kind, &d.AmountCents,
			&d.Reason, &d.Notes, &d.ExpenseID, &d.ExpenseVendor,
			&d.RecordedByUserID, &d.RecordedByEmail, &d.RecordedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"cash_drops": out})
}

// =========================================================================
// POST /v1/shifts/{id}/cash-drops
//
// Body: { kind, amount_cents, reason?, notes?, direction? }
// direction is inferred from kind when ambiguous it must be supplied
// (only 'correction' allows either direction). 'transfer' and 'expense'
// kinds are reserved for /v1/transfers and the expense flow respectively
// — this endpoint refuses them so the linkage rows can't be orphaned.
// =========================================================================

func CreateCashDrop(w http.ResponseWriter, r *http.Request) {
	shiftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid shift id")
		return
	}
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		Direction   string `json:"direction"`
		Kind        string `json:"kind"`
		AmountCents int64  `json:"amount_cents"`
		Reason      string `json:"reason"`
		Notes       string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents must be > 0")
		return
	}
	if !validCashDropKinds[body.Kind] {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"kind must be one of: owner_draw, bank_deposit, paid_out, paid_in, petty_change, correction, other")
		return
	}
	if body.Kind == "transfer" {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"transfers must be created via /v1/transfers")
		return
	}

	if dir, ok := directionForKind(body.Kind); ok {
		body.Direction = dir
	}
	if body.Direction != "out" && body.Direction != "in" {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"direction must be 'in' or 'out'")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "cash_drops.create",
		"shift_id", shiftID,
		"kind", body.Kind,
		"direction", body.Direction,
		"amount_cents", body.AmountCents)

	tx := appctx.Tx(r.Context())

	// Refuse cash drops on a closed shift — the variance is already stamped.
	var closedAt *time.Time
	if err := tx.QueryRow(r.Context(),
		`SELECT closed_at FROM shifts WHERE id = $1`, shiftID,
	).Scan(&closedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "shift not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if closedAt != nil {
		writeErr(w, http.StatusConflict, "shift_closed",
			"can't post a cash drop on a closed shift")
		return
	}

	var d CashDrop
	err = tx.QueryRow(r.Context(), `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, notes, recorded_by_user_id)
		VALUES ($1, $2, $3::cash_drop_direction, $4::cash_drop_kind, $5, $6, $7, $8)
		RETURNING id, shift_id, direction::text, kind::text, amount_cents,
		          reason, notes, expense_id, recorded_by_user_id, recorded_at
	`, t.ID, shiftID, body.Direction, body.Kind, body.AmountCents,
		body.Reason, body.Notes, user.ID).Scan(
		&d.ID, &d.ShiftID, &d.Direction, &d.Kind, &d.AmountCents,
		&d.Reason, &d.Notes, &d.ExpenseID, &d.RecordedByUserID, &d.RecordedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	verb := "added"
	if d.Direction == "out" {
		verb = "removed"
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "cash_drop", EntityID: &d.ID,
		Summary: fmt.Sprintf("%s %s to drawer (%s)",
			verb, audit.Money(d.AmountCents), d.Kind),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

// =========================================================================
// DELETE /v1/shifts/{id}/cash-drops/{dropId}
//
// Refuses on a closed shift. Refuses on rows with expense_id (delete the
// expense itself) or on transfer-linked rows (delete the transfer).
// =========================================================================

func DeleteCashDrop(w http.ResponseWriter, r *http.Request) {
	shiftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid shift id")
		return
	}
	dropID, err := uuid.Parse(chi.URLParam(r, "dropId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid drop id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "cash_drops.delete", "shift_id", shiftID, "drop_id", dropID)
	tx := appctx.Tx(r.Context())

	var closedAt *time.Time
	var kind, direction string
	var expenseID *uuid.UUID
	var amountCents int64
	if err := tx.QueryRow(r.Context(), `
		SELECT s.closed_at, cd.kind::text, cd.expense_id, cd.direction::text, cd.amount_cents
		FROM cash_drops cd
		JOIN shifts s ON s.id = cd.shift_id
		WHERE cd.id = $1 AND cd.shift_id = $2
	`, dropID, shiftID).Scan(&closedAt, &kind, &expenseID, &direction, &amountCents); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if closedAt != nil {
		writeErr(w, http.StatusConflict, "shift_closed",
			"can't remove a cash drop from a closed shift")
		return
	}
	if expenseID != nil {
		writeErr(w, http.StatusConflict, "expense_linked",
			"this drop is linked to an expense — delete the expense to remove it")
		return
	}
	if kind == "transfer" {
		writeErr(w, http.StatusConflict, "transfer_linked",
			"this drop is part of an account transfer — delete the transfer to remove it")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM cash_drops WHERE id = $1`, dropID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "cash_drop", EntityID: &dropID,
		Summary: fmt.Sprintf("deleted %s drawer drop (%s, %s)",
			direction, audit.Money(amountCents), kind),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
