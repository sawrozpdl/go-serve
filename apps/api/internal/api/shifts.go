package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// =========================================================================
// Wire types
// =========================================================================

type Shift struct {
	ID                uuid.UUID  `json:"id"`
	OpenedByUserID    uuid.UUID  `json:"opened_by_user_id"`
	OpenedByEmail     *string    `json:"opened_by_email,omitempty"`
	OpenedAt          time.Time  `json:"opened_at"`
	OpeningFloatCents int64      `json:"opening_float_cents"`
	ClosedByUserID    *uuid.UUID `json:"closed_by_user_id,omitempty"`
	ClosedAt          *time.Time `json:"closed_at,omitempty"`
	ClosingCountCents *int64     `json:"closing_count_cents,omitempty"`
	ExpectedCashCents *int64     `json:"expected_cash_cents,omitempty"`
	VarianceCents     *int64     `json:"variance_cents,omitempty"`
	Notes             string     `json:"notes"`
	// Computed at read-time for an open shift (so the FE can show a live
	// "expected cash" while the user counts the drawer).
	// expected = opening_float + Σ cash payments + Σ drops(in) − Σ drops(out)
	LiveExpectedCashCents int64 `json:"live_expected_cash_cents"`
	LiveCashCount         int64 `json:"live_cash_count_cents"`
	LiveCashInCents       int64 `json:"live_cash_in_cents"`  // payments + drops(in)
	LiveCashOutCents      int64 `json:"live_cash_out_cents"` // drops(out)
	// Σ payments where method ∉ (cash, house_tab). Doesn't enter expected
	// cash — shown at close so the counter can cross-check the QR app.
	LiveOnlineInCents int64 `json:"live_online_in_cents"`
}

