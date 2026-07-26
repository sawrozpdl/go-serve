package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// =========================================================================
// GET /v1/shifts/{id}/summary
//
// The shift-end reconciliation, as data. buildShiftSummary already assembles
// the richest cash-drawer picture in the system — drawer arithmetic, payment
// method split, credit collected, top sellers — but it was only ever reachable
// from inside CloseShift, and only as an email. A shift that closed before the
// tenant had email enabled, or whose email bounced, left the operator with no
// way to see it at all, and the PDF export had nothing to print.
//
// This exposes the same builder over HTTP so the report builder (and anyone
// reconciling a past shift) can read it.
// =========================================================================

// ShiftSummaryReport is the wire form of mail.ShiftSummary.
//
// It is mapped field-by-field rather than marshalling the mail struct directly:
// that struct is an email template's input with no JSON tags, and it carries
// `Recipients` — the owner/manager email addresses. A report has no need for
// those, so they are deliberately not mapped.
type ShiftSummaryReport struct {
	ShiftID  uuid.UUID `json:"shift_id"`
	Timezone string    `json:"timezone"`
	OpenedAt time.Time `json:"opened_at"`
	// Nil while the shift is still open.
	ClosedAt      *time.Time `json:"closed_at,omitempty"`
	OpenedByEmail string     `json:"opened_by_email"`
	ClosedByEmail string     `json:"closed_by_email"`
	// True when the shift is still running — the drawer figures are live.
	IsOpen bool   `json:"is_open"`
	Notes  string `json:"notes"`

	// Drawer reconciliation.
	OpeningFloatCents int64 `json:"opening_float_cents"`
	CashInCents       int64 `json:"cash_in_cents"`
	// Cash collected against credit (house-tab) balances. Part of expected cash,
	// listed separately because it pays down an EARLIER sale — it is never sales.
	CreditSettledCashCents  int64 `json:"credit_settled_cash_cents"`
	CreditSettledOtherCents int64 `json:"credit_settled_other_cents"`
	DropsInCents            int64 `json:"drops_in_cents"`
	DropsOutCents           int64 `json:"drops_out_cents"`
	ExpectedCashCents       int64 `json:"expected_cash_cents"`
	// Zero while the shift is open — nothing has been counted yet.
	ClosingCountCents int64 `json:"closing_count_cents"`
	VarianceCents     int64 `json:"variance_cents"` // signed; negative = short

	// Sales side. Names follow the money vocabulary in money.go.
	OrderCount       int   `json:"order_count"`
	BilledSalesCents int64 `json:"billed_sales_cents"`
	OnCreditCents    int64 `json:"on_credit_cents"`
	ReceivedCents    int64 `json:"received_cents"`
	TaxCents         int64 `json:"tax_cents"`
	ServiceCents     int64 `json:"service_cents"`
	DiscountCents    int64 `json:"discount_cents"`
	VoidCount        int   `json:"void_count"`
	ExpensesCents    int64 `json:"expenses_cents"`

	PaymentMethods []ShiftMethodTotal `json:"payment_methods"`
	TopSellers     []ShiftTopSeller   `json:"top_sellers"`
}

type ShiftMethodTotal struct {
	Method      string `json:"method"`
	AmountCents int64  `json:"amount_cents"`
	Count       int    `json:"count"`
}

type ShiftTopSeller struct {
	Name         string `json:"name"`
	Qty          int    `json:"qty"`
	RevenueCents int64  `json:"revenue_cents"`
}

func GetShiftSummary(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid shift id")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "shifts.summary", "id", id)
	tx := appctx.Tx(r.Context())

	var (
		openingFloat  int64
		openedAt      time.Time
		closedAt      *time.Time
		closingCount  *int64
		expectedStore *int64
		varianceStore *int64
		notes         string
	)
	// RLS scopes this to the active tenant, so a shift id from another workspace
	// simply isn't found.
	if err := tx.QueryRow(r.Context(), `
		SELECT opening_float_cents, opened_at, closed_at,
		       closing_count_cents, expected_cash_cents, variance_cents, notes
		FROM shifts WHERE id = $1
	`, id).Scan(&openingFloat, &openedAt, &closedAt,
		&closingCount, &expectedStore, &varianceStore, &notes); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	flow, err := loadShiftCashFlow(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// For a CLOSED shift the persisted figures are the record of what was
	// actually counted, and recomputing them would quietly rewrite history — a
	// late-recorded payment would move the variance away from the number the
	// closer signed off on. For an OPEN shift there is nothing counted yet, so
	// expected is live and variance is not yet meaningful.
	isOpen := closedAt == nil
	expected := flow.expected(openingFloat)
	var counted, variance int64
	if !isOpen {
		if expectedStore != nil {
			expected = *expectedStore
		}
		if closingCount != nil {
			counted = *closingCount
		}
		if varianceStore != nil {
			variance = *varianceStore
		}
	}

	// buildShiftSummary wants a concrete closedAt for its window; while the
	// shift is open, "now" is the right upper bound for a live view.
	summaryClosedAt := time.Now()
	if closedAt != nil {
		summaryClosedAt = *closedAt
	}

	s, err := buildShiftSummary(r.Context(), id, t.ID, t.Name, t.Slug, t.Timezone,
		openedAt, summaryClosedAt, notes, openingFloat, counted, expected, variance, flow)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, toShiftSummaryReport(id, isOpen, closedAt, s))
}

func toShiftSummaryReport(
	id uuid.UUID, isOpen bool, closedAt *time.Time, s mail.ShiftSummary,
) ShiftSummaryReport {
	out := ShiftSummaryReport{
		ShiftID:                 id,
		Timezone:                s.Timezone,
		OpenedAt:                s.OpenedAt,
		ClosedAt:                closedAt,
		OpenedByEmail:           s.OpenedByEmail,
		ClosedByEmail:           s.ClosedByEmail,
		IsOpen:                  isOpen,
		Notes:                   s.Notes,
		OpeningFloatCents:       s.OpeningFloat,
		CashInCents:             s.CashIn,
		CreditSettledCashCents:  s.CreditSettledCash,
		CreditSettledOtherCents: s.CreditSettledOther,
		DropsInCents:            s.DropsIn,
		DropsOutCents:           s.DropsOut,
		ExpectedCashCents:       s.ExpectedCash,
		ClosingCountCents:       s.ClosingCount,
		VarianceCents:           s.Variance,
		OrderCount:              s.OrderCount,
		BilledSalesCents:        s.SalesCents,
		OnCreditCents:           s.OnTabCents,
		ReceivedCents:           s.ReceivedCents,
		TaxCents:                s.TaxCents,
		ServiceCents:            s.ServiceCents,
		DiscountCents:           s.DiscountCents,
		VoidCount:               s.VoidCount,
		ExpensesCents:           s.ExpensesCents,
		PaymentMethods:          []ShiftMethodTotal{},
		TopSellers:              []ShiftTopSeller{},
	}
	for _, m := range s.PaymentMethods {
		out.PaymentMethods = append(out.PaymentMethods, ShiftMethodTotal{
			Method: m.Method, AmountCents: m.Amount, Count: m.Count,
		})
	}
	for _, ts := range s.TopSellers {
		out.TopSellers = append(out.TopSellers, ShiftTopSeller{
			Name: ts.Name, Qty: ts.Qty, RevenueCents: ts.RevenueCents,
		})
	}
	return out
}
