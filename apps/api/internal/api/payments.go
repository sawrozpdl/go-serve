package api

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

type Payment struct {
	ID                uuid.UUID  `json:"id"`
	OrderID           uuid.UUID  `json:"order_id"`
	Method            string     `json:"method"`
	AmountCents       int64      `json:"amount_cents"`
	ReferenceNo       string     `json:"reference_no"`
	HouseTabID        *uuid.UUID `json:"house_tab_id,omitempty"`
	HouseTabName      *string    `json:"house_tab_name,omitempty"`
	RecordedByUserID  uuid.UUID  `json:"recorded_by_user_id"`
	RecordedAt        time.Time  `json:"recorded_at"`
}

// CloseQuote is the computed-but-not-saved breakdown the FE shows on the
// settle screen. Same math as ClosingTotals applies on commit.
type CloseQuote struct {
	SubtotalCents       int64 `json:"subtotal_cents"`
	DiscountCents       int64 `json:"discount_cents"`
	ServiceChargeCents  int64 `json:"service_charge_cents"`
	TaxCents            int64 `json:"tax_cents"`
	TotalCents          int64 `json:"total_cents"`
	PaidCents           int64 `json:"paid_cents"`
	BalanceCents        int64 `json:"balance_cents"`
	ServiceChargePct    string `json:"service_charge_pct"`
	VatPct              string `json:"vat_pct"`
}

// =========================================================================
// LIST PAYMENTS for an order
// =========================================================================

func ListOrderPayments(w http.ResponseWriter, r *http.Request) {
	orderID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "payments.list", "order_id", orderID)
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT p.id, p.order_id, p.method::text, p.amount_cents, p.reference_no,
		       p.house_tab_id, ht.name,
		       p.recorded_by_user_id, p.recorded_at
		FROM payments p
		LEFT JOIN house_tabs ht ON ht.id = p.house_tab_id
		WHERE p.order_id = $1
		ORDER BY p.recorded_at
	`, orderID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []Payment{}
	for rows.Next() {
		p := Payment{}
		if err := rows.Scan(&p.ID, &p.OrderID, &p.Method, &p.AmountCents, &p.ReferenceNo,
			&p.HouseTabID, &p.HouseTabName,
			&p.RecordedByUserID, &p.RecordedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"payments": out})
}

// =========================================================================
// RECORD PAYMENT
// =========================================================================

func RecordPayment(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			Method      string     `json:"method"`
			AmountCents int64      `json:"amount_cents"`
			ReferenceNo string     `json:"reference_no"`
			HouseTabID  *uuid.UUID `json:"house_tab_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		body.Method = strings.ToLower(strings.TrimSpace(body.Method))
		// 'online' is the new top-level alias; persist it as 'other' on the
		// existing enum so we don't have to migrate old rows yet. eSewa /
		// Khalti / Card values still pass through unchanged for back-compat.
		if body.Method == "online" {
			body.Method = "other"
		}
		switch body.Method {
		case "cash", "esewa", "khalti", "card", "other", "house_tab":
		case "bank":
			// 'bank' is reserved for cafe-internal money (deposits,
			// investments, payouts) — customers don't pay direct to bank.
			writeErr(w, http.StatusBadRequest, "bad_method",
				"'bank' is not a customer payment channel — use cash or an online method")
			return
		default:
			writeErr(w, http.StatusBadRequest, "bad_method",
				"method must be one of cash|online|house_tab")
			return
		}
		if body.AmountCents <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_amount", "amount must be positive")
			return
		}
		if body.Method == "house_tab" && body.HouseTabID == nil {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"house_tab_id required when method=house_tab")
			return
		}
		if body.Method != "house_tab" && body.HouseTabID != nil {
			body.HouseTabID = nil
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "payments.record",
			"order_id", orderID,
			"method", body.Method,
			"amount_cents", body.AmountCents,
			"has_house_tab", body.HouseTabID != nil)

		tx := appctx.Tx(r.Context())

		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text FROM orders WHERE id = $1`, orderID,
		).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "order not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open",
				"cannot record payment on a "+status+" order")
			return
		}

		// Reject overpayment at the source. We compute the live balance and
		// refuse a payment that would push it negative — there's no
		// change-due / tip flow yet, so a negative balance just confuses
		// settlement and blocks Close.
		q, err := buildQuote(r.Context(), orderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if body.AmountCents > q.BalanceCents {
			writeErr(w, http.StatusConflict, "overpayment",
				"amount exceeds outstanding balance ("+formatPaisa(q.BalanceCents)+
					"). enter the remaining amount, or remove a previous payment to start over")
			return
		}

		// Look up the open shift. Cash payments REQUIRE one; non-cash
		// payments still get tagged with it for shift reporting.
		shiftID, err := findOpenShiftID(r.Context())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if body.Method == "cash" && shiftID == uuid.Nil {
			writeErr(w, http.StatusConflict, "shift_required",
				"cash payments require an open shift — open one in the Shift screen")
			return
		}
		var shiftPtr *uuid.UUID
		if shiftID != uuid.Nil {
			shiftPtr = &shiftID
		}

		// House-tab charge: validate the tab is real and active.
		if body.Method == "house_tab" {
			var active bool
			if err := tx.QueryRow(r.Context(),
				`SELECT is_active FROM house_tabs WHERE id = $1 AND deleted_at IS NULL`,
				*body.HouseTabID,
			).Scan(&active); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeErr(w, http.StatusBadRequest, "bad_request", "house tab not found")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if !active {
				writeErr(w, http.StatusConflict, "house_tab_inactive",
					"this house tab is archived — reactivate it before charging to it")
				return
			}
		}

		p := Payment{}
		err = tx.QueryRow(r.Context(), `
			INSERT INTO payments (tenant_id, order_id, shift_id, method, amount_cents, reference_no, recorded_by_user_id, house_tab_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, order_id, method::text, amount_cents, reference_no, house_tab_id, recorded_by_user_id, recorded_at
		`, t.ID, orderID, shiftPtr, body.Method, body.AmountCents, body.ReferenceNo, user.ID, body.HouseTabID).Scan(
			&p.ID, &p.OrderID, &p.Method, &p.AmountCents, &p.ReferenceNo, &p.HouseTabID, &p.RecordedByUserID, &p.RecordedAt)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "payment", EntityID: &p.ID,
			Summary: fmt.Sprintf("recorded %s payment (%s)",
				audit.Money(body.AmountCents), body.Method),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.payment.recorded",
			Ref:    map[string]any{"order_id": orderID.String(), "payment_id": p.ID.String()},
		})
		writeJSON(w, http.StatusCreated, p)
	}
}

// =========================================================================
// DELETE PAYMENT — undo a payment recorded against an open order.
// Used to recover from overpayment / wrong-method mistakes before close.
// =========================================================================

func DeletePayment(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		paymentID, err := uuid.Parse(chi.URLParam(r, "paymentId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid payment id")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "payments.delete",
			"order_id", orderID, "payment_id", paymentID)
		t, _ := appctx.TenantFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text FROM orders WHERE id = $1`, orderID,
		).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "order not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open",
				"cannot remove a payment from a "+status+" order")
			return
		}

		var method string
		var amount int64
		err = tx.QueryRow(r.Context(), `
			DELETE FROM payments
			WHERE id = $1 AND order_id = $2
			RETURNING method::text, amount_cents
		`, paymentID, orderID).Scan(&method, &amount)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		auditEvent(r.Context(), "order.payment.removed", "payment", paymentID.String(), map[string]any{
			"order_id":     orderID.String(),
			"method":       method,
			"amount_cents": amount,
		})
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "payment", EntityID: &paymentID,
			Summary: fmt.Sprintf("removed %s payment (%s)", audit.Money(amount), method),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.payment.removed",
			Ref:    map[string]any{"order_id": orderID.String(), "payment_id": paymentID.String()},
		})
		w.WriteHeader(http.StatusNoContent)
	}
}

