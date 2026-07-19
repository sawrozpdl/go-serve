package api

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

// =========================================================================
// House tabs — named running ledgers for stakeholders.
//
// "Owner A walks in, eats a momo, signs it to his tab" — the cafe still
// recognises the revenue (it earned the money) but the cash isn't received
// yet. Closing a tab against a house tab inserts a payments row with
// method='house_tab' so the order's balance hits zero.  The cafe's
// receivable is tracked as: Σ method='house_tab' payments
// − Σ house_tab_settlements rows.
// =========================================================================

type HouseTab struct {
	ID              uuid.UUID  `json:"id"`
	Name            string     `json:"name"`
	Notes           string     `json:"notes"`
	ContactPhone    string     `json:"contact_phone"`
	IsActive        bool       `json:"is_active"`
	ChargedCents    int64      `json:"charged_cents"`
	SettledCents    int64      `json:"settled_cents"`
	BalanceCents    int64      `json:"balance_cents"`
	OpenChargeCount int        `json:"open_charge_count"`
	CreatedAt       time.Time  `json:"created_at"`
	ArchivedAt      *time.Time `json:"archived_at,omitempty"`
}

type HouseTabCharge struct {
	PaymentID        uuid.UUID `json:"payment_id"`
	OrderID          uuid.UUID `json:"order_id"`
	ServiceTableName *string   `json:"service_table_name,omitempty"`
	AmountCents      int64     `json:"amount_cents"`
	ReferenceNo      string    `json:"reference_no"`
	RecordedAt       time.Time `json:"recorded_at"`
	IsOpeningBalance bool      `json:"is_opening_balance"`
}

type HouseTabSettlement struct {
	ID            uuid.UUID `json:"id"`
	AmountCents   int64     `json:"amount_cents"`
	PaymentMethod string    `json:"payment_method"`
	ReferenceNo   string    `json:"reference_no"`
	Notes         string    `json:"notes"`
	RecordedAt    time.Time `json:"recorded_at"`
}

// =========================================================================
// LIST house tabs
// =========================================================================

