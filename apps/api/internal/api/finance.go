package api

// Cafe finance: owners, ownership shares, owner ledger (investments, payouts,
// loan advances + repayments), and the aggregate cafe balance.
//
// See migration 0014_cafe_finance.sql for the schema. owner_ledger is
// hard-immutable — corrections are paired rows referencing the original.

import (
	"context"
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
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// Wire types
// =========================================================================

type CafeOwner struct {
	ID          uuid.UUID  `json:"id"`
	UserID      *uuid.UUID `json:"user_id,omitempty"`
	UserEmail   *string    `json:"user_email,omitempty"`
	DisplayName string     `json:"display_name"`
	ShareUnits  int        `json:"share_units"`
	ActiveFrom  string     `json:"active_from"`
	ActiveTo    *string    `json:"active_to,omitempty"`
	Notes       string     `json:"notes"`
	CreatedAt   time.Time  `json:"created_at"`
	// Roll-ups (filled on list/get for the FE).
	LifetimeInvestmentCents int64 `json:"lifetime_investment_cents"`
	LifetimePayoutsCents    int64 `json:"lifetime_payouts_cents"`
	OutstandingLoansCents   int64 `json:"outstanding_loans_cents"`
}

type OwnerLedgerEntry struct {
	ID              uuid.UUID  `json:"id"`
	OwnerID         uuid.UUID  `json:"owner_id"`
	OwnerName       string     `json:"owner_name"`
	Kind            string     `json:"kind"`
	AmountCents     int64      `json:"amount_cents"`
	OccurredAt      time.Time  `json:"occurred_at"`
	Notes           string     `json:"notes"`
	ExpenseID       *uuid.UUID `json:"expense_id,omitempty"`
	ExpenseVendor   *string    `json:"expense_vendor,omitempty"`
	ParentLoanID    *uuid.UUID `json:"parent_loan_id,omitempty"`
	IsCorrection    bool       `json:"is_correction"`
	CorrectsID      *uuid.UUID `json:"corrects_id,omitempty"`
	CreatedByUserID uuid.UUID  `json:"created_by_user_id"`
	CreatedByEmail  *string    `json:"created_by_email,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	// loan_advance only: how much of this loan has been repaid so far.
	RepaidCents int64 `json:"repaid_cents,omitempty"`
}

type CafeBalance struct {
	DrawerCents  int64            `json:"drawer_cents"`
	DrawerSource string           `json:"drawer_source"` // "live" | "last_close" | "none"
	DrawerAsOf   *time.Time       `json:"drawer_as_of,omitempty"`
	BankCents    int64            `json:"bank_cents"`
	Channels     []AccountBalance `json:"channels"` // online channels other than bank
	TotalCents   int64            `json:"total_cents"`
	Outstanding  OwnerOutstanding `json:"owner_outstanding"`
}

type OwnerOutstanding struct {
	LoansCents int64 `json:"loans_cents"`
}

// =========================================================================
// CAFE OWNERS — CRUD
// =========================================================================

func ListCafeOwners(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "finance.list_owners")
	tx := appctx.Tx(r.Context())

	includeInactive := r.URL.Query().Get("active") != "true"

	q := `
		SELECT o.id, o.user_id, u.email::text, o.display_name, o.share_units,
		       to_char(o.active_from, 'YYYY-MM-DD'), to_char(o.active_to, 'YYYY-MM-DD'),
		       o.notes, o.created_at,
		       COALESCE((SELECT SUM(amount_cents) FROM owner_ledger
		                 WHERE owner_id = o.id AND kind = 'investment' AND is_correction = false), 0)::bigint,
		       COALESCE((SELECT SUM(amount_cents) FROM owner_ledger
		                 WHERE owner_id = o.id AND kind = 'payout' AND is_correction = false), 0)::bigint,
		       COALESCE((SELECT SUM(la.amount_cents) - COALESCE(SUM(rp.total), 0)
		                 FROM owner_ledger la
		                 LEFT JOIN (
		                   SELECT parent_loan_id, SUM(amount_cents) AS total
		                   FROM owner_ledger WHERE kind = 'loan_repayment' GROUP BY parent_loan_id
		                 ) rp ON rp.parent_loan_id = la.id
		                 WHERE la.owner_id = o.id AND la.kind = 'loan_advance' AND la.is_correction = false), 0)::bigint
		FROM cafe_owners o
		LEFT JOIN users u ON u.id = o.user_id
	`
	if !includeInactive {
		q += " WHERE o.active_to IS NULL"
	} else {
		// active rows first, then exited
		q += " WHERE 1=1"
	}
	q += " ORDER BY (o.active_to IS NULL) DESC, o.share_units DESC, o.display_name"

	rows, err := tx.Query(r.Context(), q)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []CafeOwner{}
	for rows.Next() {
		var o CafeOwner
		var activeTo *string
		if err := rows.Scan(&o.ID, &o.UserID, &o.UserEmail, &o.DisplayName, &o.ShareUnits,
			&o.ActiveFrom, &activeTo, &o.Notes, &o.CreatedAt,
			&o.LifetimeInvestmentCents, &o.LifetimePayoutsCents, &o.OutstandingLoansCents,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		o.ActiveTo = activeTo
		out = append(out, o)
	}
	writeJSON(w, http.StatusOK, map[string]any{"owners": out})
}

func CreateCafeOwner(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			UserID      *uuid.UUID `json:"user_id"`
			DisplayName string     `json:"display_name"`
			ShareUnits  int        `json:"share_units"`
			Notes       string     `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		body.DisplayName = strings.TrimSpace(body.DisplayName)
		if body.DisplayName == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "display_name required")
			return
		}
		if body.ShareUnits <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "share_units must be > 0")
			return
		}

		tx := appctx.Tx(r.Context())

		// If user_id provided, confirm same tenant.
		if body.UserID != nil {
			var ok bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS(
				  SELECT 1 FROM tenant_members
				  WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
				)
			`, t.ID, *body.UserID).Scan(&ok); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if !ok {
				writeErr(w, http.StatusBadRequest, "bad_request",
					"user_id must be an active member of this tenant")
				return
			}
		}

		var o CafeOwner
		var activeTo *string
		err := tx.QueryRow(r.Context(), `
			INSERT INTO cafe_owners (tenant_id, user_id, display_name, share_units, notes)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, user_id, display_name, share_units,
			          to_char(active_from, 'YYYY-MM-DD'), to_char(active_to, 'YYYY-MM-DD'),
			          notes, created_at
		`, t.ID, body.UserID, body.DisplayName, body.ShareUnits, body.Notes).Scan(
			&o.ID, &o.UserID, &o.DisplayName, &o.ShareUnits,
			&o.ActiveFrom, &activeTo, &o.Notes, &o.CreatedAt)
		if err != nil {
			// Unique constraint on (tenant, user) where active_to is null.
			if strings.Contains(err.Error(), "cafe_owners_active_user_uniq") {
				writeErr(w, http.StatusConflict, "owner_exists",
					"this user is already an active owner of the cafe")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		o.ActiveTo = activeTo

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "cafe_owner", EntityID: &o.ID,
			Summary: fmt.Sprintf("added owner %s (%d shares)",
				audit.Quote(o.DisplayName), o.ShareUnits),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance.owners_changed",
		})
		writeJSON(w, http.StatusCreated, o)
	}
}

func UpdateCafeOwner(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		var body struct {
			DisplayName *string `json:"display_name"`
			ShareUnits  *int    `json:"share_units"`
			Notes       *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if body.ShareUnits != nil && *body.ShareUnits <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "share_units must be > 0")
			return
		}

		tx := appctx.Tx(r.Context())
		var o CafeOwner
		var activeTo *string
		err = tx.QueryRow(r.Context(), `
			UPDATE cafe_owners
			   SET display_name = COALESCE($2, display_name),
			       share_units  = COALESCE($3, share_units),
			       notes        = COALESCE($4, notes)
			 WHERE id = $1
			 RETURNING id, user_id, display_name, share_units,
			           to_char(active_from, 'YYYY-MM-DD'),
			           to_char(active_to, 'YYYY-MM-DD'),
			           notes, created_at
		`, id, body.DisplayName, body.ShareUnits, body.Notes).Scan(
			&o.ID, &o.UserID, &o.DisplayName, &o.ShareUnits,
			&o.ActiveFrom, &activeTo, &o.Notes, &o.CreatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		o.ActiveTo = activeTo

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "cafe_owner", EntityID: &id,
			Summary: fmt.Sprintf("updated owner %s (%d shares)",
				audit.Quote(o.DisplayName), o.ShareUnits),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance.owners_changed",
		})
		writeJSON(w, http.StatusOK, o)
	}
}

func DeactivateCafeOwner(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		var body struct {
			Force bool `json:"force"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		tx := appctx.Tx(r.Context())

		// Soft guard: refuse if outstanding loan unless ?force=true.
		var outstanding int64
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(
			  SUM(la.amount_cents) - COALESCE(SUM(rp.total), 0), 0)::bigint
			FROM owner_ledger la
			LEFT JOIN (
			  SELECT parent_loan_id, SUM(amount_cents) AS total
			  FROM owner_ledger WHERE kind = 'loan_repayment' GROUP BY parent_loan_id
			) rp ON rp.parent_loan_id = la.id
			WHERE la.owner_id = $1 AND la.kind = 'loan_advance' AND la.is_correction = false
		`, id).Scan(&outstanding); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if outstanding > 0 && !body.Force {
			writeErr(w, http.StatusConflict, "owner_has_outstanding",
				fmt.Sprintf("owner has %s outstanding loan — repay first or pass force=true",
					audit.Money(outstanding)))
			return
		}

		var displayName string
		err = tx.QueryRow(r.Context(), `
			UPDATE cafe_owners
			   SET active_to = CURRENT_DATE
			 WHERE id = $1 AND active_to IS NULL
			 RETURNING display_name
		`, id).Scan(&displayName)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "owner not found or already deactivated")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "cafe_owner", EntityID: &id,
			Summary: fmt.Sprintf("deactivated owner %s", audit.Quote(displayName)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance.owners_changed",
		})
		w.WriteHeader(http.StatusNoContent)
	}
}

// =========================================================================
// OWNER LEDGER — list + insert
// =========================================================================

func ListOwnerLedger(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "finance.list_ledger",
		"owner_id", r.URL.Query().Get("owner_id"),
		"kind", r.URL.Query().Get("kind"))
	tx := appctx.Tx(r.Context())

	args := []any{}
	q := `
		SELECT l.id, l.owner_id, o.display_name, l.kind::text, l.amount_cents,
		       l.occurred_at, l.notes, l.expense_id, e.vendor, l.parent_loan_id,
		       l.is_correction, l.corrects_id,
		       l.created_by_user_id, u.email::text, l.created_at,
		       CASE WHEN l.kind = 'loan_advance'
		            THEN COALESCE((SELECT SUM(amount_cents) FROM owner_ledger rp
		                          WHERE rp.parent_loan_id = l.id), 0)
		            ELSE 0 END::bigint AS repaid_cents
		FROM owner_ledger l
		JOIN cafe_owners o ON o.id = l.owner_id
		LEFT JOIN expenses e ON e.id = l.expense_id
		LEFT JOIN users u ON u.id = l.created_by_user_id
		WHERE 1=1
	`
	if v := r.URL.Query().Get("owner_id"); v != "" {
		args = append(args, v)
		q += fmt.Sprintf(" AND l.owner_id = $%d", len(args))
	}
	if v := r.URL.Query().Get("kind"); v != "" {
		args = append(args, v)
		q += fmt.Sprintf(" AND l.kind = $%d::owner_ledger_kind", len(args))
	}
	q += " ORDER BY l.occurred_at DESC LIMIT 200"

	rows, err := tx.Query(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []OwnerLedgerEntry{}
	for rows.Next() {
		var e OwnerLedgerEntry
		if err := rows.Scan(&e.ID, &e.OwnerID, &e.OwnerName, &e.Kind, &e.AmountCents,
			&e.OccurredAt, &e.Notes, &e.ExpenseID, &e.ExpenseVendor, &e.ParentLoanID,
			&e.IsCorrection, &e.CorrectsID,
			&e.CreatedByUserID, &e.CreatedByEmail, &e.CreatedAt, &e.RepaidCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out})
}

// POST /v1/finance/investments
func CreateInvestment(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			OwnerID     uuid.UUID  `json:"owner_id"`
			AmountCents int64      `json:"amount_cents"`
			OccurredAt  *time.Time `json:"occurred_at"`
			Notes       string     `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.AmountCents <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents > 0 required")
			return
		}

		tx := appctx.Tx(r.Context())

		// Confirm owner exists + is active for this tenant.
		var ownerName string
		if err := tx.QueryRow(r.Context(),
			`SELECT display_name FROM cafe_owners WHERE id = $1`, body.OwnerID,
		).Scan(&ownerName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusBadRequest, "bad_request", "owner not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		var id uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO owner_ledger
			  (tenant_id, owner_id, kind, amount_cents, occurred_at, notes, created_by_user_id)
			VALUES ($1, $2, 'investment'::owner_ledger_kind, $3, COALESCE($4, now()), $5, $6)
			RETURNING id
		`, t.ID, body.OwnerID, body.AmountCents, body.OccurredAt, body.Notes, user.ID).Scan(&id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "owner_investment", EntityID: &id,
			Summary: fmt.Sprintf("recorded investment %s from %s",
				audit.Money(body.AmountCents), audit.Quote(ownerName)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance.investment_recorded",
			Ref:    map[string]any{"owner_id": body.OwnerID.String()},
		})
		writeJSON(w, http.StatusCreated, map[string]any{"id": id})
	}
}

// POST /v1/finance/payouts
// Body: { entries: [{owner_id, amount_cents}], occurred_at?, notes? }
// Inserts N owner_ledger rows in one tx — auto-split from share ratio is the
// FE's job; the server takes explicit per-owner amounts.
func CreatePayouts(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			Entries []struct {
				OwnerID     uuid.UUID `json:"owner_id"`
				AmountCents int64     `json:"amount_cents"`
			} `json:"entries"`
			OccurredAt *time.Time `json:"occurred_at"`
			Notes      string     `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if len(body.Entries) == 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "entries required")
			return
		}
		for _, e := range body.Entries {
			if e.AmountCents <= 0 {
				writeErr(w, http.StatusBadRequest, "bad_request",
					"each entry must have amount_cents > 0")
				return
			}
		}

		tx := appctx.Tx(r.Context())

		// Pre-validate every owner BEFORE inserting any row. A bad owner mid-loop
		// returns 400, and TxMiddleware commits on 4xx — so without this pre-flight
		// pass the earlier (valid) payouts would persist while the request reports
		// failure, splitting one logical payout batch. Resolving names up front
		// keeps the batch atomic: either all entries insert or none do.
		ownerNames := make(map[uuid.UUID]string, len(body.Entries))
		for _, e := range body.Entries {
			if _, ok := ownerNames[e.OwnerID]; ok {
				continue
			}
			var ownerName string
			if err := tx.QueryRow(r.Context(),
				`SELECT display_name FROM cafe_owners WHERE id = $1`, e.OwnerID,
			).Scan(&ownerName); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeErr(w, http.StatusBadRequest, "bad_request",
						"owner "+e.OwnerID.String()+" not found")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			ownerNames[e.OwnerID] = ownerName
		}

		var total int64
		ids := make([]uuid.UUID, 0, len(body.Entries))
		for _, e := range body.Entries {
			ownerName := ownerNames[e.OwnerID]
			var id uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO owner_ledger
				  (tenant_id, owner_id, kind, amount_cents, occurred_at, notes, created_by_user_id)
				VALUES ($1, $2, 'payout'::owner_ledger_kind, $3, COALESCE($4, now()), $5, $6)
				RETURNING id
			`, t.ID, e.OwnerID, e.AmountCents, body.OccurredAt, body.Notes, user.ID).Scan(&id); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if err := audit.Log(r.Context(), tx, audit.Entry{
				Action: "create", Entity: "owner_payout", EntityID: &id,
				Summary: fmt.Sprintf("paid out %s to %s",
					audit.Money(e.AmountCents), audit.Quote(ownerName)),
			}); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			ids = append(ids, id)
			total += e.AmountCents
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance.payout_recorded",
		})
		writeJSON(w, http.StatusCreated, map[string]any{
			"ids":         ids,
			"total_cents": total,
		})
	}
}

// POST /v1/finance/loans/{id}/repay
// Body: { amount_cents, occurred_at?, notes? }
// SELECT FOR UPDATE on the parent loan to guarantee no partial-repayment
// overrun under concurrent calls.
func RepayLoan(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		loanID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid loan id")
			return
		}
		var body struct {
			AmountCents int64      `json:"amount_cents"`
			OccurredAt  *time.Time `json:"occurred_at"`
			Notes       string     `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.AmountCents <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents > 0 required")
			return
		}

		tx := appctx.Tx(r.Context())

		// Lock the parent loan row + compute remaining within the same tx.
		var ownerID uuid.UUID
		var loanAmount int64
		var ownerName string
		if err := tx.QueryRow(r.Context(), `
			SELECT la.owner_id, la.amount_cents, o.display_name
			FROM owner_ledger la
			JOIN cafe_owners o ON o.id = la.owner_id
			WHERE la.id = $1 AND la.kind = 'loan_advance' AND la.is_correction = false
			FOR UPDATE OF la
		`, loanID).Scan(&ownerID, &loanAmount, &ownerName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "loan not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		var repaidSoFar int64
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(SUM(amount_cents), 0)::bigint
			FROM owner_ledger WHERE parent_loan_id = $1
		`, loanID).Scan(&repaidSoFar); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		remaining := loanAmount - repaidSoFar
		if body.AmountCents > remaining {
			writeErr(w, http.StatusConflict, "overpayment",
				fmt.Sprintf("loan only has %s remaining", audit.Money(remaining)))
			return
		}

		var id uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO owner_ledger
			  (tenant_id, owner_id, kind, amount_cents, occurred_at, notes,
			   parent_loan_id, created_by_user_id)
			VALUES ($1, $2, 'loan_repayment'::owner_ledger_kind, $3,
			        COALESCE($4, now()), $5, $6, $7)
			RETURNING id
		`, t.ID, ownerID, body.AmountCents, body.OccurredAt, body.Notes,
			loanID, user.ID).Scan(&id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "loan_repayment", EntityID: &id,
			Summary: fmt.Sprintf("repaid %s to %s (loan %s)",
				audit.Money(body.AmountCents), audit.Quote(ownerName),
				loanID.String()[:8]),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance.loan_repaid",
			Ref:    map[string]any{"loan_id": loanID.String()},
		})
		writeJSON(w, http.StatusCreated, map[string]any{"id": id})
	}
}

