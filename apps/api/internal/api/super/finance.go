package super

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// The platform's own books.
//
// One rule governs the whole file: a cash HOLDING is never stored, only ever
// summed from platform_cash_entries. A stored balance is a second source of
// truth that will eventually disagree with its own history; a derived one
// cannot. Same reasoning as the tenant-side owner-cash model (0034).

// holdingExpr builds the signed sum that defines "cash this person is holding".
// Collections and incoming handovers add; everything else draws it down.
//
// Takes the table alias rather than using bare column names: platform_people
// ALSO has a `kind` column (admin/agent/partner), so an unqualified `kind` is
// ambiguous the moment the two tables are joined — which is exactly what the
// holdings list does.
func holdingExpr(alias string) string {
	return `COALESCE(SUM(CASE WHEN ` + alias + `.kind IN ('collection','handover_in')
	                          THEN ` + alias + `.amount_cents
	                          ELSE -` + alias + `.amount_cents END), 0)::bigint`
}

var (
	receivedIntoKinds = map[string]bool{"cash": true, "bank": true, "wallet": true}
	paidFromKinds     = map[string]bool{"bank": true, "wallet": true, "person_cash": true}
)

// lockPersonForCash takes a row lock on the holder so two concurrent spends
// serialise: the second waits, re-reads the holding, and sees the first one's
// effect. Without it both could pass an "amount <= holding" check and overdraw.
// Mirrors lockOwnerForReconcile on the tenant side.
func lockPersonForCash(ctx context.Context, tx pgx.Tx, id uuid.UUID) (name string, found bool, err error) {
	err = tx.QueryRow(ctx, `SELECT name FROM platform_people WHERE id = $1 FOR UPDATE`, id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return name, err == nil, err
}

// cashHolding is the net cash a person currently holds. Only meaningful after
// lockPersonForCash — otherwise it can shift under a concurrent write.
func cashHolding(ctx context.Context, tx pgx.Tx, personID uuid.UUID) (int64, error) {
	var held int64
	err := tx.QueryRow(ctx,
		`SELECT `+holdingExpr("ce")+` FROM platform_cash_entries ce WHERE ce.person_id = $1`, personID).Scan(&held)
	return held, err
}

// --- cash custody --------------------------------------------------------

// CashHolder is one person's custody position.
type CashHolder struct {
	PersonID   uuid.UUID  `json:"person_id"`
	Name       string     `json:"name"`
	Active     bool       `json:"active"`
	HeldCents  int64      `json:"held_cents"`
	OldestHeld *time.Time `json:"oldest_held_at,omitempty"`
}

// CashEntry is one movement in the custody ledger.
type CashEntry struct {
	ID           uuid.UUID `json:"id"`
	PersonID     uuid.UUID `json:"person_id"`
	PersonName   string    `json:"person_name"`
	Kind         string    `json:"kind"`
	AmountCents  int64     `json:"amount_cents"`
	OccurredAt   time.Time `json:"occurred_at"`
	Counterparty *string   `json:"counterparty_name,omitempty"`
	CafeName     *string   `json:"cafe_name,omitempty"`
	ReferenceNo  string    `json:"reference_no"`
	Notes        string    `json:"notes"`
}

// ListCash — GET /v1/super/finance/cash.
//
// Every ACTIVE person is listed even at zero, so a collection can be recorded
// against them without hunting; an inactive person appears only while they
// still hold something, because you can't retire somebody who has your money.
// Same HAVING trick as the tenant-side ListOwnerCash.
func ListCash(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), `
		SELECT pp.id, pp.name, pp.active,
		       `+holdingExpr("ce")+`,
		       MIN(ce.occurred_at) FILTER (WHERE ce.kind = 'collection')
		FROM platform_people pp
		LEFT JOIN platform_cash_entries ce ON ce.person_id = pp.id
		GROUP BY pp.id, pp.name, pp.active
		HAVING pp.active OR `+holdingExpr("ce")+` <> 0
		ORDER BY `+holdingExpr("ce")+` DESC, pp.name
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	holders := []CashHolder{}
	var total int64
	for rows.Next() {
		var h CashHolder
		if err := rows.Scan(&h.PersonID, &h.Name, &h.Active, &h.HeldCents, &h.OldestHeld); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		holders = append(holders, h)
		total += h.HeldCents
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	entries, err := loadCashLedger(r.Context(), tx, uuid.Nil, 200)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"holders": holders, "entries": entries, "total_held_cents": total,
	})
}

func loadCashLedger(ctx context.Context, tx pgx.Tx, personID uuid.UUID, limit int) ([]CashEntry, error) {
	var arg any
	if personID != uuid.Nil {
		arg = personID
	}
	rows, err := tx.Query(ctx, `
		SELECT ce.id, ce.person_id, pp.name, ce.kind::text, ce.amount_cents, ce.occurred_at,
		       cp.name, t.name, ce.reference_no, ce.notes
		FROM platform_cash_entries ce
		JOIN platform_people pp ON pp.id = ce.person_id
		LEFT JOIN platform_people cp ON cp.id = ce.counterparty_person_id
		LEFT JOIN tenant_payments tp ON tp.id = ce.payment_id
		LEFT JOIN tenants t ON t.id = tp.tenant_id
		WHERE ($1::uuid IS NULL OR ce.person_id = $1)
		ORDER BY ce.occurred_at DESC
		LIMIT $2
	`, arg, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CashEntry{}
	for rows.Next() {
		var e CashEntry
		if err := rows.Scan(&e.ID, &e.PersonID, &e.PersonName, &e.Kind, &e.AmountCents,
			&e.OccurredAt, &e.Counterparty, &e.CafeName, &e.ReferenceNo, &e.Notes); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// DepositCash — POST /v1/super/finance/cash/deposit
//
//	body: {person_id, amount_cents, reference_no?, notes?}
//
// The person banked some of what they're holding. Doesn't change how much money
// the platform has — it moves it from a bag to an account.
func DepositCash(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PersonID    uuid.UUID `json:"person_id"`
		AmountCents int64     `json:"amount_cents"`
		ReferenceNo string    `json:"reference_no"`
		Notes       string    `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount must be more than zero")
		return
	}
	actor, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	name, found, err := lockPersonForCash(r.Context(), tx, body.PersonID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if !found {
		writeErr(w, http.StatusBadRequest, "unknown_person", "no such person in the registry")
		return
	}
	held, err := cashHolding(r.Context(), tx, body.PersonID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if body.AmountCents > held {
		writeErr(w, http.StatusConflict, "insufficient_holding",
			name+" is only holding "+audit.Money(held))
		return
	}

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO platform_cash_entries
			(person_id, kind, amount_cents, reference_no, notes, recorded_by)
		VALUES ($1, 'deposit_to_bank', $2, $3, $4, $5)
	`, body.PersonID, body.AmountCents, strings.TrimSpace(body.ReferenceNo),
		body.Notes, actor.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "finance.cash_deposit", TargetID: body.PersonID.String(),
		Summary: name + " banked " + audit.Money(body.AmountCents),
		Meta:    map[string]any{"amount_cents": body.AmountCents, "reference_no": body.ReferenceNo}})
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "remaining_cents": held - body.AmountCents})
}

// HandoverCash — POST /v1/super/finance/cash/handover
//
//	body: {from_person_id, to_person_id, amount_cents, notes?}
//
// One person passes cash to another. Written as a PAIR of rows sharing a
// transfer_group_id, so the two holdings move in opposite directions by the
// same amount and the platform's total cash-in-hands is unchanged.
func HandoverCash(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FromPersonID uuid.UUID `json:"from_person_id"`
		ToPersonID   uuid.UUID `json:"to_person_id"`
		AmountCents  int64     `json:"amount_cents"`
		Notes        string    `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount must be more than zero")
		return
	}
	if body.FromPersonID == body.ToPersonID {
		writeErr(w, http.StatusBadRequest, "bad_request", "pick two different people")
		return
	}
	actor, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	// Lock in a STABLE order (lowest uuid first) regardless of direction, so
	// two simultaneous handovers between the same pair can't deadlock by each
	// grabbing one row and waiting for the other.
	first, second := body.FromPersonID, body.ToPersonID
	if second.String() < first.String() {
		first, second = second, first
	}
	if _, found, err := lockPersonForCash(r.Context(), tx, first); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	} else if !found {
		writeErr(w, http.StatusBadRequest, "unknown_person", "no such person in the registry")
		return
	}
	if _, found, err := lockPersonForCash(r.Context(), tx, second); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	} else if !found {
		writeErr(w, http.StatusBadRequest, "unknown_person", "no such person in the registry")
		return
	}

	var fromName, toName string
	if err := tx.QueryRow(r.Context(), `SELECT name FROM platform_people WHERE id = $1`, body.FromPersonID).Scan(&fromName); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := tx.QueryRow(r.Context(), `SELECT name FROM platform_people WHERE id = $1`, body.ToPersonID).Scan(&toName); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	held, err := cashHolding(r.Context(), tx, body.FromPersonID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if body.AmountCents > held {
		writeErr(w, http.StatusConflict, "insufficient_holding",
			fromName+" is only holding "+audit.Money(held))
		return
	}

	group := uuid.New()
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO platform_cash_entries
			(person_id, kind, amount_cents, counterparty_person_id, transfer_group_id, notes, recorded_by)
		VALUES ($1, 'handover_out', $3, $2, $4, $5, $6),
		       ($2, 'handover_in',  $3, $1, $4, $5, $6)
	`, body.FromPersonID, body.ToPersonID, body.AmountCents, group, body.Notes, actor.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "finance.cash_handover", TargetID: group.String(),
		Summary: fromName + " handed " + audit.Money(body.AmountCents) + " to " + toName,
		Meta:    map[string]any{"amount_cents": body.AmountCents, "from": fromName, "to": toName}})
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

// --- expenses ------------------------------------------------------------

// PlatformExpense is one thing the platform spent money on.
type PlatformExpense struct {
	ID           uuid.UUID  `json:"id"`
	CategoryID   *uuid.UUID `json:"category_id,omitempty"`
	CategoryName *string    `json:"category_name,omitempty"`
	AmountCents  int64      `json:"amount_cents"`
	Currency     string     `json:"currency"`
	OccurredOn   string     `json:"occurred_on"`
	Vendor       string     `json:"vendor"`
	Note         string     `json:"note"`
	PaidFrom     string     `json:"paid_from"`
	PaidByID     *uuid.UUID `json:"paid_by_person_id,omitempty"`
	PaidByName   *string    `json:"paid_by_name,omitempty"`
	TenantID     *uuid.UUID `json:"tenant_id,omitempty"`
	CafeName     *string    `json:"cafe_name,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

// ListExpenses — GET /v1/super/finance/expenses?from&to.
func ListExpenses(w http.ResponseWriter, r *http.Request) {
	from, to, ok := parseRange(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT e.id, e.category_id, c.name, e.amount_cents, e.currency,
		       to_char(e.occurred_on, 'YYYY-MM-DD'), e.vendor, e.note,
		       e.paid_from, e.paid_by_person_id, pp.name, e.tenant_id, t.name, e.created_at
		FROM platform_expenses e
		LEFT JOIN platform_expense_categories c ON c.id = e.category_id
		LEFT JOIN platform_people pp ON pp.id = e.paid_by_person_id
		LEFT JOIN tenants t ON t.id = e.tenant_id
		WHERE e.deleted_at IS NULL AND e.occurred_on >= $1::date AND e.occurred_on <= $2::date
		ORDER BY e.occurred_on DESC, e.created_at DESC
	`, from, to)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []PlatformExpense{}
	var total int64
	for rows.Next() {
		var e PlatformExpense
		if err := rows.Scan(&e.ID, &e.CategoryID, &e.CategoryName, &e.AmountCents, &e.Currency,
			&e.OccurredOn, &e.Vendor, &e.Note, &e.PaidFrom, &e.PaidByID, &e.PaidByName,
			&e.TenantID, &e.CafeName, &e.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, e)
		total += e.AmountCents
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"expenses": out, "total_cents": total})
}

// CreateExpense — POST /v1/super/finance/expenses.
//
// When paid from a person's collected cash this ALSO writes the matching
// custody row, in the same transaction — otherwise their holding would stay
// high while the money is gone.
func CreateExpense(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CategoryID  *uuid.UUID `json:"category_id"`
		AmountCents int64      `json:"amount_cents"`
		Currency    string     `json:"currency"`
		OccurredOn  string     `json:"occurred_on"`
		Vendor      string     `json:"vendor"`
		Note        string     `json:"note"`
		PaidFrom    string     `json:"paid_from"`
		PaidByID    *uuid.UUID `json:"paid_by_person_id"`
		TenantID    *uuid.UUID `json:"tenant_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount must be more than zero")
		return
	}
	if !paidFromKinds[body.PaidFrom] {
		writeErr(w, http.StatusBadRequest, "bad_request", "paid_from must be bank, wallet or person_cash")
		return
	}
	if (body.PaidFrom == "person_cash") != (body.PaidByID != nil) {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"name the person only when the money came out of collected cash")
		return
	}
	day, valid := parseDateOnly(body.OccurredOn)
	if !valid {
		writeErr(w, http.StatusBadRequest, "bad_request", "occurred_on must be a YYYY-MM-DD date")
		return
	}
	currency := body.Currency
	if currency == "" {
		currency = "NPR"
	}
	actor, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	// Lock + check BEFORE inserting anything, so an overdraw is a clean 409
	// rather than a half-written expense.
	var payerName string
	if body.PaidByID != nil {
		name, found, err := lockPersonForCash(r.Context(), tx, *body.PaidByID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !found {
			writeErr(w, http.StatusBadRequest, "unknown_person", "no such person in the registry")
			return
		}
		payerName = name
		held, err := cashHolding(r.Context(), tx, *body.PaidByID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if body.AmountCents > held {
			writeErr(w, http.StatusConflict, "insufficient_holding",
				payerName+" is only holding "+audit.Money(held))
			return
		}
	}

	var id uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO platform_expenses
			(category_id, amount_cents, currency, occurred_on, vendor, note,
			 paid_from, paid_by_person_id, tenant_id, recorded_by)
		VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10)
		RETURNING id
	`, body.CategoryID, body.AmountCents, currency, day, strings.TrimSpace(body.Vendor),
		body.Note, body.PaidFrom, body.PaidByID, body.TenantID, actor.ID).Scan(&id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if body.PaidByID != nil {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO platform_cash_entries
				(person_id, kind, amount_cents, expense_id, notes, recorded_by)
			VALUES ($1, 'expense', $2, $3, $4, $5)
		`, *body.PaidByID, body.AmountCents, id, body.Note, actor.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	summary := "recorded " + audit.Money(body.AmountCents) + " of spending"
	if payerName != "" {
		summary += " from " + payerName + "'s cash"
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "finance.expense_create", TargetID: id.String(),
		Summary: summary, Meta: map[string]any{"amount_cents": body.AmountCents, "paid_from": body.PaidFrom}})
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// DeleteExpense — POST /v1/super/finance/expenses/{id}/delete.
//
// Soft delete. Refuses when the expense drew on someone's collected cash: the
// custody ledger is append-only, so removing the expense without reversing the
// custody row would silently inflate that person's holding. Correct it with a
// compensating entry instead.
func DeleteExpense(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())

	var linked bool
	if err := tx.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM platform_cash_entries WHERE expense_id = $1)`, id).Scan(&linked); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if linked {
		writeErr(w, http.StatusConflict, "linked_to_cash",
			"this was paid from someone's collected cash — record a correcting entry rather than deleting it")
		return
	}

	ct, err := tx.Exec(r.Context(),
		`UPDATE platform_expenses SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such expense")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "finance.expense_delete", TargetID: id.String(),
		Summary: "deleted an expense"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ExpenseCategory is a spending bucket.
