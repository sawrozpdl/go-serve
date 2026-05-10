package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// ACCOUNTS  (per-payment-method balance view + inter-account transfers)
//
// "Accounts" = the payment_method enum values (cash, esewa, khalti, card,
// other, bank). Balance per account is computed live:
//
//   payments(method=X)              ← inflow (orders settled)
//   − expenses(payment_method=X)    ← outflow (operating costs)
//   + transfers(to_method=X)        ← incoming transfers
//   − transfers(from_method=X)      ← outgoing transfers (− fee on outgoing)
//
// Cash gets special treatment: while a shift is open it represents the
// drawer + everything banked since then. Closed shifts moved out of the
// drawer when the user banked / transferred them.
// =========================================================================

// AccountBalance is the wire-level balance row.
type AccountBalance struct {
	Method            string `json:"method"`
	Label             string `json:"label"`
	BalanceCents      int64  `json:"balance_cents"`
	PaymentsCents     int64  `json:"payments_cents"`
	ExpensesCents     int64  `json:"expenses_cents"`
	TransfersInCents  int64  `json:"transfers_in_cents"`
	TransfersOutCents int64  `json:"transfers_out_cents"`
}

// methodsForBalances — every method we surface, in display order.
// 'house_tab' is excluded: it's a receivable, not a cash account.
var methodsForBalances = []struct {
	Method string
	Label  string
}{
	{"cash", "Cash drawer"},
	{"esewa", "eSewa"},
	{"khalti", "Khalti"},
	{"card", "Card / POS"},
	{"bank", "Bank"},
	{"other", "Other"},
}

// =========================================================================
// GET /v1/accounts/balances
// =========================================================================

func GetAccountBalances(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "accounts.list_balances")
	tx := appctx.Tx(r.Context())

	out := make([]AccountBalance, 0, len(methodsForBalances))
	for _, m := range methodsForBalances {
		var b AccountBalance
		b.Method = m.Method
		b.Label = m.Label

		// payments are by enum (method), expenses by free-text payment_method.
		// transfers use the same enum on both sides.
		if err := tx.QueryRow(r.Context(), `
			SELECT
			  COALESCE((SELECT SUM(amount_cents) FROM payments
			            WHERE method::text = $1), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM expenses
			            WHERE payment_method = $1 AND deleted_at IS NULL), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM account_transfers
			            WHERE to_method::text   = $1), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers
			            WHERE from_method::text = $1), 0)::bigint
		`, m.Method).Scan(&b.PaymentsCents, &b.ExpensesCents,
			&b.TransfersInCents, &b.TransfersOutCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		b.BalanceCents = b.PaymentsCents - b.ExpensesCents +
			b.TransfersInCents - b.TransfersOutCents
		out = append(out, b)
	}

	writeJSON(w, http.StatusOK, map[string]any{"accounts": out})
}

// =========================================================================
// AccountTransfer wire type
// =========================================================================

type AccountTransfer struct {
	ID                  uuid.UUID  `json:"id"`
	FromMethod          string     `json:"from_method"`
	ToMethod            string     `json:"to_method"`
	AmountCents         int64      `json:"amount_cents"`
	FeeCents            int64      `json:"fee_cents"`
	ReferenceNo         string     `json:"reference_no"`
	Notes               string     `json:"notes"`
	TransferredAt       time.Time  `json:"transferred_at"`
	ShiftID             *uuid.UUID `json:"shift_id,omitempty"`
	CashDropID          *uuid.UUID `json:"cash_drop_id,omitempty"`
	RecordedByUserID    uuid.UUID  `json:"recorded_by_user_id"`
	RecordedByEmail     *string    `json:"recorded_by_email,omitempty"`
}

// =========================================================================
// GET /v1/transfers
// =========================================================================

func ListTransfers(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "accounts.list_transfers")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT t.id, t.from_method::text, t.to_method::text, t.amount_cents, t.fee_cents,
		       t.reference_no, t.notes, t.transferred_at, t.shift_id, t.cash_drop_id,
		       t.recorded_by_user_id, u.email::text
		FROM account_transfers t
		LEFT JOIN users u ON u.id = t.recorded_by_user_id
		ORDER BY t.transferred_at DESC
		LIMIT 200
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []AccountTransfer{}
	for rows.Next() {
		var t AccountTransfer
		if err := rows.Scan(&t.ID, &t.FromMethod, &t.ToMethod, &t.AmountCents, &t.FeeCents,
			&t.ReferenceNo, &t.Notes, &t.TransferredAt, &t.ShiftID, &t.CashDropID,
			&t.RecordedByUserID, &t.RecordedByEmail); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"transfers": out})
}

// =========================================================================
// POST /v1/transfers
//
// Body: { from_method, to_method, amount_cents, fee_cents?, reference_no?,
//         notes?, transferred_at? }
//
// When from_method='cash' or to_method='cash', a paired cash_drops row is
// auto-created in the same tx and the linkage stamped on the transfer
// (cash_drop_id). Refused if cash side has no open shift.
// =========================================================================

