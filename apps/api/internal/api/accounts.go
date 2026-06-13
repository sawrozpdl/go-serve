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
// ACCOUNTS  (per-account balance view + inter-account transfers)
//
// We surface three accounts to the operator: the cash drawer, the
// consolidated "Online" pool (every digital channel — eSewa / Khalti /
// card / other / online), and the bank. Balance per account is computed
// live:
//
//   payments(method ∈ account)        ← inflow (orders settled)
//   + house_tab_settlements(...)       ← inflow (tab paid down into account)
//   − expenses(payment_method ∈ ...)  ← outflow (operating costs)
//   + transfers(to_method ∈ ...)      ← incoming transfers
//   − transfers(from_method ∈ ...)    ← outgoing transfers (− fee on out)
//
// A house-tab CHARGE (method='house_tab') is intentionally excluded — it's a
// receivable, not cash in hand. The money only enters an account once the tab
// is SETTLED, at which point the settlement counts as an inflow above.
// Historical rows still carry the original enum value (esewa, khalti, etc.);
// the consolidation happens in the roll-up below.
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

// accountBucket — display row + the underlying enum values it sums over.
// A bucket can absorb multiple historical method values (the "online"
// bucket folds in esewa/khalti/card/other rows).
type accountBucket struct {
	Method  string   // canonical key shown in the UI / used for transfers
	Label   string   // display label
	Members []string // raw payment_method values this bucket rolls up
}

var methodsForBalances = []accountBucket{
	{"cash", "Cash drawer", []string{"cash"}},
	{"online", "Online", []string{"online", "esewa", "khalti", "card", "other"}},
	{"bank", "Bank", []string{"bank"}},
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

		// ANY(text[]) lets a single roll-up bucket absorb several historical
		// enum values without spawning a per-member query.
		if err := tx.QueryRow(r.Context(), `
			SELECT
			  -- order payments + house-tab settlements paid into this account.
			  -- A tab settled in cash/online lands in that account just like a
			  -- direct sale, so it's an inflow here (the tab CHARGE stays out —
			  -- it's a receivable until settled).
			  (COALESCE((SELECT SUM(amount_cents) FROM payments
			            WHERE method::text = ANY($1)), 0)
			   + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
			            WHERE payment_method::text = ANY($1)), 0))::bigint,
			  -- owner_cash expenses are paid from cash an owner is holding, not
			  -- from this account's pool — exclude them so they don't double-count
			  -- against the cash drawer (the owner-cash holding absorbs them).
			  COALESCE((SELECT SUM(amount_cents) FROM expenses
			            WHERE payment_method::text = ANY($1) AND deleted_at IS NULL
			              AND paid_from <> 'owner_cash'), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM account_transfers
			            WHERE to_method::text   = ANY($1)), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers
			            WHERE from_method::text = ANY($1)), 0)::bigint
		`, m.Members).Scan(&b.PaymentsCents, &b.ExpensesCents,
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
	ID               uuid.UUID  `json:"id"`
	FromMethod       string     `json:"from_method"`
	ToMethod         string     `json:"to_method"`
	AmountCents      int64      `json:"amount_cents"`
	FeeCents         int64      `json:"fee_cents"`
	ReferenceNo      string     `json:"reference_no"`
	Notes            string     `json:"notes"`
	TransferredAt    time.Time  `json:"transferred_at"`
	ShiftID          *uuid.UUID `json:"shift_id,omitempty"`
	CashDropID       *uuid.UUID `json:"cash_drop_id,omitempty"`
	RecordedByUserID uuid.UUID  `json:"recorded_by_user_id"`
	RecordedByEmail  *string    `json:"recorded_by_email,omitempty"`
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
	// Only the three operator-visible accounts are valid endpoints.
	// Historical enum values (esewa, khalti, card, other) live on past
	// rows but new transfers must land in the canonical online bucket.
	allowed := map[string]bool{"cash": true, "online": true, "bank": true}
	if !allowed[body.FromMethod] || !allowed[body.ToMethod] {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"from_method and to_method must be one of cash, online, bank")
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
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "transfer", EntityID: &out.ID,
		Summary: fmt.Sprintf("transferred %s from %s to %s",
			audit.Money(out.AmountCents), out.FromMethod, out.ToMethod),
	}); err != nil {
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
	var fromMethod, toMethod string
	var amountCents int64
	if err := tx.QueryRow(r.Context(), `
		SELECT t.cash_drop_id, s.closed_at,
		       t.from_method::text, t.to_method::text, t.amount_cents
		FROM account_transfers t
		LEFT JOIN shifts s ON s.id = t.shift_id
		WHERE t.id = $1
	`, id).Scan(&cashDropID, &shiftClosed, &fromMethod, &toMethod, &amountCents); err != nil {
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
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "transfer", EntityID: &id,
		Summary: fmt.Sprintf("deleted transfer %s from %s to %s",
			audit.Money(amountCents), fromMethod, toMethod),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