type ExpenseCategory struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Icon      string    `json:"icon"`
	SortOrder int       `json:"sort_order"`
	Active    bool      `json:"active"`
}

// ListExpenseCategories — GET /v1/super/finance/expense-categories.
func ListExpenseCategories(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, icon, sort_order, active FROM platform_expense_categories
		WHERE active ORDER BY sort_order, name
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []ExpenseCategory{}
	for rows.Next() {
		var c ExpenseCategory
		if err := rows.Scan(&c.ID, &c.Name, &c.Icon, &c.SortOrder, &c.Active); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": out})
}

// CreateExpenseCategory — POST /v1/super/finance/expense-categories.
func CreateExpenseCategory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Icon string `json:"icon"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 60 {
		writeErr(w, http.StatusBadRequest, "bad_request", "name must be 1–60 characters")
		return
	}
	tx := appctx.Tx(r.Context())
	var id uuid.UUID
	err := tx.QueryRow(r.Context(), `
		INSERT INTO platform_expense_categories (name, icon, sort_order)
		VALUES ($1, $2, (SELECT COALESCE(max(sort_order), 0) + 10 FROM platform_expense_categories))
		RETURNING id
	`, body.Name, body.Icon).Scan(&id)
	if isUniqueViolation(err) {
		writeErr(w, http.StatusConflict, "category_exists", "there's already a category with that name")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// --- revenue + statement -------------------------------------------------

// parseRange reads ?from&to, defaulting to the last 90 days. Both bounds are
// INCLUSIVE dates — these are day-granularity ledgers, not timestamps, so the
// half-open convention used for order windows would just confuse the caller.
func parseRange(w http.ResponseWriter, r *http.Request) (from, to string, ok bool) {
	q := r.URL.Query()
	to = q.Get("to")
	if to == "" {
		to = time.Now().Format("2006-01-02")
	} else if _, valid := parseDateOnly(to); !valid {
		writeErr(w, http.StatusBadRequest, "bad_request", "to must be a YYYY-MM-DD date")
		return "", "", false
	}
	from = q.Get("from")
	if from == "" {
		from = time.Now().AddDate(0, 0, -90).Format("2006-01-02")
	} else if _, valid := parseDateOnly(from); !valid {
		writeErr(w, http.StatusBadRequest, "bad_request", "from must be a YYYY-MM-DD date")
		return "", "", false
	}
	if from > to {
		writeErr(w, http.StatusBadRequest, "bad_request", "from must not be after to")
		return "", "", false
	}
	return from, to, true
}

// RevenueRow is one payment in the cross-tenant explorer.
type RevenueRow struct {
	ID           uuid.UUID `json:"id"`
	TenantID     uuid.UUID `json:"tenant_id"`
	CafeName     string    `json:"cafe_name"`
	PlanName     *string   `json:"plan_name,omitempty"`
	AmountCents  int64     `json:"amount_cents"`
	Currency     string    `json:"currency"`
	Method       string    `json:"method"`
	ReceivedInto string    `json:"received_into"`
	CollectedBy  *string   `json:"collected_by_name,omitempty"`
	PeriodEnd    string    `json:"period_end"`
	Note         string    `json:"note"`
	CreatedAt    time.Time `json:"created_at"`
}

// ListRevenue — GET /v1/super/finance/revenue?from&to.
//
// Grouped totals come back alongside the rows so the console doesn't have to
// re-derive them and risk showing a different answer than the table.
func ListRevenue(w http.ResponseWriter, r *http.Request) {
	from, to, ok := parseRange(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT tp.id, tp.tenant_id, t.name, p.name, tp.amount_cents, tp.currency,
		       tp.method, tp.received_into, pp.name,
		       to_char(tp.period_end, 'YYYY-MM-DD'), tp.note, tp.created_at
		FROM tenant_payments tp
		JOIN tenants t ON t.id = tp.tenant_id
		LEFT JOIN plans p ON p.id = t.plan_id
		LEFT JOIN platform_people pp ON pp.id = tp.collected_by_person_id
		WHERE tp.created_at >= $1::date AND tp.created_at < ($2::date + 1)
		ORDER BY tp.created_at DESC
	`, from, to)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []RevenueRow{}
	var total int64
	byMethod := map[string]int64{}
	byCollector := map[string]int64{}
	byMonth := map[string]int64{}
	for rows.Next() {
		var v RevenueRow
		if err := rows.Scan(&v.ID, &v.TenantID, &v.CafeName, &v.PlanName, &v.AmountCents,
			&v.Currency, &v.Method, &v.ReceivedInto, &v.CollectedBy,
			&v.PeriodEnd, &v.Note, &v.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, v)
		total += v.AmountCents
		byMethod[v.Method] += v.AmountCents
		byMonth[v.CreatedAt.Format("2006-01")] += v.AmountCents
		who := "unattributed"
		if v.CollectedBy != nil {
			who = *v.CollectedBy
		}
		byCollector[who] += v.AmountCents
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"payments": out, "total_cents": total,
		"by_method": byMethod, "by_collector": byCollector, "by_month": byMonth,
	})
}