func CreateTransfer(w http.ResponseWriter, r *http.Request) {
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		FromMethod    string     `json:"from_method"`
		ToMethod      string     `json:"to_method"`
		AmountCents   int64      `json:"amount_cents"`
		FeeCents      int64      `json:"fee_cents"`
		ReferenceNo   string     `json:"reference_no"`
		Notes         string     `json:"notes"`
		TransferredAt *time.Time `json:"transferred_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents must be > 0")
		return
	}
	if body.FeeCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "fee_cents must be >= 0")
		return
	}
	if body.FromMethod == "" || body.ToMethod == "" {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"from_method and to_method are required")
		return
	}
	if body.FromMethod == body.ToMethod {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"from_method and to_method must differ")
		return
	}
	if body.FromMethod == "house_tab" || body.ToMethod == "house_tab" {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"house_tab is not a transferable account")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "accounts.create_transfer",
		"from_method", body.FromMethod,
		"to_method", body.ToMethod,
		"amount_cents", body.AmountCents,
		"fee_cents", body.FeeCents)

	tx := appctx.Tx(r.Context())

	// Resolve the cash side's shift (if either side is cash).
	var shiftPtr *uuid.UUID
	cashSide := body.FromMethod == "cash" || body.ToMethod == "cash"
	if cashSide {
		shiftID, err := findOpenShiftID(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if shiftID == uuid.Nil {
			writeErr(w, http.StatusConflict, "shift_required",
				"cash transfers require an open shift — open one in the Shift screen")
			return
		}
		shiftPtr = &shiftID
	}

	// 1. If cash is involved, write the paired cash_drop row first so we
	//    can stamp its id on the transfer record.
	var cashDropPtr *uuid.UUID
	if cashSide {
		direction := "out"
		if body.ToMethod == "cash" {
			direction = "in"
		}
		// Reason: human-friendly label e.g. "transfer → eSewa".
		reason := "transfer "
		if direction == "out" {
			reason += "→ " + body.ToMethod
		} else {
			reason += "← " + body.FromMethod
		}
		var dropID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO cash_drops
			  (tenant_id, shift_id, direction, kind, amount_cents,
			   reason, notes, recorded_by_user_id)
			VALUES ($1, $2, $3::cash_drop_direction, 'transfer'::cash_drop_kind,
			        $4, $5, $6, $7)
			RETURNING id
		`, t.ID, *shiftPtr, direction, body.AmountCents,
			reason, body.Notes, user.ID).Scan(&dropID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to record drawer movement: "+err.Error())
			return
		}
		cashDropPtr = &dropID
	}

	// 2. Insert the transfer with the linkage.
	var out AccountTransfer
	err := tx.QueryRow(r.Context(), `
		INSERT INTO account_transfers
		  (tenant_id, from_method, to_method, amount_cents, fee_cents,
		   reference_no, notes, transferred_at, shift_id, cash_drop_id,
		   recorded_by_user_id)
		VALUES ($1, $2::payment_method, $3::payment_method, $4, $5,
		        $6, $7, COALESCE($8, now()), $9, $10, $11)
		RETURNING id, from_method::text, to_method::text, amount_cents, fee_cents,
		          reference_no, notes, transferred_at, shift_id, cash_drop_id,
		          recorded_by_user_id
	`, t.ID, body.FromMethod, body.ToMethod, body.AmountCents, body.FeeCents,
		body.ReferenceNo, body.Notes, body.TransferredAt, shiftPtr, cashDropPtr, user.ID,
	).Scan(&out.ID, &out.FromMethod, &out.ToMethod, &out.AmountCents, &out.FeeCents,
		&out.ReferenceNo, &out.Notes, &out.TransferredAt, &out.ShiftID, &out.CashDropID,
		&out.RecordedByUserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// =========================================================================
// DELETE /v1/transfers/{id}
//
// Removes the transfer + its paired cash_drop. Refused if the cash side's
// shift is closed (variance was already stamped).
// =========================================================================

func DeleteTransfer(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "accounts.delete_transfer", "id", id)
	tx := appctx.Tx(r.Context())

	var cashDropID *uuid.UUID
	var shiftClosed *time.Time
	if err := tx.QueryRow(r.Context(), `
		SELECT t.cash_drop_id, s.closed_at
		FROM account_transfers t
		LEFT JOIN shifts s ON s.id = t.shift_id
		WHERE t.id = $1
	`, id).Scan(&cashDropID, &shiftClosed); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if shiftClosed != nil {
		writeErr(w, http.StatusConflict, "shift_closed",
			"this transfer's drawer side has been closed — record a corrective transfer instead")
		return
	}

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM account_transfers WHERE id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cashDropID != nil {
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM cash_drops WHERE id = $1`, *cashDropID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