func ListHouseTabs(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "house_tabs.list")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT ht.id, ht.name, ht.notes, ht.contact_phone, ht.is_active, ht.created_at, ht.archived_at,
		       COALESCE((SELECT SUM(p.amount_cents)
		                 FROM payments p
		                 WHERE p.house_tab_id = ht.id AND p.method = 'house_tab'), 0)::bigint AS charged,
		       COALESCE((SELECT SUM(s.amount_cents)
		                 FROM house_tab_settlements s
		                 WHERE s.house_tab_id = ht.id), 0)::bigint AS settled,
		       COALESCE((SELECT COUNT(*)
		                 FROM payments p
		                 WHERE p.house_tab_id = ht.id AND p.method = 'house_tab'), 0)::int AS charge_count
		FROM house_tabs ht
		WHERE ht.deleted_at IS NULL
		ORDER BY ht.is_active DESC, lower(ht.name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []HouseTab{}
	for rows.Next() {
		var ht HouseTab
		if err := rows.Scan(&ht.ID, &ht.Name, &ht.Notes, &ht.ContactPhone, &ht.IsActive, &ht.CreatedAt, &ht.ArchivedAt,
			&ht.ChargedCents, &ht.SettledCents, &ht.OpenChargeCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		ht.BalanceCents = ht.ChargedCents - ht.SettledCents
		out = append(out, ht)
	}
	writeJSON(w, http.StatusOK, map[string]any{"house_tabs": out})
}

// =========================================================================
// GET single house tab + ledger (charges + settlements)
// =========================================================================

func GetHouseTab(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "house_tabs.get", "id", id)
	tx := appctx.Tx(r.Context())

	var ht HouseTab
	err = tx.QueryRow(r.Context(), `
		SELECT ht.id, ht.name, ht.notes, ht.contact_phone, ht.is_active, ht.created_at, ht.archived_at,
		       COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.house_tab_id = ht.id AND p.method = 'house_tab'), 0)::bigint,
		       COALESCE((SELECT SUM(s.amount_cents) FROM house_tab_settlements s WHERE s.house_tab_id = ht.id), 0)::bigint,
		       COALESCE((SELECT COUNT(*) FROM payments p WHERE p.house_tab_id = ht.id AND p.method = 'house_tab'), 0)::int
		FROM house_tabs ht
		WHERE ht.id = $1 AND ht.deleted_at IS NULL
	`, id).Scan(&ht.ID, &ht.Name, &ht.Notes, &ht.ContactPhone, &ht.IsActive, &ht.CreatedAt, &ht.ArchivedAt,
		&ht.ChargedCents, &ht.SettledCents, &ht.OpenChargeCount)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	ht.BalanceCents = ht.ChargedCents - ht.SettledCents

	// Charges (closed orders settled to this tab).
	chargeRows, err := tx.Query(r.Context(), `
		SELECT p.id, p.order_id, st.name, p.amount_cents, p.reference_no, p.recorded_at,
		       (o.notes = $2) AS is_opening_balance
		FROM payments p
		JOIN orders o ON o.id = p.order_id
		LEFT JOIN service_tables st ON st.id = o.service_table_id
		WHERE p.house_tab_id = $1 AND p.method = 'house_tab'
		ORDER BY p.recorded_at DESC
	`, id, openingBalanceMarker)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	charges := []HouseTabCharge{}
	for chargeRows.Next() {
		var c HouseTabCharge
		if err := chargeRows.Scan(&c.PaymentID, &c.OrderID, &c.ServiceTableName,
			&c.AmountCents, &c.ReferenceNo, &c.RecordedAt, &c.IsOpeningBalance); err != nil {
			chargeRows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		charges = append(charges, c)
	}
	chargeRows.Close()

	// Settlements (paying down).
	setRows, err := tx.Query(r.Context(), `
		SELECT id, amount_cents, payment_method::text, reference_no, notes, recorded_at
		FROM house_tab_settlements
		WHERE house_tab_id = $1
		ORDER BY recorded_at DESC
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer setRows.Close()
	settlements := []HouseTabSettlement{}
	for setRows.Next() {
		var s HouseTabSettlement
		if err := setRows.Scan(&s.ID, &s.AmountCents, &s.PaymentMethod,
			&s.ReferenceNo, &s.Notes, &s.RecordedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		settlements = append(settlements, s)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"house_tab":   ht,
		"charges":     charges,
		"settlements": settlements,
	})
}

// =========================================================================
// CREATE / UPDATE / DELETE
// =========================================================================

func CreateHouseTab(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	user, _ := appctx.UserFromContext(r.Context())

	var body struct {
		Name                string `json:"name"`
		Notes               string `json:"notes"`
		ContactPhone        string `json:"contact_phone"`
		OpeningBalanceCents int64  `json:"opening_balance_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.ContactPhone = strings.TrimSpace(body.ContactPhone)
	if body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	if body.OpeningBalanceCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "opening_balance_cents must be >= 0")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "house_tabs.create", "name", body.Name, "opening_balance_cents", body.OpeningBalanceCents)

	tx := appctx.Tx(r.Context())
	var ht HouseTab
	err := tx.QueryRow(r.Context(), `
		INSERT INTO house_tabs (tenant_id, name, notes, contact_phone, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, name, notes, contact_phone, is_active, created_at, archived_at
	`, t.ID, body.Name, body.Notes, body.ContactPhone, user.ID).Scan(
		&ht.ID, &ht.Name, &ht.Notes, &ht.ContactPhone, &ht.IsActive, &ht.CreatedAt, &ht.ArchivedAt)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "name_taken", "a house tab with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// A new cafe onboarding onto the software may already have customers who
	// owe them money from before — seed that as a starting balance the same
	// way the (now-removed) go-live wizard did: a 'house_tab' payment
	// anchored to a synthetic, cancelled order (never a real serve, so it
	// stays out of sales/floor views — see openingBalanceMarker in orders.go)
	// and carrying no shift_id so it never inflates a shift's cash summary.
	if body.OpeningBalanceCents > 0 {
		var openingOrderID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO orders (tenant_id, opened_by_user_id, status, notes)
			VALUES ($1, $2, 'cancelled'::order_status, $3)
			RETURNING id
		`, t.ID, user.ID, openingBalanceMarker).Scan(&openingOrderID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO payments (tenant_id, order_id, method, amount_cents, recorded_by_user_id, house_tab_id)
			VALUES ($1, $2, 'house_tab'::payment_method, $3, $4, $5)
		`, t.ID, openingOrderID, body.OpeningBalanceCents, user.ID, ht.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	summary := fmt.Sprintf("created house tab %s", audit.Quote(ht.Name))
	if body.OpeningBalanceCents > 0 {
		summary = fmt.Sprintf("%s (opening balance %s)", summary, audit.Money(body.OpeningBalanceCents))
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "house_tab", EntityID: &ht.ID,
		Summary: summary,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, ht)
}

func UpdateHouseTab(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Name         *string `json:"name"`
		Notes        *string `json:"notes"`
		ContactPhone *string `json:"contact_phone"`
		IsActive     *bool   `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "house_tabs.update", "id", id)
	tx := appctx.Tx(r.Context())
	var ht HouseTab
	err = tx.QueryRow(r.Context(), `
		UPDATE house_tabs
		SET name          = COALESCE($2, name),
		    notes         = COALESCE($3, notes),
		    contact_phone = COALESCE($4, contact_phone),
		    is_active     = COALESCE($5, is_active),
		    archived_at = CASE
		      WHEN $5 IS NOT NULL AND $5 = false AND archived_at IS NULL THEN now()
		      WHEN $5 IS NOT NULL AND $5 = true THEN NULL
		      ELSE archived_at
		    END
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, notes, contact_phone, is_active, created_at, archived_at
	`, id, body.Name, body.Notes, body.ContactPhone, body.IsActive).Scan(
		&ht.ID, &ht.Name, &ht.Notes, &ht.ContactPhone, &ht.IsActive, &ht.CreatedAt, &ht.ArchivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "name_taken", "a house tab with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	action := "update"
	verb := "updated"
	if body.IsActive != nil && !*body.IsActive {
		action = "update"
		verb = "archived"
	} else if body.IsActive != nil && *body.IsActive {
		verb = "reactivated"
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: action, Entity: "house_tab", EntityID: &ht.ID,
		Summary: fmt.Sprintf("%s house tab %s", verb, audit.Quote(ht.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ht)
}

func DeleteHouseTab(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "house_tabs.delete", "id", id)
	tx := appctx.Tx(r.Context())

	// Refuse to delete a house tab that still has an outstanding balance.
	// Soft-delete only — the FK from payments.house_tab_id is RESTRICT, so
	// historical charges keep the row alive even if there's no balance left.
	var balance int64
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE((SELECT SUM(amount_cents) FROM payments WHERE house_tab_id = $1 AND method = 'house_tab'), 0)
		  - COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements WHERE house_tab_id = $1), 0)
	`, id).Scan(&balance); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if balance != 0 {
		writeErr(w, http.StatusConflict, "balance_outstanding",
			"settle the tab to a zero balance before deleting; or archive it instead")
		return
	}
	var name string
	if err := tx.QueryRow(r.Context(),
		`UPDATE house_tabs SET deleted_at = now()
		 WHERE id = $1 AND deleted_at IS NULL RETURNING name`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "house_tab", EntityID: &id,
		Summary: fmt.Sprintf("deleted house tab %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// POST settlement — record cash/online payment toward a house tab.
// =========================================================================

func CreateHouseTabSettlement(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		AmountCents   int64  `json:"amount_cents"`
		PaymentMethod string `json:"payment_method"`
		ReferenceNo   string `json:"reference_no"`
		Notes         string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.AmountCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents > 0 required")
		return
	}
	body.PaymentMethod = strings.ToLower(strings.TrimSpace(body.PaymentMethod))
	if body.PaymentMethod == "online" {
		body.PaymentMethod = "other"
	}
	switch body.PaymentMethod {
	// cash → drawer/cash account; other (online) → online account;
	// bank → bank account. accounts.go folds each into its bucket by method.
	case "cash", "bank", "esewa", "khalti", "card", "other":
	default:
		writeErr(w, http.StatusBadRequest, "bad_method",
			"payment_method must be cash|online|bank (or eSewa/Khalti/card for legacy)")
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "house_tabs.create_settlement",
		"id", id,
		"amount_cents", body.AmountCents,
		"payment_method", body.PaymentMethod)

	tx := appctx.Tx(r.Context())

	// Validate tab exists.
	var exists int
	if err := tx.QueryRow(r.Context(),
		`SELECT 1 FROM house_tabs WHERE id = $1 AND deleted_at IS NULL`, id,
	).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Reject overpayment — a settlement that would push the balance
	// negative is almost always a mistake (typo in the count or a
	// stale page) and there's no "give change back" workflow here.
	var balance int64
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE((SELECT SUM(amount_cents) FROM payments WHERE house_tab_id = $1 AND method = 'house_tab'), 0)
		  - COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements WHERE house_tab_id = $1), 0)
	`, id).Scan(&balance); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if body.AmountCents > balance {
		writeErr(w, http.StatusConflict, "overpayment",
			"amount exceeds outstanding balance ("+formatPaisa(balance)+
				"). enter the remaining amount or less.")
		return
	}

	// Stamp the settlement with the open shift when there is one, so the
	// day's live drawer reconciliation includes cash settlements. When no
	// shift is open we still record it (shift_id NULL): the amount lands in
	// the cash/online/bank account balance regardless of shift — it just
	// isn't attributed to a drawer session.
	shiftID, err := findOpenShiftID(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var shiftPtr *uuid.UUID
	if shiftID != uuid.Nil {
		shiftPtr = &shiftID
	}

	var s HouseTabSettlement
	err = tx.QueryRow(r.Context(), `
		INSERT INTO house_tab_settlements
		  (tenant_id, house_tab_id, amount_cents, payment_method, reference_no, notes, recorded_by_user_id, shift_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, amount_cents, payment_method::text, reference_no, notes, recorded_at
	`, t.ID, id, body.AmountCents, body.PaymentMethod, body.ReferenceNo, body.Notes, user.ID, shiftPtr).Scan(
		&s.ID, &s.AmountCents, &s.PaymentMethod, &s.ReferenceNo, &s.Notes, &s.RecordedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "settle", Entity: "house_tab", EntityID: &id,
		Summary: fmt.Sprintf("settled %s on house tab (%s)",
			audit.Money(body.AmountCents), body.PaymentMethod),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, s)
}