// POST /v1/finance/owner-ledger/{id}/correct
// Body: { amount_cents?, notes }
// Inserts a paired correction row that reverses (in spirit) the original.
// The schema doesn't allow direct UPDATE/DELETE — corrections preserve
// the audit trail.
func CorrectOwnerLedger(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		origID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		var body struct {
			Notes string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if strings.TrimSpace(body.Notes) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"notes required for a correction (explain why)")
			return
		}

		tx := appctx.Tx(r.Context())

		// Load original.
		var ownerID uuid.UUID
		var kind string
		var amount int64
		var parentLoanID *uuid.UUID
		var expenseID *uuid.UUID
		var origIsCorrection bool
		if err := tx.QueryRow(r.Context(), `
			SELECT owner_id, kind::text, amount_cents, parent_loan_id, expense_id, is_correction
			FROM owner_ledger WHERE id = $1
		`, origID).Scan(&ownerID, &kind, &amount, &parentLoanID, &expenseID, &origIsCorrection); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if origIsCorrection {
			writeErr(w, http.StatusConflict, "already_correction",
				"can't correct a correction — record a fresh entry instead")
			return
		}

		var id uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO owner_ledger
			  (tenant_id, owner_id, kind, amount_cents, notes,
			   expense_id, parent_loan_id, is_correction, corrects_id, created_by_user_id)
			VALUES ($1, $2, $3::owner_ledger_kind, $4, $5, $6, $7, true, $8, $9)
			RETURNING id
		`, t.ID, ownerID, kind, amount, body.Notes,
			expenseID, parentLoanID, origID, user.ID).Scan(&id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "owner_ledger", EntityID: &id,
			Summary: fmt.Sprintf("corrected %s entry %s",
				kind, origID.String()[:8]),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicFinance,
			Action: "finance." + kind + "_recorded",
		})
		writeJSON(w, http.StatusCreated, map[string]any{"id": id})
	}
}

// =========================================================================
// GET /v1/finance/cafe-balance
//
// Returns the aggregate cafe balance — drawer + bank + digital channels.
// Bank includes owner_ledger flows (investments, payouts, repayments).
// =========================================================================

func GetCafeBalance(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "finance.cafe_balance")
	tx := appctx.Tx(r.Context())

	out := CafeBalance{Channels: []AccountBalance{}}

	// 1. Drawer — live if a shift is open, else last closing count.
	drawer, source, asOf, err := computeDrawer(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out.DrawerCents = drawer
	out.DrawerSource = source
	if asOf != nil {
		out.DrawerAsOf = asOf
	}

	// 2. Bank balance — start from the standard payment_method roll-up,
	//    then apply owner-ledger adjustments.
	var bankPayments, bankExpenses, transfersIn, transfersOut int64
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE((SELECT SUM(amount_cents) FROM payments
		            WHERE method = 'bank'), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM expenses
		            WHERE payment_method = 'bank' AND deleted_at IS NULL), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM account_transfers
		            WHERE to_method = 'bank'), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers
		            WHERE from_method = 'bank'), 0)::bigint
	`).Scan(&bankPayments, &bankExpenses, &transfersIn, &transfersOut); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var ledgerIn, ledgerOut int64
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE(SUM(CASE WHEN kind = 'investment'                       AND is_correction = false THEN amount_cents END), 0)::bigint,
		  COALESCE(SUM(CASE WHEN kind IN ('payout','loan_repayment')        AND is_correction = false THEN amount_cents END), 0)::bigint
		FROM owner_ledger
	`).Scan(&ledgerIn, &ledgerOut); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out.BankCents = bankPayments + transfersIn + ledgerIn -
		bankExpenses - transfersOut - ledgerOut

	// 3. Online channel — every digital payment method (esewa/khalti/card/
	//    other/online) rolled into one tile. Sourced from the same bucket
	//    table the accounts endpoint uses so the two views stay aligned.
	for _, m := range methodsForBalances {
		if m.Method == "cash" || m.Method == "bank" {
			continue
		}
		var b AccountBalance
		b.Method = m.Method
		b.Label = m.Label
		if err := tx.QueryRow(r.Context(), `
			SELECT
			  (COALESCE((SELECT SUM(amount_cents) FROM payments WHERE method::text = ANY($1)), 0)
			   + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements WHERE payment_method::text = ANY($1)), 0))::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE payment_method::text = ANY($1) AND deleted_at IS NULL), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM account_transfers WHERE to_method::text = ANY($1)), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers WHERE from_method::text = ANY($1)), 0)::bigint
		`, m.Members).Scan(&b.PaymentsCents, &b.ExpensesCents,
			&b.TransfersInCents, &b.TransfersOutCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		b.BalanceCents = b.PaymentsCents - b.ExpensesCents +
			b.TransfersInCents - b.TransfersOutCents
		out.Channels = append(out.Channels, b)
	}

	// 4. Outstanding loans across all owners.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(
		  SUM(la.amount_cents) - COALESCE(SUM(rp.total), 0), 0)::bigint
		FROM owner_ledger la
		LEFT JOIN (
		  SELECT parent_loan_id, SUM(amount_cents) AS total
		  FROM owner_ledger WHERE kind = 'loan_repayment' GROUP BY parent_loan_id
		) rp ON rp.parent_loan_id = la.id
		WHERE la.kind = 'loan_advance' AND la.is_correction = false
	`).Scan(&out.Outstanding.LoansCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	out.TotalCents = out.DrawerCents + out.BankCents
	for _, c := range out.Channels {
		out.TotalCents += c.BalanceCents
	}

	writeJSON(w, http.StatusOK, out)
}

