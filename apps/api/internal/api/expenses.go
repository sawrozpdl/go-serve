package api

import (
	"context"
	"encoding/json"
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
)

// =========================================================================
// Wire types
// =========================================================================

type ExpenseCategory struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Color    *string   `json:"color,omitempty"`
	Icon     string    `json:"icon"`
	IsActive bool      `json:"is_active"`
}

type Expense struct {
	ID                    uuid.UUID  `json:"id"`
	ExpenseCategoryID     *uuid.UUID `json:"expense_category_id,omitempty"`
	ExpenseCategoryName   *string    `json:"expense_category_name,omitempty"`
	Vendor                string     `json:"vendor"`
	AmountCents           int64      `json:"amount_cents"`
	PaidAt                time.Time  `json:"paid_at"`
	PaymentMethod         string     `json:"payment_method"`
	ReferenceNo           string     `json:"reference_no"`
	ReceiptURL            *string    `json:"receipt_url,omitempty"`
	Notes                 string     `json:"notes"`
	LinkedInventoryItemID *uuid.UUID `json:"linked_inventory_item_id,omitempty"`
	LinkedInventoryName   *string    `json:"linked_inventory_name,omitempty"`
	RecordedByUserID      uuid.UUID  `json:"recorded_by_user_id"`
	CreatedAt             time.Time  `json:"created_at"`
	// Where the money came from (0014). 'drawer' debits the till during ShiftID;
	// 'bank' debits the cafe bank balance; 'owner' creates a loan from OwnerID
	// (the cafe will repay them later from bank).
	PaidFrom  string     `json:"paid_from"`
	OwnerID   *uuid.UUID `json:"owner_id,omitempty"`
	OwnerName *string    `json:"owner_name,omitempty"`
	// Back-compat: generated column from paid_from='drawer'.
	PaidFromDrawer bool                `json:"paid_from_drawer"`
	ShiftID        *uuid.UUID          `json:"shift_id,omitempty"`
	Allocations    []ExpenseAllocation `json:"allocations,omitempty"`
}

type ExpenseAllocation struct {
	ID               uuid.UUID `json:"id"`
	ExpenseID        uuid.UUID `json:"expense_id"`
	MenuCategoryID   uuid.UUID `json:"menu_category_id"`
	MenuCategoryName *string   `json:"menu_category_name,omitempty"`
	SharePct         string    `json:"share_pct"`
	AmountCents      int64     `json:"amount_cents"`
}

// =========================================================================
// EXPENSE CATEGORIES
// =========================================================================