// GetStatement — GET /v1/super/finance/statement?from&to.
//
// Revenue minus expenses, plus where the money physically is. The cash position
// deliberately reports what is HELD BY PEOPLE separately: it's real money the
// platform owns but cannot spend from a bank account, and rolling it into one
// "cash" figure is what hides a collection sitting in somebody's bag for weeks.
func GetStatement(w http.ResponseWriter, r *http.Request) {
	from, to, ok := parseRange(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())

	var revenue, expenses int64
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM tenant_payments
		WHERE created_at >= $1::date AND created_at < ($2::date + 1)
	`, from, to).Scan(&revenue); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM platform_expenses
		WHERE deleted_at IS NULL AND occurred_on >= $1::date AND occurred_on <= $2::date
	`, from, to).Scan(&expenses); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	byCategory := map[string]int64{}
	catRows, err := tx.Query(r.Context(), `
		SELECT COALESCE(c.name, 'Uncategorised'), COALESCE(SUM(e.amount_cents), 0)::bigint
		FROM platform_expenses e
		LEFT JOIN platform_expense_categories c ON c.id = e.category_id
		WHERE e.deleted_at IS NULL AND e.occurred_on >= $1::date AND e.occurred_on <= $2::date
		GROUP BY 1 ORDER BY 2 DESC
	`, from, to)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for catRows.Next() {
		var name string
		var sum int64
		if err := catRows.Scan(&name, &sum); err != nil {
			catRows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		byCategory[name] = sum
	}
	catRows.Close()
	if err := catRows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Cash position — all-time, not range-bound: "how much is in the bank right
	// now" is not a property of a date range.
	var intoBank, intoWallet, intoCash, banked, spentFromCash int64
	if err := tx.QueryRow(r.Context(), `
		SELECT
			COALESCE(SUM(amount_cents) FILTER (WHERE received_into = 'bank'), 0)::bigint,
			COALESCE(SUM(amount_cents) FILTER (WHERE received_into = 'wallet'), 0)::bigint,
			COALESCE(SUM(amount_cents) FILTER (WHERE received_into = 'cash'), 0)::bigint
		FROM tenant_payments
	`).Scan(&intoBank, &intoWallet, &intoCash); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'deposit_to_bank'), 0)::bigint
		FROM platform_cash_entries
	`).Scan(&banked); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents) FILTER (WHERE paid_from = 'bank'), 0)::bigint
		FROM platform_expenses WHERE deleted_at IS NULL
	`).Scan(&spentFromCash); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	var heldByPeople int64
	if err := tx.QueryRow(r.Context(),
		`SELECT `+holdingExpr("ce")+` FROM platform_cash_entries ce`).Scan(&heldByPeople); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"from": from, "to": to,
		"revenue_cents":        revenue,
		"expenses_cents":       expenses,
		"net_cents":            revenue - expenses,
		"expenses_by_category": byCategory,
		"cash_position": map[string]int64{
			// Bank = paid straight in, plus what people have since banked,
			// minus what was spent from the bank.
			"bank_cents":           intoBank + banked - spentFromCash,
			"wallet_cents":         intoWallet,
			"held_by_people_cents": heldByPeople,
		},
	})
}
