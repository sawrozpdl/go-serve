package api

import (
	"context"
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
// Wire types
// =========================================================================

type Shift struct {
	ID                  uuid.UUID  `json:"id"`
	OpenedByUserID      uuid.UUID  `json:"opened_by_user_id"`
	OpenedByEmail       *string    `json:"opened_by_email,omitempty"`
	OpenedAt            time.Time  `json:"opened_at"`
	OpeningFloatCents   int64      `json:"opening_float_cents"`
	ClosedByUserID      *uuid.UUID `json:"closed_by_user_id,omitempty"`
	ClosedAt            *time.Time `json:"closed_at,omitempty"`
	ClosingCountCents   *int64     `json:"closing_count_cents,omitempty"`
	ExpectedCashCents   *int64     `json:"expected_cash_cents,omitempty"`
	VarianceCents       *int64     `json:"variance_cents,omitempty"`
	Notes               string     `json:"notes"`
	// Computed at read-time for an open shift (so the FE can show a live
	// "expected cash" while the user counts the drawer).
	LiveExpectedCashCents int64 `json:"live_expected_cash_cents"`
	LiveCashCount         int64 `json:"live_cash_count_cents"`
}

// =========================================================================
// helpers
// =========================================================================

// findOpenShiftID returns the id of the currently-open shift for the
// active tenant, or uuid.Nil if none. Used by RecordPayment to gate cash.
func findOpenShiftID(ctx context.Context) (uuid.UUID, error) {
	tx := appctx.Tx(ctx)
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil
	}
	return id, err
}

// loadShift loads a shift row + email of opener (and computes live cash
// totals when the shift is still open).
func loadShift(ctx context.Context, id uuid.UUID) (Shift, error) {
	tx := appctx.Tx(ctx)
	var s Shift
	err := tx.QueryRow(ctx, `
		SELECT s.id, s.opened_by_user_id, u.email::text, s.opened_at, s.opening_float_cents,
		       s.closed_by_user_id, s.closed_at, s.closing_count_cents, s.expected_cash_cents,
		       s.variance_cents, s.notes
		FROM shifts s
		LEFT JOIN users u ON u.id = s.opened_by_user_id
		WHERE s.id = $1
	`, id).Scan(&s.ID, &s.OpenedByUserID, &s.OpenedByEmail, &s.OpenedAt, &s.OpeningFloatCents,
		&s.ClosedByUserID, &s.ClosedAt, &s.ClosingCountCents, &s.ExpectedCashCents,
		&s.VarianceCents, &s.Notes)
	if err != nil {
		return s, err
	}
	// Live cash totals (open shifts use these; closed ones already have
	// expected_cash_cents persisted).
	if s.ClosedAt == nil {
		var cashIn int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(amount_cents), 0)::bigint
			FROM payments
			WHERE shift_id = $1 AND method = 'cash'
		`, id).Scan(&cashIn); err != nil {
			return s, err
		}
		s.LiveCashCount = cashIn
		s.LiveExpectedCashCents = s.OpeningFloatCents + cashIn
	} else {
		if s.ExpectedCashCents != nil {
			s.LiveExpectedCashCents = *s.ExpectedCashCents
		}
		if s.ClosingCountCents != nil {
			s.LiveCashCount = *s.ClosingCountCents - s.OpeningFloatCents
		}
	}
	return s, nil
}

// =========================================================================
// GET /v1/shifts/current
// =========================================================================

func GetCurrentShift(w http.ResponseWriter, r *http.Request) {
	id, err := findOpenShiftID(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if id == uuid.Nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	s, err := loadShift(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// =========================================================================
// POST /v1/shifts/open  { opening_float_cents, notes? }
// =========================================================================

func OpenShift(w http.ResponseWriter, r *http.Request) {
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		OpeningFloatCents int64  `json:"opening_float_cents"`
		Notes             string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OpeningFloatCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "opening_float_cents required (>=0)")
		return
	}
	tx := appctx.Tx(r.Context())

	var id uuid.UUID
	err := tx.QueryRow(r.Context(), `
		INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents, notes)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, t.ID, user.ID, body.OpeningFloatCents, body.Notes).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "shift_already_open",
				"a shift is already open — close it first")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	s, err := loadShift(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

// =========================================================================
// POST /v1/shifts/{id}/close  { closing_count_cents, notes? }
// =========================================================================

func CloseShift(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid shift id")
		return
	}
	user, _ := appctx.UserFromContext(r.Context())

	var body struct {
		ClosingCountCents int64  `json:"closing_count_cents"`
		Notes             string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ClosingCountCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "closing_count_cents required (>=0)")
		return
	}
	tx := appctx.Tx(r.Context())

	// Compute expected cash from the ledger.
	var openingFloat int64
	var alreadyClosed *time.Time
	if err := tx.QueryRow(r.Context(),
		`SELECT opening_float_cents, closed_at FROM shifts WHERE id = $1`, id,
	).Scan(&openingFloat, &alreadyClosed); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if alreadyClosed != nil {
		writeErr(w, http.StatusConflict, "already_closed", "shift is already closed")
		return
	}

	var cashIn int64
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM payments
		WHERE shift_id = $1 AND method = 'cash'
	`, id).Scan(&cashIn); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	expected := openingFloat + cashIn
	variance := body.ClosingCountCents - expected

	// Append notes to whatever was set on open.
	if _, err := tx.Exec(r.Context(), `
		UPDATE shifts
		SET closed_by_user_id = $2,
		    closed_at = now(),
		    closing_count_cents = $3,
		    expected_cash_cents = $4,
		    variance_cents = $5,
		    notes = CASE WHEN $6 = '' THEN notes ELSE
		      CASE WHEN notes = '' THEN $6 ELSE notes || E'\n' || $6 END
		    END
		WHERE id = $1
	`, id, user.ID, body.ClosingCountCents, expected, variance, body.Notes); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	s, err := loadShift(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// =========================================================================
// GET /v1/shifts  (history)
// =========================================================================

func ListShifts(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT s.id, s.opened_by_user_id, u.email::text, s.opened_at, s.opening_float_cents,
		       s.closed_by_user_id, s.closed_at, s.closing_count_cents, s.expected_cash_cents,
		       s.variance_cents, s.notes
		FROM shifts s
		LEFT JOIN users u ON u.id = s.opened_by_user_id
		ORDER BY s.opened_at DESC
		LIMIT 100
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []Shift{}
	for rows.Next() {
		var s Shift
		if err := rows.Scan(&s.ID, &s.OpenedByUserID, &s.OpenedByEmail, &s.OpenedAt,
			&s.OpeningFloatCents, &s.ClosedByUserID, &s.ClosedAt, &s.ClosingCountCents,
			&s.ExpectedCashCents, &s.VarianceCents, &s.Notes); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if s.ExpectedCashCents != nil {
			s.LiveExpectedCashCents = *s.ExpectedCashCents
		}
		if s.ClosingCountCents != nil {
			s.LiveCashCount = *s.ClosingCountCents - s.OpeningFloatCents
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"shifts": out})
}