func ListExpenseCategories(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.list_categories")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, color, icon, is_active
		FROM expense_categories
		WHERE deleted_at IS NULL
		ORDER BY lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []ExpenseCategory{}
	for rows.Next() {
		var c ExpenseCategory
		if err := rows.Scan(&c.ID, &c.Name, &c.Color, &c.Icon, &c.IsActive); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": out})
}

func CreateExpenseCategory(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	var body struct {
		Name  string  `json:"name"`
		Color *string `json:"color"`
		Icon  *string `json:"icon"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.create_category", "name", body.Name)
	tx := appctx.Tx(r.Context())
	var c ExpenseCategory
	c.IsActive = true
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO expense_categories (tenant_id, name, color, icon)
		VALUES ($1, $2, $3, COALESCE($4, ''))
		RETURNING id, name, color, icon, is_active
	`, t.ID, body.Name, body.Color, body.Icon).Scan(&c.ID, &c.Name, &c.Color, &c.Icon, &c.IsActive); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "expense_category", EntityID: &c.ID,
		Summary: fmt.Sprintf("created expense category %s", audit.Quote(c.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func UpdateExpenseCategory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Name     *string `json:"name"`
		Color    *string `json:"color"`
		Icon     *string `json:"icon"`
		IsActive *bool   `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.update_category", "id", id)
	tx := appctx.Tx(r.Context())
	var c ExpenseCategory
	err = tx.QueryRow(r.Context(), `
		UPDATE expense_categories
		SET name      = COALESCE($2, name),
		    color     = COALESCE($3, color),
		    icon      = COALESCE($4, icon),
		    is_active = COALESCE($5, is_active)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, color, icon, is_active
	`, id, body.Name, body.Color, body.Icon, body.IsActive).Scan(&c.ID, &c.Name, &c.Color, &c.Icon, &c.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "expense_category", EntityID: &c.ID,
		Summary: fmt.Sprintf("updated expense category %s", audit.Quote(c.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func DeleteExpenseCategory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.delete_category", "id", id)
	tx := appctx.Tx(r.Context())
	var name string
	if err := tx.QueryRow(r.Context(),
		`UPDATE expense_categories SET deleted_at = now()
		 WHERE id = $1 AND deleted_at IS NULL RETURNING name`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "expense_category", EntityID: &id,
		Summary: fmt.Sprintf("deleted expense category %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// EXPENSES
// =========================================================================

func ListExpenses(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.list",
		"from", r.URL.Query().Get("from"),
		"to", r.URL.Query().Get("to"),
		"expense_category_id", r.URL.Query().Get("expense_category_id"))
	tx := appctx.Tx(r.Context())

	args := []any{}
	q := `
		SELECT e.id, e.expense_category_id, ec.name AS category_name,
		       e.vendor, e.amount_cents, e.paid_at, e.payment_method::text, e.reference_no,
		       e.receipt_url, e.notes, e.linked_inventory_item_id, ii.name,
		       e.recorded_by_user_id, e.created_at,
		       e.paid_from::text, e.owner_id, co.display_name,
		       e.paid_from_drawer, e.shift_id
		FROM expenses e
		LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
		LEFT JOIN inventory_items ii ON ii.id = e.linked_inventory_item_id
		LEFT JOIN cafe_owners co ON co.id = e.owner_id
		WHERE e.deleted_at IS NULL
	`
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	cat := r.URL.Query().Get("expense_category_id")
	search := r.URL.Query().Get("q")
	paidFrom := r.URL.Query().Get("paid_from")
	if from != "" {
		args = append(args, from)
		q += " AND e.paid_at >= $" + strconv.Itoa(len(args))
	}
	if to != "" {
		args = append(args, to)
		q += " AND e.paid_at <= $" + strconv.Itoa(len(args))
	}
	if cat != "" {
		args = append(args, cat)
		q += " AND e.expense_category_id = $" + strconv.Itoa(len(args))
	}
	if search != "" {
		args = append(args, "%"+search+"%")
		n := strconv.Itoa(len(args))
		q += " AND (e.vendor ILIKE $" + n + " OR e.notes ILIKE $" + n +
			" OR e.reference_no ILIKE $" + n + ")"
	}
	if paidFrom != "" {
		switch paidFrom {
		case "drawer", "bank", "owner", "owner_cash":
			args = append(args, paidFrom)
			q += " AND e.paid_from = $" + strconv.Itoa(len(args)) + "::expense_source"
		default:
			writeErr(w, http.StatusBadRequest, "bad_request",
				"paid_from must be 'drawer', 'bank', 'owner', or 'owner_cash'")
			return
		}
	}
	q += " ORDER BY e.paid_at DESC LIMIT 200"

	rows, err := tx.Query(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []Expense{}
	for rows.Next() {
		var e Expense
		if err := rows.Scan(&e.ID, &e.ExpenseCategoryID, &e.ExpenseCategoryName,
			&e.Vendor, &e.AmountCents, &e.PaidAt, &e.PaymentMethod, &e.ReferenceNo,
			&e.ReceiptURL, &e.Notes, &e.LinkedInventoryItemID, &e.LinkedInventoryName,
			&e.RecordedByUserID, &e.CreatedAt,
			&e.PaidFrom, &e.OwnerID, &e.OwnerName,
			&e.PaidFromDrawer, &e.ShiftID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"expenses": out})
}

func GetExpense(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.get", "id", id)
	tx := appctx.Tx(r.Context())

	var e Expense
	err = tx.QueryRow(r.Context(), `
		SELECT e.id, e.expense_category_id, ec.name,
		       e.vendor, e.amount_cents, e.paid_at, e.payment_method::text, e.reference_no,
		       e.receipt_url, e.notes, e.linked_inventory_item_id, ii.name,
		       e.recorded_by_user_id, e.created_at,
		       e.paid_from::text, e.owner_id, co.display_name,
		       e.paid_from_drawer, e.shift_id
		FROM expenses e
		LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
		LEFT JOIN inventory_items ii ON ii.id = e.linked_inventory_item_id
		LEFT JOIN cafe_owners co ON co.id = e.owner_id
		WHERE e.id = $1 AND e.deleted_at IS NULL
	`, id).Scan(&e.ID, &e.ExpenseCategoryID, &e.ExpenseCategoryName,
		&e.Vendor, &e.AmountCents, &e.PaidAt, &e.PaymentMethod, &e.ReferenceNo,
		&e.ReceiptURL, &e.Notes, &e.LinkedInventoryItemID, &e.LinkedInventoryName,
		&e.RecordedByUserID, &e.CreatedAt,
		&e.PaidFrom, &e.OwnerID, &e.OwnerName,
		&e.PaidFromDrawer, &e.ShiftID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	rows, err := tx.Query(r.Context(), `
		SELECT a.id, a.expense_id, a.menu_category_id, mc.name, a.share_pct::text, a.amount_cents
		FROM expense_allocations a
		JOIN menu_categories mc ON mc.id = a.menu_category_id
		WHERE a.expense_id = $1
		ORDER BY a.share_pct DESC
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	e.Allocations = []ExpenseAllocation{}
	for rows.Next() {
		var a ExpenseAllocation
		if err := rows.Scan(&a.ID, &a.ExpenseID, &a.MenuCategoryID, &a.MenuCategoryName,
			&a.SharePct, &a.AmountCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		e.Allocations = append(e.Allocations, a)
	}
	writeJSON(w, http.StatusOK, e)
}

// CreateExpense atomically inserts:
//   - the expense row (with paid_from = drawer | bank | owner)
//   - drawer: a cash_drops row (kind='expense', linked to the expense)
//   - owner: an owner_ledger row (kind='loan_advance') so the cafe's debt
//     to the owner is tracked
//   - if linked_inventory_item_id + delta_units provided: a stock_movements
//     row (reason=purchase, ref=expense.id, unit_cost = amount/delta)
//   - any allocations (denormalized amount_cents = round(amount × share/100))
//
// `paid_from_drawer` (the legacy bool) is accepted for back-compat: when
// set without an explicit paid_from, it's interpreted as paid_from='drawer'.
// expenseError is a domain failure inside the expense create/reverse core that
// maps to a specific HTTP status + code (shift_required, insufficient_holding,
// shift_closed, loan_repaid, not_found, …). The callers unwrap it with
// errors.As and forward it to writeErr; any other error is a 500.
type expenseError struct {
	status int
	code   string
	msg    string
}

func (e *expenseError) Error() string { return e.msg }

// expenseParams is the already-validated, source-normalised input to
// recordExpense. Callers own their own input validation (paid_from spelling,
// owner_id combos, back-compat flags); this core assumes PaidFrom is one of
// drawer|bank|owner|owner_cash, PaymentMethod is set, and OwnerID is present
// for the owner/owner_cash sources.
type expenseParams struct {
	ExpenseCategoryID     *uuid.UUID
	Vendor                string
	AmountCents           int64
	PaidAt                *time.Time
	PaymentMethod         string
	ReferenceNo           string
	ReceiptURL            *string
	Notes                 string
	LinkedInventoryItemID *uuid.UUID
	PaidFrom              string
	OwnerID               *uuid.UUID
}

// recordExpense is the shared money core behind an expense: it resolves the
// open shift (drawer), locks the owner + enforces the custody holding
// (owner/owner_cash), inserts the expenses row, and emits the source-specific
// side-effect (cash_drops / owner_ledger loan_advance / owner_cash_entries
// draw-down). It does NOT handle inventory movements, allocations, or the
// create audit line — those stay with each caller. Used by CreateExpense and
// CreateStaffPay so payroll and manual spending move the cafe balance
// identically.
func recordExpense(ctx context.Context, tx pgx.Tx, tenantID, userID uuid.UUID, p expenseParams) (uuid.UUID, error) {
	// 0. Drawer flow needs an open shift.
	var shiftPtr *uuid.UUID
	if p.PaidFrom == "drawer" {
		shiftID, err := findOpenShiftID(ctx)
		if err != nil {
			return uuid.Nil, err
		}
		if shiftID == uuid.Nil {
			return uuid.Nil, &expenseError{http.StatusConflict, "shift_required",
				"drawer expenses require an open shift — open one in the Shift screen"}
		}
		shiftPtr = &shiftID
	}
	// Owner / owner-cash flows need a real owner row. Lock it so an owner_cash
	// spend serialises with concurrent reconciles (the holding check must be
	// race-free) and so a deleted/edited owner can't slip through mid-write.
	if p.PaidFrom == "owner" || p.PaidFrom == "owner_cash" {
		var name string
		if err := tx.QueryRow(ctx,
			`SELECT display_name FROM cafe_owners WHERE id = $1 FOR UPDATE`, *p.OwnerID,
		).Scan(&name); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return uuid.Nil, &expenseError{http.StatusBadRequest, "bad_request", "owner not found"}
			}
			return uuid.Nil, err
		}
		// owner_cash spends draw down the cafe cash the owner is holding — never
		// more than they actually have on hand.
		if p.PaidFrom == "owner_cash" {
			held, err := ownerCashHolding(ctx, *p.OwnerID)
			if err != nil {
				return uuid.Nil, err
			}
			if p.AmountCents > held {
				return uuid.Nil, &expenseError{http.StatusConflict, "insufficient_holding",
					fmt.Sprintf("%s is only holding %s of cafe cash — can't spend %s",
						name, audit.Money(held), audit.Money(p.AmountCents))}
			}
		}
	}

	// 1. Insert the expense.
	var expenseID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO expenses
		  (tenant_id, expense_category_id, vendor, amount_cents, paid_at, payment_method,
		   reference_no, receipt_url, notes, linked_inventory_item_id, recorded_by_user_id,
		   shift_id, paid_from, owner_id)
		VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6::payment_method, $7, $8, $9, $10, $11, $12,
		        $13::expense_source, $14)
		RETURNING id
	`, tenantID, p.ExpenseCategoryID, p.Vendor, p.AmountCents, p.PaidAt,
		p.PaymentMethod, p.ReferenceNo, p.ReceiptURL, p.Notes,
		p.LinkedInventoryItemID, userID, shiftPtr,
		p.PaidFrom, p.OwnerID).Scan(&expenseID); err != nil {
		return uuid.Nil, err
	}

	// 1b. Drawer flow: emit the matching cash_drops row.
	if p.PaidFrom == "drawer" {
		drawerReason := "expense"
		if p.Vendor != "" {
			drawerReason = "expense — " + p.Vendor
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO cash_drops
			  (tenant_id, shift_id, direction, kind, amount_cents,
			   reason, notes, expense_id, recorded_by_user_id)
			VALUES ($1, $2, 'out'::cash_drop_direction, 'expense'::cash_drop_kind,
			        $3, $4, $5, $6, $7)
		`, tenantID, *shiftPtr, p.AmountCents, drawerReason, p.Notes,
			expenseID, userID); err != nil {
			return uuid.Nil, fmt.Errorf("failed to record drawer movement: %w", err)
		}
	}

	// 1c. Owner-pocket flow: register the cafe's debt to the owner via
	//     owner_ledger.loan_advance, linked to the expense.
	if p.PaidFrom == "owner" {
		ledgerNotes := "advanced for expense"
		if p.Vendor != "" {
			ledgerNotes += " — " + p.Vendor
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO owner_ledger
			  (tenant_id, owner_id, kind, amount_cents, notes,
			   expense_id, created_by_user_id)
			VALUES ($1, $2, 'loan_advance'::owner_ledger_kind, $3, $4, $5, $6)
		`, tenantID, *p.OwnerID, p.AmountCents, ledgerNotes,
			expenseID, userID); err != nil {
			return uuid.Nil, fmt.Errorf("failed to record owner loan: %w", err)
		}
	}

	// 1d. Owner-cash flow: the owner spent cafe cash they were already holding.
	//     Draw it down from their custody balance via owner_cash_entries — this
	//     is NOT a debt (contrast paid_from='owner', which is a loan_advance).
	if p.PaidFrom == "owner_cash" {
		ocNotes := "spent on cafe"
		if p.Vendor != "" {
			ocNotes += " — " + p.Vendor
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO owner_cash_entries
			  (tenant_id, owner_id, kind, amount_cents, notes, expense_id, recorded_by_user_id)
			VALUES ($1, $2, 'cafe_expense'::owner_cash_kind, $3, $4, $5, $6)
		`, tenantID, *p.OwnerID, p.AmountCents, ocNotes,
			expenseID, userID); err != nil {
			return uuid.Nil, fmt.Errorf("failed to record owner cash spend: %w", err)
		}
	}

	return expenseID, nil
}