// ShiftPayment is a settle event inside one shift — feeds the close panel's
// variance-match hint (drawer short/over by exactly one payment's amount).
type ShiftPayment struct {
	ID          uuid.UUID `json:"id"`
	OrderID     uuid.UUID `json:"order_id"`
	Method      string    `json:"method"`
	AmountCents int64     `json:"amount_cents"`
	ReferenceNo string    `json:"reference_no"`
	RecordedAt  time.Time `json:"recorded_at"`
	TableName   *string   `json:"table_name,omitempty"`
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
	//
	// expected = opening_float + Σ cash payments + Σ drops(in) − Σ drops(out)
	if s.ClosedAt == nil {
		var cashIn, dropsIn, dropsOut int64
		if err := tx.QueryRow(ctx, `
			SELECT
			  COALESCE(SUM(amount_cents) FILTER (WHERE method = 'cash'), 0)::bigint,
			  COALESCE(SUM(amount_cents) FILTER (WHERE method::text NOT IN ('cash', 'house_tab')), 0)::bigint
			FROM payments
			WHERE shift_id = $1
		`, id).Scan(&cashIn, &s.LiveOnlineInCents); err != nil {
			return s, err
		}
		if err := tx.QueryRow(ctx, `
			SELECT
			  COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount_cents END), 0)::bigint,
			  COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents END), 0)::bigint
			FROM cash_drops
			WHERE shift_id = $1
		`, id).Scan(&dropsIn, &dropsOut); err != nil {
			return s, err
		}
		s.LiveCashInCents = cashIn + dropsIn
		s.LiveCashOutCents = dropsOut
		s.LiveCashCount = s.LiveCashInCents - s.LiveCashOutCents
		s.LiveExpectedCashCents = s.OpeningFloatCents + s.LiveCashCount
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
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "shifts.get_current")
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
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "shifts.open",
		"opening_float_cents", body.OpeningFloatCents)
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
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "open", Entity: "shift", EntityID: &id,
		Summary: fmt.Sprintf("opened shift with float %s", audit.Money(body.OpeningFloatCents)),
	}); err != nil {
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

func CloseShift(mailer *mail.Mailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid shift id")
			return
		}
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			ClosingCountCents int64  `json:"closing_count_cents"`
			Notes             string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ClosingCountCents < 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "closing_count_cents required (>=0)")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "shifts.close",
			"id", id, "closing_count_cents", body.ClosingCountCents)
		tx := appctx.Tx(r.Context())

		// Compute expected cash from the ledger.
		var openingFloat int64
		var alreadyClosed *time.Time
		var openedAt time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT opening_float_cents, closed_at, opened_at FROM shifts WHERE id = $1`, id,
		).Scan(&openingFloat, &alreadyClosed, &openedAt); err != nil {
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
		var dropsIn, dropsOut int64
		if err := tx.QueryRow(r.Context(), `
			SELECT
			  COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount_cents END), 0)::bigint,
			  COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents END), 0)::bigint
			FROM cash_drops
			WHERE shift_id = $1
		`, id).Scan(&dropsIn, &dropsOut); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		expected := openingFloat + cashIn + dropsIn - dropsOut
		variance := body.ClosingCountCents - expected

		closedAt := time.Now().UTC()
		// Append notes to whatever was set on open.
		if _, err := tx.Exec(r.Context(), `
			UPDATE shifts
			SET closed_by_user_id = $2,
			    closed_at = $7,
			    closing_count_cents = $3,
			    expected_cash_cents = $4,
			    variance_cents = $5,
			    notes = CASE WHEN $6 = '' THEN notes ELSE
			      CASE WHEN notes = '' THEN $6 ELSE notes || E'\n' || $6 END
			    END
			WHERE id = $1
		`, id, user.ID, body.ClosingCountCents, expected, variance, body.Notes, closedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "close", Entity: "shift", EntityID: &id,
			Summary: fmt.Sprintf("closed shift (count %s, variance %s)",
				audit.Money(body.ClosingCountCents), audit.Money(variance)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Collect everything the email needs while we still hold the
		// RLS-scoped tx. The actual SMTP call happens after this handler
		// returns (so the user isn't blocked on email delivery).
		var emailReady bool
		var summary mail.ShiftSummary
		// Email shift summaries are a premium feature. The shift still closes
		// normally on every plan; only the email is suppressed when the
		// tenant's plan doesn't include it.
		emailFeature := false
		if st, ok := billing.StateFromContext(r.Context()); ok {
			emailFeature = st.Has(billing.FeatureEmailShiftSummaries)
		}
		if mailer != nil && emailFeature {
			// Build the summary inside a savepoint. The email is best-effort:
			// a failing read here must never abort the durable shift close.
			// Without the savepoint, an error poisons the request tx and the
			// loadShift below (and the COMMIT) fail with SQLSTATE 25P02 — which
			// also rolls back the UPDATE shifts above.
			if sp, spErr := tx.Begin(r.Context()); spErr != nil {
				log.WarnContext(r.Context(), "shifts.close.summary_savepoint_failed", "err", spErr)
			} else {
				s, sErr := buildShiftSummary(appctx.WithTx(r.Context(), sp), id, t.ID, t.Name, t.Slug, t.Timezone, openedAt, closedAt, body.Notes, openingFloat, body.ClosingCountCents, expected, variance, cashIn, dropsIn, dropsOut)
				if sErr != nil {
					_ = sp.Rollback(r.Context())
					log.WarnContext(r.Context(), "shifts.close.summary_build_failed", "err", sErr)
				} else {
					_ = sp.Commit(r.Context())
					if len(s.Recipients) > 0 {
						summary = s
						emailReady = true
					}
				}
			}
		}

		s, err := loadShift(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, s)

		if emailReady {
			go sendShiftSummaryEmail(log, mailer, summary)
		}
	}
}

// sendShiftSummaryEmail dispatches the prepared summary on a goroutine so the
// HTTP response isn't blocked on the SMTP roundtrip. Failures are logged but
// never surface to the user — email is best-effort.
func sendShiftSummaryEmail(log *slog.Logger, mailer *mail.Mailer, s mail.ShiftSummary) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("shift_summary.panic", "panic", r)
		}
	}()
	msg := mail.BuildShiftSummaryMessage(s)
	if err := mailer.Send(msg); err != nil {
		log.Error("shift_summary.send_failed", "err", err, "to_count", len(s.Recipients))
		return
	}
	log.Info("shift_summary.sent", "to_count", len(s.Recipients))
}

// =========================================================================
// GET /v1/shifts  (history)
// =========================================================================

func ListShifts(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "shifts.list")
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

// =========================================================================
// GET /v1/shifts/{id}/payments — the shift's settle events (house-tab
// charges excluded: they never touch cash or online balances). Feeds the
// close panel's variance-match hint.
// =========================================================================

func ListShiftPayments(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "shifts.list_payments", "id", id)
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT p.id, p.order_id, p.method::text, p.amount_cents, p.reference_no,
		       p.recorded_at, st.name
		FROM payments p
		JOIN orders o ON o.id = p.order_id
		LEFT JOIN service_tables st ON st.id = o.service_table_id
		WHERE p.shift_id = $1 AND p.method::text <> 'house_tab'
		ORDER BY p.recorded_at
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []ShiftPayment{}
	for rows.Next() {
		var p ShiftPayment
		if err := rows.Scan(&p.ID, &p.OrderID, &p.Method, &p.AmountCents,
			&p.ReferenceNo, &p.RecordedAt, &p.TableName); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"payments": out})
}
