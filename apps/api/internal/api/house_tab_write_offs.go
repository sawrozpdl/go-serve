package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Credit write-offs — money the cafe has decided it will not get.
//
// "They're paying 8,000 of the 10,000 and we're letting the rest go" and "we
// never got the 3,500 on that account" are the same event recorded at two
// moments, so they are one row shape with two entry points in the UI. See
// migration 0082 for why this shares house_tab_settlements rather than getting
// its own table, and why its payment_method is NULL.

// houseTabBalance is the one definition of what a tab still owes: everything
// charged to it, less every live settlement of EITHER kind. A write-off reduces
// the balance exactly as a payment does — that is the point of it — and the two
// are only told apart when reporting what arrived.
func houseTabBalance(ctx context.Context, tx pgx.Tx, id uuid.UUID) (int64, error) {
	var balance int64
	err := tx.QueryRow(ctx, `
		SELECT
		  COALESCE((SELECT SUM(amount_cents) FROM payments
		            WHERE house_tab_id = $1 AND method = 'house_tab'), 0)
		  - COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
		              WHERE house_tab_id = $1 AND reversed_at IS NULL), 0)
	`, id).Scan(&balance)
	return balance, err
}

// CreateHouseTabWriteOff forgives part or all of an outstanding balance.
//
// It reduces the balance exactly as a collection does and is undone through the
// same reversal path, but it is never reported as collected and never touches
// an account bucket — no money moved, so no account changed.
func CreateHouseTabWriteOff(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		AmountCents int64  `json:"amount_cents"`
		Reason      string `json:"reason"`
		Notes       string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	// Everything is validated before the INSERT: a 4xx still COMMITS here, so a
	// rejection after the write would leave the forgiven money forgiven anyway.
	if body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents > 0 required")
		return
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" {
		writeErr(w, http.StatusBadRequest, "reason_required",
			"say why this money is being written off — it stays on the ledger")
		return
	}

	tx := appctx.Tx(r.Context())

	// Lock the tab. Same race as a settlement: without it two requests both
	// read the same outstanding balance, both pass the guard below, and the tab
	// goes negative.
	var exists int
	if err := tx.QueryRow(r.Context(),
		`SELECT 1 FROM house_tabs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id,
	).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	balance, err := houseTabBalance(r.Context(), tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if body.AmountCents > balance {
		writeErr(w, http.StatusConflict, "exceeds_balance",
			"can't write off more than the "+formatPaisa(balance)+" outstanding")
		return
	}

	var s HouseTabSettlement
	err = tx.QueryRow(r.Context(), `
		INSERT INTO house_tab_settlements
		  (tenant_id, house_tab_id, amount_cents, kind, payment_method, write_off_reason,
		   notes, recorded_by_user_id, shift_id)
		VALUES ($1, $2, $3, 'write_off', NULL, $4, $5, $6, NULL)
		RETURNING id, kind, amount_cents, payment_method::text, write_off_reason,
		          reference_no, notes, recorded_at
	`, t.ID, id, body.AmountCents, body.Reason, body.Notes, user.ID).Scan(
		&s.ID, &s.Kind, &s.AmountCents, &s.PaymentMethod, &s.WriteOffReason,
		&s.ReferenceNo, &s.Notes, &s.RecordedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "write_off", Entity: "house_tab", EntityID: &id,
		Summary: fmt.Sprintf("wrote off %s of credit — %s",
			audit.Money(body.AmountCents), body.Reason),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, s)
}