// reverseExpense soft-deletes an expense and undoes its money side-effects
// (drawer cash_drops, owner-cash custody draw-down, owner loan_advance),
// refusing when doing so would corrupt a closed-shift variance or drop a loan
// that has repayments. Returns the vendor + amount so the caller can write its
// own audit line. Domain refusals come back as *expenseError. Used by
// DeleteExpense and DeleteStaffPay.
func reverseExpense(ctx context.Context, tx pgx.Tx, id uuid.UUID) (vendor string, amountCents int64, err error) {
	// Refuse to delete a drawer-paid expense whose shift is already closed:
	// the variance was already stamped, so removing the expense would
	// silently corrupt that closed shift's reconciliation.
	var paidFrom string
	var shiftClosed *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT e.paid_from::text, s.closed_at, e.vendor, e.amount_cents
		FROM expenses e
		LEFT JOIN shifts s ON s.id = e.shift_id
		WHERE e.id = $1 AND e.deleted_at IS NULL
	`, id).Scan(&paidFrom, &shiftClosed, &vendor, &amountCents); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", 0, &expenseError{http.StatusNotFound, "not_found", ""}
		}
		return "", 0, err
	}
	if paidFrom == "drawer" && shiftClosed != nil {
		return "", 0, &expenseError{http.StatusConflict, "shift_closed",
			"this expense was paid from a drawer that has since been closed — " +
				"deleting would corrupt the closed-shift variance. Record a " +
				"corrective expense or cash_drops adjustment instead."}
	}

	// Owner-paid expenses are linked to an owner_ledger.loan_advance row.
	// If that loan has any repayments, refuse deletion — the audit trail
	// would lose its anchor. The user can correct via a paired correction
	// ledger entry instead.
	if paidFrom == "owner" {
		var repaid int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(rp.amount_cents), 0)::bigint
			FROM owner_ledger la
			LEFT JOIN owner_ledger rp ON rp.parent_loan_id = la.id
			WHERE la.expense_id = $1 AND la.kind = 'loan_advance'
		`, id).Scan(&repaid); err != nil {
			return "", 0, err
		}
		if repaid > 0 {
			return "", 0, &expenseError{http.StatusConflict, "loan_repaid",
				"this expense has already been (partially) repaid to the owner. " +
					"Record a corrective ledger entry instead."}
		}
		// No repayments: cascade-remove the loan_advance row.
		if _, err := tx.Exec(ctx,
			`DELETE FROM owner_ledger WHERE expense_id = $1`, id); err != nil {
			return "", 0, fmt.Errorf("failed to clean up loan: %w", err)
		}
	}

	cmd, err := tx.Exec(ctx,
		`UPDATE expenses SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return "", 0, err
	}
	if cmd.RowsAffected() == 0 {
		return "", 0, &expenseError{http.StatusNotFound, "not_found", ""}
	}
	// Cascade-soft-delete: zap any cash_drops that pointed at this expense
	// (they only exist while the expense itself exists).
	if _, err := tx.Exec(ctx,
		`DELETE FROM cash_drops WHERE expense_id = $1`, id); err != nil {
		return "", 0, fmt.Errorf("failed to clean up drawer movement: %w", err)
	}
	// Likewise the owner-cash custody draw-down (owner_cash flow). The custody
	// balance returns to the owner, since the spend is being undone.
	if _, err := tx.Exec(ctx,
		`DELETE FROM owner_cash_entries WHERE expense_id = $1`, id); err != nil {
		return "", 0, fmt.Errorf("failed to clean up owner cash spend: %w", err)
	}
	return vendor, amountCents, nil
}

func CreateExpense(w http.ResponseWriter, r *http.Request) {
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		ExpenseCategoryID     *uuid.UUID `json:"expense_category_id"`
		Vendor                string     `json:"vendor"`
		AmountCents           int64      `json:"amount_cents"`
		PaidAt                *time.Time `json:"paid_at"`
		PaymentMethod         string     `json:"payment_method"`
		ReferenceNo           string     `json:"reference_no"`
		ReceiptURL            *string    `json:"receipt_url"`
		Notes                 string     `json:"notes"`
		LinkedInventoryItemID *uuid.UUID `json:"linked_inventory_item_id"`
		DeltaUnits            string     `json:"delta_units"`
		// 0014 model. paid_from = 'drawer' | 'bank' | 'owner'.
		PaidFrom       string     `json:"paid_from"`
		OwnerID        *uuid.UUID `json:"owner_id"`
		PaidFromDrawer bool       `json:"paid_from_drawer"` // back-compat
		Allocations    []struct {
			MenuCategoryID uuid.UUID `json:"menu_category_id"`
			SharePct       string    `json:"share_pct"`
		} `json:"allocations"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents > 0 required")
		return
	}

	// Resolve paid_from: explicit value wins; otherwise legacy bool; otherwise
	// default to 'bank' (the safer choice for non-drawer expenses).
	if body.PaidFrom == "" {
		if body.PaidFromDrawer {
			body.PaidFrom = "drawer"
		} else {
			body.PaidFrom = "bank"
		}
	}
	switch body.PaidFrom {
	case "drawer":
		body.PaymentMethod = "cash"
		if body.OwnerID != nil {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"owner_id only applies to paid_from='owner'")
			return
		}
	case "bank":
		body.PaymentMethod = "bank"
		if body.OwnerID != nil {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"owner_id only applies to paid_from='owner'")
			return
		}
	case "owner":
		if body.OwnerID == nil {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"paid_from='owner' requires owner_id")
			return
		}
		if body.PaymentMethod == "" {
			body.PaymentMethod = "cash" // how the owner paid the vendor; informational
		}
	case "owner_cash":
		// Owner spent cafe cash they're holding (drawn earlier from the drawer).
		// Draws down their custody balance — not a debt the cafe owes them.
		if body.OwnerID == nil {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"paid_from='owner_cash' requires owner_id")
			return
		}
		body.PaymentMethod = "cash" // it IS cafe cash, just held by the owner
	default:
		writeErr(w, http.StatusBadRequest, "bad_request",
			"paid_from must be 'drawer', 'bank', 'owner', or 'owner_cash'")
		return
	}
	if body.LinkedInventoryItemID != nil && body.DeltaUnits == "" {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"delta_units required when linked_inventory_item_id is set")
		return
	}

	totalShareHundredths := int64(0)
	for _, a := range body.Allocations {
		totalShareHundredths += parsePctHundredths(a.SharePct)
	}
	if totalShareHundredths > 10000 {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"allocation shares sum to more than 100%")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.create",
		"vendor", body.Vendor,
		"amount_cents", body.AmountCents,
		"paid_from", body.PaidFrom,
		"payment_method", body.PaymentMethod,
		"linked_inventory", body.LinkedInventoryItemID != nil,
		"allocations", len(body.Allocations))

	tx := appctx.Tx(r.Context())

	// Steps 0–1d (open shift, owner lock/holding, expense insert, source
	// side-effect) are the shared money core; inventory + allocations below
	// are specific to the manual-expense form.
	expenseID, err := recordExpense(r.Context(), tx, t.ID, user.ID, expenseParams{
		ExpenseCategoryID:     body.ExpenseCategoryID,
		Vendor:                body.Vendor,
		AmountCents:           body.AmountCents,
		PaidAt:                body.PaidAt,
		PaymentMethod:         body.PaymentMethod,
		ReferenceNo:           body.ReferenceNo,
		ReceiptURL:            body.ReceiptURL,
		Notes:                 body.Notes,
		LinkedInventoryItemID: body.LinkedInventoryItemID,
		PaidFrom:              body.PaidFrom,
		OwnerID:               body.OwnerID,
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

	// 2. If linked to inventory: create a 'purchase' stock_movement.
	//    unit_cost_cents = amount_cents / delta_units (rounded).
	if body.LinkedInventoryItemID != nil {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO stock_movements
			  (tenant_id, inventory_item_id, delta_units, reason, ref_type, ref_id,
			   unit_cost_cents, by_user_id, notes)
			VALUES
			  ($1, $2, $3::numeric, 'purchase', 'expense', $4,
			   ROUND($5::numeric / NULLIF($3::numeric, 0))::bigint, $6, $7)
		`, t.ID, *body.LinkedInventoryItemID, body.DeltaUnits, expenseID,
			body.AmountCents, user.ID, "from expense "+body.Vendor); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to create stock movement: "+err.Error())
			return
		}
		// Stock movements are an accounting trail too — leave an inventory
		// entry in the activity feed, not just the expense one.
		var itemName string
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM inventory_items WHERE id = $1`,
			*body.LinkedInventoryItemID).Scan(&itemName); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "inventory_item", EntityID: body.LinkedInventoryItemID,
			Summary: fmt.Sprintf("purchased %s %s via expense %s (%s)",
				body.DeltaUnits, audit.Quote(itemName), audit.Quote(body.Vendor),
				audit.Money(body.AmountCents)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	// 3. Insert allocations.
	for _, a := range body.Allocations {
		share := parsePctHundredths(a.SharePct) // pct × 100 (so 100% = 10000)
		if share <= 0 {
			continue
		}
		amount := (body.AmountCents*share + 5000) / 10000 // round half-up
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO expense_allocations
			  (tenant_id, expense_id, menu_category_id, share_pct, amount_cents)
			VALUES ($1, $2, $3, $4::numeric, $5)
		`, t.ID, expenseID, a.MenuCategoryID, a.SharePct, amount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to create allocation: "+err.Error())
			return
		}
	}

	sourceNote := " from " + body.PaidFrom
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "expense", EntityID: &expenseID,
		Summary: fmt.Sprintf("created expense %s (%s)%s",
			audit.Quote(body.Vendor), audit.Money(body.AmountCents), sourceNote),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Refetch with joins for a friendly response.
	getExpenseByID(w, r, expenseID, http.StatusCreated)
}

// expenseFields is the editable snapshot used to build a field-level audit
// diff for UpdateExpense. CategoryName carries the human label ("" = none).
type expenseFields struct {
	Vendor       string
	AmountCents  int64
	CategoryName string
	PaidAt       time.Time
	ReferenceNo  string
	Notes        string
}

// expenseDiffClauses lists human-readable "x → y" clauses for every field
// that actually changed. Empty slice = nothing changed.
func expenseDiffClauses(old, new expenseFields) []string {
	clauses := []string{}
	if old.AmountCents != new.AmountCents {
		clauses = append(clauses, fmt.Sprintf("amount %s → %s",
			audit.Money(old.AmountCents), audit.Money(new.AmountCents)))
	}
	if old.Vendor != new.Vendor {
		clauses = append(clauses, fmt.Sprintf("vendor %s → %s",
			audit.Quote(old.Vendor), audit.Quote(new.Vendor)))
	}
	if old.CategoryName != new.CategoryName {
		oldName, newName := old.CategoryName, new.CategoryName
		if oldName == "" {
			oldName = "none"
		} else {
			oldName = audit.Quote(oldName)
		}
		if newName == "" {
			newName = "none"
		} else {
			newName = audit.Quote(newName)
		}
		clauses = append(clauses, fmt.Sprintf("category %s → %s", oldName, newName))
	}
	if !old.PaidAt.Equal(new.PaidAt) {
		clauses = append(clauses, fmt.Sprintf("date %s → %s",
			old.PaidAt.Format("2006-01-02 15:04"), new.PaidAt.Format("2006-01-02 15:04")))
	}
	if old.ReferenceNo != new.ReferenceNo {
		clauses = append(clauses, fmt.Sprintf("reference %s → %s",
			audit.Quote(old.ReferenceNo), audit.Quote(new.ReferenceNo)))
	}
	if old.Notes != new.Notes {
		clauses = append(clauses, "notes updated")
	}
	return clauses
}

// UpdateExpense PATCHes the editable fields of an expense and keeps its
// side-effect rows consistent in the same transaction:
//   - drawer expense: the paired cash_drops row (amount only while the shift
//     is still open — a closed shift's variance is already stamped)
//   - owner expense: the owner_ledger loan_advance row (only while no
//     repayments exist)
//   - linked purchase movement: unit_cost_cents recomputed from the new
//     amount, and the item's last-purchase cost refreshed if this is its
//     latest purchase
//
// paid_from / owner_id / shift_id / inventory link / delta_units are
// immutable — changing the money source or the stock effect would rewrite
// ledgers; delete and re-create instead.
func UpdateExpense(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	for _, k := range []string{"paid_from", "paid_from_drawer", "owner_id", "shift_id",
		"linked_inventory_item_id", "delta_units", "payment_method"} {
		if _, found := keys[k]; found {
			writeErr(w, http.StatusBadRequest, "immutable_field",
				"the payment source and inventory link can't be changed — "+
					"delete the expense and re-create it instead")
			return
		}
	}

	var body struct {
		Vendor            *string    `json:"vendor"`
		ExpenseCategoryID *uuid.UUID `json:"expense_category_id"`
		ClearCategory     bool       `json:"clear_category"`
		AmountCents       *int64     `json:"amount_cents"`
		PaidAt            *time.Time `json:"paid_at"`
		ReferenceNo       *string    `json:"reference_no"`
		ReceiptURL        *string    `json:"receipt_url"`
		Notes             *string    `json:"notes"`
		Allocations       *[]struct {
			MenuCategoryID uuid.UUID `json:"menu_category_id"`
			SharePct       string    `json:"share_pct"`
		} `json:"allocations"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.AmountCents != nil && *body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents > 0 required")
		return
	}
	if body.Allocations != nil {
		totalShareHundredths := int64(0)
		for _, a := range *body.Allocations {
			totalShareHundredths += parsePctHundredths(a.SharePct)
		}
		if totalShareHundredths > 10000 {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"allocation shares sum to more than 100%")
			return
		}
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.update", "id", id)
	tx := appctx.Tx(r.Context())

	// Snapshot the current row (locked) so we can validate guards and build
	// the audit diff against what was actually stored.
	var old expenseFields
	var oldCategoryID, linkedItemID *uuid.UUID
	var paidFrom string
	var shiftClosed *time.Time
	err = tx.QueryRow(r.Context(), `
		SELECT e.vendor, e.amount_cents, COALESCE(ec.name, ''), e.paid_at,
		       e.reference_no, e.notes, e.expense_category_id,
		       e.linked_inventory_item_id, e.paid_from::text, s.closed_at
		FROM expenses e
		LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
		LEFT JOIN shifts s ON s.id = e.shift_id
		WHERE e.id = $1 AND e.deleted_at IS NULL
		FOR UPDATE OF e
	`, id).Scan(&old.Vendor, &old.AmountCents, &old.CategoryName, &old.PaidAt,
		&old.ReferenceNo, &old.Notes, &oldCategoryID,
		&linkedItemID, &paidFrom, &shiftClosed)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	amountChanged := body.AmountCents != nil && *body.AmountCents != old.AmountCents
	if amountChanged && paidFrom == "drawer" && shiftClosed != nil {
		writeErr(w, http.StatusConflict, "shift_closed",
			"this expense was paid from a drawer that has since been closed — "+
				"changing the amount would corrupt the closed-shift variance. "+
				"Record a corrective expense instead.")
		return
	}
	if amountChanged && paidFrom == "owner" {
		var repaid int64
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(SUM(rp.amount_cents), 0)::bigint
			FROM owner_ledger la
			LEFT JOIN owner_ledger rp ON rp.parent_loan_id = la.id
			WHERE la.expense_id = $1 AND la.kind = 'loan_advance'
		`, id).Scan(&repaid); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if repaid > 0 {
			writeErr(w, http.StatusConflict, "loan_repaid",
				"this expense has already been (partially) repaid to the owner — "+
					"changing the amount would orphan those repayments. "+
					"Record a corrective ledger entry instead.")
			return
		}
	}

	// Apply the expense-row update.
	if _, err := tx.Exec(r.Context(), `
		UPDATE expenses SET
			vendor              = COALESCE($2, vendor),
			expense_category_id = CASE WHEN $3 THEN NULL ELSE COALESCE($4, expense_category_id) END,
			amount_cents        = COALESCE($5, amount_cents),
			paid_at             = COALESCE($6, paid_at),
			reference_no        = COALESCE($7, reference_no),
			receipt_url         = COALESCE($8, receipt_url),
			notes               = COALESCE($9, notes),
			updated_at          = now()
		WHERE id = $1
	`, id, body.Vendor, body.ClearCategory, body.ExpenseCategoryID,
		body.AmountCents, body.PaidAt, body.ReferenceNo, body.ReceiptURL,
		body.Notes); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	newAmount := old.AmountCents
	if body.AmountCents != nil {
		newAmount = *body.AmountCents
	}
	newVendor := old.Vendor
	if body.Vendor != nil {
		newVendor = *body.Vendor
	}

	// Keep the paired drawer movement in sync: amount only while the shift is
	// open (guarded above); the reason label is cosmetic and always follows.
	if paidFrom == "drawer" && (amountChanged || newVendor != old.Vendor) {
		drawerReason := "expense"
		if newVendor != "" {
			drawerReason = "expense — " + newVendor
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE cash_drops SET amount_cents = $2, reason = $3
			WHERE expense_id = $1
		`, id, newAmount, drawerReason); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to update drawer movement: "+err.Error())
			return
		}
	}

	// Keep the owner loan in sync (no repayments exist — guarded above).
	if paidFrom == "owner" && amountChanged {
		if _, err := tx.Exec(r.Context(), `
			UPDATE owner_ledger SET amount_cents = $2
			WHERE expense_id = $1 AND kind = 'loan_advance'
		`, id, newAmount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to update owner loan: "+err.Error())
			return
		}
	}

	// Keep the owner-cash custody draw-down in sync with the new amount.
	if paidFrom == "owner_cash" && amountChanged {
		if _, err := tx.Exec(r.Context(), `
			UPDATE owner_cash_entries SET amount_cents = $2
			WHERE expense_id = $1 AND kind = 'cafe_expense'
		`, id, newAmount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to update owner cash spend: "+err.Error())
			return
		}
	}

	// Recompute the linked purchase movement's unit cost, and refresh the
	// item's denormalized last-purchase cost if this is its latest purchase
	// (the 0005 trigger only fires on INSERT).
	if linkedItemID != nil && amountChanged {
		if _, err := tx.Exec(r.Context(), `
			UPDATE stock_movements
			SET unit_cost_cents = ROUND($2::numeric / NULLIF(delta_units, 0))::bigint
			WHERE ref_type = 'expense' AND ref_id = $1
		`, id, newAmount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to update stock movement: "+err.Error())
			return
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE inventory_items ii
			SET last_purchase_unit_cost_cents = sm.unit_cost_cents
			FROM stock_movements sm
			WHERE sm.ref_type = 'expense' AND sm.ref_id = $1
			  AND ii.id = sm.inventory_item_id
			  AND sm.id = (SELECT id FROM stock_movements
			               WHERE inventory_item_id = ii.id AND reason = 'purchase'
			               ORDER BY at DESC LIMIT 1)
		`, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"failed to refresh item cost: "+err.Error())
			return
		}
	}

	// Allocations: explicit list replaces; otherwise an amount change
	// re-scales the stored shares.
	allocationsChanged := false
	if body.Allocations != nil {
		allocationsChanged = true
		t, _ := appctx.TenantFromContext(r.Context())
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM expense_allocations WHERE expense_id = $1`, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		for _, a := range *body.Allocations {
			share := parsePctHundredths(a.SharePct)
			if share <= 0 {
				continue
			}
			amount := (newAmount*share + 5000) / 10000
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO expense_allocations
				  (tenant_id, expense_id, menu_category_id, share_pct, amount_cents)
				VALUES ($1, $2, $3, $4::numeric, $5)
			`, t.ID, id, a.MenuCategoryID, a.SharePct, amount); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error",
					"failed to update allocation: "+err.Error())
				return
			}
		}
	} else if amountChanged {
		rows, err := tx.Query(r.Context(),
			`SELECT id, share_pct::text FROM expense_allocations WHERE expense_id = $1`, id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		type allocRow struct {
			id    uuid.UUID
			share int64
		}
		allocs := []allocRow{}
		for rows.Next() {
			var a allocRow
			var pct string
			if err := rows.Scan(&a.id, &pct); err != nil {
				rows.Close()
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			a.share = parsePctHundredths(pct)
			allocs = append(allocs, a)
		}
		rows.Close()
		for _, a := range allocs {
			amount := (newAmount*a.share + 5000) / 10000
			if _, err := tx.Exec(r.Context(),
				`UPDATE expense_allocations SET amount_cents = $2 WHERE id = $1`,
				a.id, amount); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error",
					"failed to rescale allocation: "+err.Error())
				return
			}
		}
	}

	// Build the after snapshot for the audit diff.
	newFields := expenseFields{
		Vendor:       newVendor,
		AmountCents:  newAmount,
		CategoryName: old.CategoryName,
		PaidAt:       old.PaidAt,
		ReferenceNo:  old.ReferenceNo,
		Notes:        old.Notes,
	}
	if body.ClearCategory {
		newFields.CategoryName = ""
	} else if body.ExpenseCategoryID != nil {
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM expense_categories WHERE id = $1`,
			*body.ExpenseCategoryID).Scan(&newFields.CategoryName); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "expense category not found")
			return
		}
	}
	if body.PaidAt != nil {
		newFields.PaidAt = *body.PaidAt
	}
	if body.ReferenceNo != nil {
		newFields.ReferenceNo = *body.ReferenceNo
	}
	if body.Notes != nil {
		newFields.Notes = *body.Notes
	}

	clauses := expenseDiffClauses(old, newFields)
	if body.ReceiptURL != nil {
		clauses = append(clauses, "receipt updated")
	}
	if allocationsChanged {
		clauses = append(clauses, "allocations replaced")
	}
	if len(clauses) > 0 {
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "expense", EntityID: &id,
			Summary: fmt.Sprintf("updated expense %s — %s",
				audit.Quote(newVendor), strings.Join(clauses, "; ")),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	getExpenseByID(w, r, id, http.StatusOK)
}

