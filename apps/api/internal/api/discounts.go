package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// Wire types
// =========================================================================

type OrderAdjustment struct {
	ID               uuid.UUID `json:"id"`
	OrderID          uuid.UUID `json:"order_id"`
	Type             string    `json:"type"`
	AmountCents      int64     `json:"amount_cents"`
	Reason           string    `json:"reason"`
	AppliedByUserID  uuid.UUID `json:"applied_by_user_id"`
	ApprovedByUserID uuid.UUID `json:"approved_by_user_id"`
	CreatedAt        time.Time `json:"created_at"`
	// MenuCategoryID is set only on a category promotion (migration 0078); NULL
	// on a manual discount or a QR reward. Its presence is what identifies a
	// promo row, to the sync and to the clients.
	MenuCategoryID *uuid.UUID `json:"menu_category_id,omitempty"`
	// CategoryName is denormalised for display, so a client can label the row
	// "Breakfast 10%" without re-joining the catalog.
	CategoryName string `json:"category_name,omitempty"`
	// PercentBP is the percentage the amount was derived from, in basis points.
	// Recorded so a later percentage change can never rewrite what a closed bill
	// actually gave away.
	PercentBP *int `json:"percent_bp,omitempty"`
}

// =========================================================================
// LIST adjustments for an order
// =========================================================================

func ListOrderAdjustments(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "discounts.list", "order_id", id)
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT a.id, a.order_id, a.type::text, a.amount_cents, a.reason,
		       a.applied_by_user_id, a.approved_by_user_id, a.created_at,
		       a.menu_category_id, COALESCE(mc.name, ''), a.percent_bp
		FROM order_adjustments a
		LEFT JOIN menu_categories mc ON mc.id = a.menu_category_id
		WHERE a.order_id = $1
		ORDER BY a.created_at
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []OrderAdjustment{}
	for rows.Next() {
		var a OrderAdjustment
		var appliedBy, approvedBy *uuid.UUID
		if err := rows.Scan(&a.ID, &a.OrderID, &a.Type, &a.AmountCents, &a.Reason,
			&appliedBy, &approvedBy, &a.CreatedAt,
			&a.MenuCategoryID, &a.CategoryName, &a.PercentBP); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if appliedBy != nil {
			a.AppliedByUserID = *appliedBy
		}
		if approvedBy != nil {
			a.ApprovedByUserID = *approvedBy
		}
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"adjustments": out})
}

// =========================================================================
// Shared discount arithmetic
// =========================================================================

// remainingDiscountHeadroom is how much more discount an order can absorb:
// subtotal + service charge − discounts already applied.
//
// A discount may not exceed what there is to discount. buildQuote clamps the
// taxable base at zero, so a bigger discount silently makes the stored columns
// stop reconciling: subtotal − discount + service + tax no longer equals total,
// and the History panel then shows a receipt whose own rows don't add up.
// Dashboard's discount figure would also exceed the amount actually deducted,
// and platform_accuracy_check()'s order_arithmetic invariant would start firing.
//
// Lives here as ONE function because two callers need it — the manual discount
// path below and QR reward redemption (engage_redeem.go). Two copies of this
// arithmetic would drift, and money code that drifts is exactly the class of bug
// money.go was written to end.
func remainingDiscountHeadroom(ctx context.Context, orderID uuid.UUID) (int64, error) {
	return remainingDiscountHeadroomTx(ctx, appctx.Tx(ctx), orderID)
}

// remainingDiscountHeadroomTx is remainingDiscountHeadroom for a caller that
// already holds the transaction. syncCategoryPromotions needs this: it is handed
// a tx and must not reach into the context for a possibly different one — and a
// helper that takes a tx it then ignores is untestable besides.
func remainingDiscountHeadroomTx(ctx context.Context, tx pgx.Tx, orderID uuid.UUID) (int64, error) {
	var headroom int64
	err := tx.QueryRow(ctx, `
		WITH lines AS (
		  SELECT COALESCE(SUM(qty * unit_price_cents), 0)::bigint AS subtotal
		  FROM order_items WHERE order_id = $1 AND voided_at IS NULL
		),
		already AS (
		  SELECT COALESCE(SUM(amount_cents), 0)::bigint AS discount
		  FROM order_adjustments WHERE order_id = $1 AND type = 'discount'
		)
		SELECT (l.subtotal
		        + round(l.subtotal * t.service_charge_pct / 100)::bigint
		        - a.discount)::bigint
		FROM lines l, already a, orders o JOIN tenants t ON t.id = o.tenant_id
		WHERE o.id = $1
	`, orderID).Scan(&headroom)
	return headroom, err
}

// =========================================================================
// CREATE a discount (or service charge override) on an open order
// =========================================================================