// =========================================================================
// SETTLE QUOTE (computed totals + balance)
// GET /v1/orders/{id}/quote
// =========================================================================

func GetSettleQuote(w http.ResponseWriter, r *http.Request) {
	orderID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "payments.get_settle_quote", "order_id", orderID)
	q, err := buildQuote(r.Context(), orderID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, q)
}

// =========================================================================
// CLOSE order
// POST /v1/orders/{id}/close
// =========================================================================

func CloseOrder(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.close", "order_id", orderID)
		t, _ := appctx.TenantFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		// Order must be open + we need its service_table to flip status.
		var status string
		var serviceTableID *uuid.UUID
		err = tx.QueryRow(r.Context(),
			`SELECT status::text, service_table_id FROM orders WHERE id = $1`, orderID,
		).Scan(&status, &serviceTableID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "already_"+status, "order is "+status)
			return
		}

		q, err := buildQuote(r.Context(), orderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if q.SubtotalCents == 0 {
			writeErr(w, http.StatusConflict, "empty_order",
				"cannot close an order with no items — cancel it instead")
			return
		}
		if q.BalanceCents != 0 {
			writeErr(w, http.StatusConflict, "balance_outstanding",
				"recorded payments do not equal the total — balance "+formatPaisa(q.BalanceCents))
			return
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE orders
			SET status               = 'closed',
			    closed_at            = now(),
			    subtotal_cents       = $2,
			    discount_cents       = $3,
			    service_charge_cents = $4,
			    tax_cents            = $5,
			    total_cents          = $6
			WHERE id = $1 AND status = 'open'
		`, orderID, q.SubtotalCents, q.DiscountCents, q.ServiceChargeCents, q.TaxCents, q.TotalCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Mark the table dirty so it requires cleaning before next tab.
		// Tenants with autoCleanTables enabled skip the dirty hop entirely
		// (no separate "mark clean" click) and go straight back to free.
		if serviceTableID != nil {
			nextStatus := "dirty"
			if loadTenantPreferences(r.Context(), t.ID).AutoCleanTables {
				nextStatus = "free"
			}
			_, _ = tx.Exec(r.Context(),
				`UPDATE service_tables SET status = $2::service_table_status WHERE id = $1 AND status = 'occupied'`,
				*serviceTableID, nextStatus)
		}

		// Auto-decrement inventory for any linked menu items.
		user, _ := appctx.UserFromContext(r.Context())
		if err := DecrementInventoryForOrder(r.Context(), orderID, t.ID, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error",
				"inventory decrement failed: "+err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "close", Entity: "order", EntityID: &orderID,
			Summary: fmt.Sprintf("closed order (%s)", audit.Money(q.TotalCents)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.closed",
			Ref:    map[string]any{"order_id": orderID.String(), "total_cents": q.TotalCents},
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicTables,
			Action: "table.freed",
			Ref:    map[string]any{"order_id": orderID.String(), "service_table_id": ifNotNilUUID(serviceTableID)},
		})

		writeJSON(w, http.StatusOK, q)
	}
}

// =========================================================================
// helpers
// =========================================================================

// buildQuote sums non-voided items, reads tenant tax/service rates, computes
// the breakdown, and joins recorded payments. Pure read; doesn't mutate.
func buildQuote(ctx context.Context, orderID uuid.UUID) (CloseQuote, error) {
	tx := appctx.Tx(ctx)

	var t struct {
		ServicePct string
		VatPct     string
	}
	if err := tx.QueryRow(ctx, `
		SELECT t.service_charge_pct::text, t.vat_pct::text
		FROM orders o JOIN tenants t ON t.id = o.tenant_id
		WHERE o.id = $1
	`, orderID).Scan(&t.ServicePct, &t.VatPct); err != nil {
		return CloseQuote{}, err
	}

	q := CloseQuote{ServiceChargePct: t.ServicePct, VatPct: t.VatPct}

	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(qty * unit_price_cents), 0)::bigint
		FROM order_items
		WHERE order_id = $1 AND voided_at IS NULL
	`, orderID).Scan(&q.SubtotalCents); err != nil {
		return CloseQuote{}, err
	}

	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM payments WHERE order_id = $1
	`, orderID).Scan(&q.PaidCents); err != nil {
		return CloseQuote{}, err
	}

	// Discounts come from order_adjustments rows of type='discount'.
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM order_adjustments
		WHERE order_id = $1 AND type = 'discount'
	`, orderID).Scan(&q.DiscountCents); err != nil {
		return CloseQuote{}, err
	}

	q.ServiceChargeCents = pctOf(q.SubtotalCents, t.ServicePct)
	taxBase := q.SubtotalCents - q.DiscountCents + q.ServiceChargeCents
	if taxBase < 0 {
		taxBase = 0
	}
	q.TaxCents = pctOf(taxBase, t.VatPct)
	q.TotalCents = q.SubtotalCents - q.DiscountCents + q.ServiceChargeCents + q.TaxCents
	q.BalanceCents = q.TotalCents - q.PaidCents
	return q, nil
}