// ListExpenseVendors returns recently-used vendor names for autocomplete in
// the expense form — free-text vendors otherwise drift ("Mill" / "Local Mill").
func ListExpenseVendors(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT vendor FROM expenses
		WHERE deleted_at IS NULL AND vendor <> ''
		GROUP BY vendor
		ORDER BY max(paid_at) DESC
		LIMIT 30
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"vendors": out})
}

func DeleteExpense(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "expenses.delete", "id", id)
	tx := appctx.Tx(r.Context())

	vendor, amountCents, err := reverseExpense(r.Context(), tx, id)
	if err != nil {
		var ee *expenseError
		if errors.As(err, &ee) {
			writeErr(w, ee.status, ee.code, ee.msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "expense", EntityID: &id,
		Summary: fmt.Sprintf("deleted expense %s (%s)",
			audit.Quote(vendor), audit.Money(amountCents)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// helper used by Create/UpdateExpense to write the response body using GetExpense.
func getExpenseByID(w http.ResponseWriter, r *http.Request, id uuid.UUID, status int) {
	tx := appctx.Tx(r.Context())

	var e Expense
	err := tx.QueryRow(r.Context(), `
		SELECT e.id, e.expense_category_id, ec.name,
		       e.vendor, e.amount_cents, e.paid_at, e.payment_method::text, e.reference_no,
		       e.receipt_url, e.notes, e.linked_inventory_item_id, ii.name,
		       e.recorded_by_user_id, e.created_at,
		       e.paid_from::text, e.owner_id, co.display_name,
		       e.paid_from_drawer, e.shift_id
		FROM expenses e
		LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id
		LEFT JOIN inventory_items ii ON ii.id = e.linked_inventory_item_id
		LEFT JOIN cafe_owners co ON co.id = e.owner_id
		WHERE e.id = $1
	`, id).Scan(&e.ID, &e.ExpenseCategoryID, &e.ExpenseCategoryName,
		&e.Vendor, &e.AmountCents, &e.PaidAt, &e.PaymentMethod, &e.ReferenceNo,
		&e.ReceiptURL, &e.Notes, &e.LinkedInventoryItemID, &e.LinkedInventoryName,
		&e.RecordedByUserID, &e.CreatedAt,
		&e.PaidFrom, &e.OwnerID, &e.OwnerName,
		&e.PaidFromDrawer, &e.ShiftID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	rows, err := tx.Query(r.Context(), `
		SELECT a.id, a.expense_id, a.menu_category_id, mc.name, a.share_pct::text, a.amount_cents
		FROM expense_allocations a
		JOIN menu_categories mc ON mc.id = a.menu_category_id
		WHERE a.expense_id = $1
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	e.Allocations = []ExpenseAllocation{}
	for rows.Next() {
		var a ExpenseAllocation
		if err := rows.Scan(&a.ID, &a.ExpenseID, &a.MenuCategoryID, &a.MenuCategoryName,
			&a.SharePct, &a.AmountCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		e.Allocations = append(e.Allocations, a)
	}
	writeJSON(w, status, e)
}