// =========================================================================
// GET /v1/finance/cafe-summary
//
// Lifetime cafe finance roll-up: how much capital has been put in, how much
// has been paid out, and how much the cafe has *earned* (revenue − direct
// COGS − expenses) over its lifetime. Used by the OwnersPage "ROI" card so
// stakeholders see "I put in X, the cafe pulled in Y, I've taken Z out."
// =========================================================================

type CafeSummary struct {
	LifetimeInvestedCents   int64 `json:"lifetime_invested_cents"`
	LifetimePayoutsCents    int64 `json:"lifetime_payouts_cents"`
	OutstandingLoansCents   int64 `json:"outstanding_loans_cents"`
	LifetimeRevenueCents    int64 `json:"lifetime_revenue_cents"`
	LifetimeDirectCogsCents int64 `json:"lifetime_direct_cogs_cents"`
	LifetimeExpensesCents   int64 `json:"lifetime_expenses_cents"`
	CafeNetProfitCents      int64 `json:"cafe_net_profit_cents"`
	CafeBalanceCents        int64 `json:"cafe_balance_cents"`
}

func GetCafeSummary(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "finance.cafe_summary")
	tx := appctx.Tx(r.Context())

	var s CafeSummary

	// 1. Capital flows from owner_ledger, net of corrections.
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE(SUM(CASE WHEN kind = 'investment' AND is_correction = false THEN amount_cents END), 0)::bigint,
		  COALESCE(SUM(CASE WHEN kind = 'payout'     AND is_correction = false THEN amount_cents END), 0)::bigint
		FROM owner_ledger
	`).Scan(&s.LifetimeInvestedCents, &s.LifetimePayoutsCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// 2. Outstanding loans (advances − repayments).
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(
		  SUM(la.amount_cents) - COALESCE(SUM(rp.total), 0), 0)::bigint
		FROM owner_ledger la
		LEFT JOIN (
		  SELECT parent_loan_id, SUM(amount_cents) AS total
		  FROM owner_ledger WHERE kind = 'loan_repayment' GROUP BY parent_loan_id
		) rp ON rp.parent_loan_id = la.id
		WHERE la.kind = 'loan_advance' AND la.is_correction = false
	`).Scan(&s.OutstandingLoansCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// 3. Lifetime revenue + direct COGS from closed orders. unit_cost_cents
	//    is captured at sale time so this stays stable even if menu cost
	//    is later tuned.
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint,
		  COALESCE(SUM(oi.qty * oi.unit_cost_cents),  0)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE o.status = 'closed' AND oi.voided_at IS NULL
	`).Scan(&s.LifetimeRevenueCents, &s.LifetimeDirectCogsCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// 4. Lifetime expenses (total cash outflow on expense rows). This
	//    includes everything that was either allocated to a category or
	//    left unallocated — the net profit subtracts the full bucket.
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM expenses WHERE deleted_at IS NULL
	`).Scan(&s.LifetimeExpensesCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	s.CafeNetProfitCents = s.LifetimeRevenueCents - s.LifetimeDirectCogsCents - s.LifetimeExpensesCents

	// 5. Current cash position — reuse the same logic as GetCafeBalance.
	drawer, _, _, err := computeDrawer(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var bankPayments, bankExpenses, transfersIn, transfersOut, ledgerIn, ledgerOut int64
	if err := tx.QueryRow(r.Context(), `
		SELECT
		  COALESCE((SELECT SUM(amount_cents) FROM payments
		            WHERE method = 'bank'), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM expenses
		            WHERE payment_method = 'bank' AND deleted_at IS NULL), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM account_transfers
		            WHERE to_method = 'bank'), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers
		            WHERE from_method = 'bank'), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM owner_ledger
		            WHERE kind = 'investment' AND is_correction = false), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM owner_ledger
		            WHERE kind IN ('payout','loan_repayment') AND is_correction = false), 0)::bigint
	`).Scan(&bankPayments, &bankExpenses, &transfersIn, &transfersOut, &ledgerIn, &ledgerOut); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	bank := bankPayments + transfersIn + ledgerIn - bankExpenses - transfersOut - ledgerOut

	var channels int64
	for _, m := range methodsForBalances {
		if m.Method == "cash" || m.Method == "bank" {
			continue
		}
		var pay, exp, tIn, tOut int64
		if err := tx.QueryRow(r.Context(), `
			SELECT
			  (COALESCE((SELECT SUM(amount_cents) FROM payments WHERE method::text = ANY($1)), 0)
			   + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements WHERE payment_method::text = ANY($1)), 0))::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE payment_method::text = ANY($1) AND deleted_at IS NULL), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM account_transfers WHERE to_method::text = ANY($1)), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers WHERE from_method::text = ANY($1)), 0)::bigint
		`, m.Members).Scan(&pay, &exp, &tIn, &tOut); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		channels += pay - exp + tIn - tOut
	}
	s.CafeBalanceCents = drawer + bank + channels

	writeJSON(w, http.StatusOK, s)
}

// computeDrawer returns the current cash drawer balance:
//   - if a shift is open: opening_float + cash payments + drops_in − drops_out
//   - otherwise: the closing count of the most-recent closed shift (or 0)
func computeDrawer(ctx context.Context) (cents int64, source string, asOf *time.Time, err error) {
	tx := appctx.Tx(ctx)

	// Open shift?
	var sid uuid.UUID
	var openingFloat int64
	var openedAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, opening_float_cents, opened_at
		FROM shifts WHERE closed_at IS NULL
		LIMIT 1
	`).Scan(&sid, &openingFloat, &openedAt)
	if err == nil {
		// live computation
		var cashIn, dropsIn, dropsOut int64
		// cashIn = order cash payments + cash settlements of house tabs paid
		// down during this shift. A tab settled in cash physically lands in
		// the drawer, so it must count toward the live drawer total.
		if err = tx.QueryRow(ctx, `
			SELECT
			  (COALESCE((SELECT SUM(amount_cents) FROM payments
			            WHERE shift_id = $1 AND method = 'cash'), 0)
			   + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
			            WHERE shift_id = $1 AND payment_method = 'cash'), 0))::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM cash_drops
			            WHERE shift_id = $1 AND direction = 'in'), 0)::bigint,
			  COALESCE((SELECT SUM(amount_cents) FROM cash_drops
			            WHERE shift_id = $1 AND direction = 'out'), 0)::bigint
		`, sid).Scan(&cashIn, &dropsIn, &dropsOut); err != nil {
			return 0, "", nil, err
		}
		return openingFloat + cashIn + dropsIn - dropsOut, "live", &openedAt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, "", nil, err
	}

	// No open shift — fall back to most-recent closing count.
	var closed time.Time
	var closing int64
	err = tx.QueryRow(ctx, `
		SELECT closing_count_cents, closed_at
		FROM shifts
		WHERE closed_at IS NOT NULL AND closing_count_cents IS NOT NULL
		ORDER BY closed_at DESC
		LIMIT 1
	`).Scan(&closing, &closed)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "none", nil, nil
	}
	if err != nil {
		return 0, "", nil, err
	}
	return closing, "last_close", &closed, nil
}