// pctOf computes round(amount * pct / 100) using integer math. pct comes
// from Postgres numeric(5,2) as a string like "13.00" or "0".
func pctOf(amount int64, pct string) int64 {
	// Parse "13.00" or "0" into hundredths-of-a-percent (basis points * 100 = pct * 100).
	// We accept up to 2 decimal places.
	n := parsePctHundredths(pct)
	// amount * n / 10000, rounded half-up.
	num := amount*n + 5000
	return num / 10000
}

func parsePctHundredths(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	dot := strings.IndexByte(s, '.')
	whole, frac := s, ""
	if dot >= 0 {
		whole = s[:dot]
		frac = s[dot+1:]
	}
	if len(frac) > 2 {
		frac = frac[:2]
	}
	for len(frac) < 2 {
		frac += "0"
	}
	var w, f int64
	for _, c := range whole {
		if c < '0' || c > '9' {
			return 0
		}
		w = w*10 + int64(c-'0')
	}
	for _, c := range frac {
		if c < '0' || c > '9' {
			return 0
		}
		f = f*10 + int64(c-'0')
	}
	return w*100 + f
}

func formatPaisa(c int64) string {
	rs := c / 100
	pa := c % 100
	if pa < 0 {
		pa = -pa
	}
	if c < 0 {
		return "-Rs " + itoa(-rs) + "." + zpad(pa)
	}
	return "Rs " + itoa(rs) + "." + zpad(pa)
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func zpad(n int64) string {
	if n < 10 {
		return "0" + itoa(n)
	}
	return itoa(n)
}