func ApplyOrderAdjustment(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			Type        string `json:"type"`
			AmountCents int64  `json:"amount_cents"`
			Reason      string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if body.Type != "discount" && body.Type != "service_charge" && body.Type != "tax_override" {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"type must be discount|service_charge|tax_override")
			return
		}
		if body.AmountCents <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "amount_cents must be > 0")
			return
		}
		if body.Reason == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "reason required")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "discounts.apply_adjustment",
			"order_id", orderID,
			"type", body.Type,
			"amount_cents", body.AmountCents)

		// Order must be open.
		tx := appctx.Tx(r.Context())
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text FROM orders WHERE id = $1`, orderID,
		).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open",
				"can't adjust a "+status+" order")
			return
		}

		// A discount may not exceed what there is to discount — see
		// remainingDiscountHeadroom for why that matters to the stored totals.
		if body.Type == "discount" {
			maxDiscount, err := remainingDiscountHeadroom(r.Context(), orderID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if body.AmountCents > maxDiscount {
				writeErr(w, http.StatusConflict, "discount_too_large",
					"a discount can't exceed the bill — at most "+formatPaisa(maxDiscount)+
						" is left to discount on this order")
				return
			}
		}

		// Permission gate is mounted on the route (adjustment:apply); if the
		// handler is reached, the actor is authorised. The approver is the
		// actor themselves now that PIN-approvals are gone.
		approverID := user.ID

		var a OrderAdjustment
		err = tx.QueryRow(r.Context(), `
			INSERT INTO order_adjustments
			  (tenant_id, order_id, type, amount_cents, reason,
			   applied_by_user_id, approved_by_user_id)
			VALUES ($1, $2, $3::order_adjustment_type, $4, $5, $6, $7)
			RETURNING id, order_id, type::text, amount_cents, reason,
			          COALESCE(applied_by_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
			          COALESCE(approved_by_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
			          created_at
		`, t.ID, orderID, body.Type, body.AmountCents, body.Reason, user.ID, approverID).Scan(
			&a.ID, &a.OrderID, &a.Type, &a.AmountCents, &a.Reason,
			&a.AppliedByUserID, &a.ApprovedByUserID, &a.CreatedAt)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		auditEvent(r.Context(), "order."+body.Type+"_applied", "order", orderID.String(), map[string]any{
			"amount_cents": body.AmountCents,
			"reason":       body.Reason,
			"approver_id":  approverID.String(),
		})
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "order_adjustment", EntityID: &a.ID,
			Summary: fmt.Sprintf("applied %s of %s (%s)",
				body.Type, audit.Money(body.AmountCents), body.Reason),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.adjustment.applied",
			Ref:    map[string]any{"order_id": orderID.String(), "adjustment_id": a.ID.String()},
		})
		writeJSON(w, http.StatusCreated, a)
	}
}

// =========================================================================
// REMOVE an adjustment
// =========================================================================

func RemoveOrderAdjustment(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		adjID, err := uuid.Parse(chi.URLParam(r, "adjId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid adjustment id")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "discounts.remove_adjustment",
			"order_id", orderID, "adjustment_id", adjID)

		// Permission gate is mounted on the route (adjustment:delete).
		tx := appctx.Tx(r.Context())
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text FROM orders WHERE id = $1`, orderID,
		).Scan(&status); err != nil {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open", "can't adjust a "+status+" order")
			return
		}
		// If this adjustment came from a QR reward, hand the code back BEFORE the
		// delete. Otherwise a cashier who removes the discount does the guest
		// double harm: the discount comes off the bill AND their code is
		// permanently spent. The partial unique indexes on engage_redemptions are
		// WHERE reverted_at IS NULL, so the code becomes redeemable again at once
		// (within whatever is left of its five minutes).
		reverted, err := revertRewardForAdjustment(r.Context(), adjID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Removing a CATEGORY PROMOTION has to waive it for this order, not just
		// delete the row: syncCategoryPromotions runs on every subsequent line
		// edit and at close, so without the flag the next tap would put the
		// discount straight back and the cashier's decision would be silently
		// undone. Waiving is per-order and covers every promoted category on it,
		// which matches what "take the promotion off this bill" means.
		var isPromo bool
		if err := tx.QueryRow(r.Context(),
			`SELECT menu_category_id IS NOT NULL FROM order_adjustments WHERE id = $1 AND order_id = $2`,
			adjID, orderID,
		).Scan(&isPromo); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// The flag is per-order, so the delete is too: removing one promoted
		// category's row takes the whole promotion off this bill. Waiving one
		// category but not the others would need a per-category flag, and
		// "remove the discount from this bill" is what a cashier is actually
		// asking for.
		var cmd pgconn.CommandTag
		if isPromo {
			if _, err := tx.Exec(r.Context(),
				`UPDATE orders SET promotions_waived = true WHERE id = $1`, orderID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			cmd, err = tx.Exec(r.Context(),
				`DELETE FROM order_adjustments WHERE order_id = $1 AND menu_category_id IS NOT NULL`, orderID)
		} else {
			cmd, err = tx.Exec(r.Context(),
				`DELETE FROM order_adjustments WHERE id = $1 AND order_id = $2`, adjID, orderID)
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if reverted != "" {
			log.InfoContext(r.Context(), "engage.reward.reverted",
				"order_id", orderID, "adjustment_id", adjID, "code", reverted)
		}
		if cmd.RowsAffected() == 0 {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		t, _ := appctx.TenantFromContext(r.Context())
		auditEvent(r.Context(), "order.adjustment_removed", "order", orderID.String(),
			map[string]any{"adjustment_id": adjID.String()})
		summary := "removed order adjustment"
		if isPromo {
			summary = "waived the category promotion on this order"
		}
		if reverted != "" {
			summary = "removed order adjustment and returned QR reward code " + reverted
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "order_adjustment", EntityID: &adjID,
			Summary: summary,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.adjustment.removed",
			Ref:    map[string]any{"order_id": orderID.String(), "adjustment_id": adjID.String()},
		})
		w.WriteHeader(http.StatusNoContent)
	}
}
