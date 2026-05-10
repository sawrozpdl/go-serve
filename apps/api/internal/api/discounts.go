package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// Wire types
// =========================================================================

type OrderAdjustment struct {
	ID                uuid.UUID `json:"id"`
	OrderID           uuid.UUID `json:"order_id"`
	Type              string    `json:"type"`
	AmountCents       int64     `json:"amount_cents"`
	Reason            string    `json:"reason"`
	AppliedByUserID   uuid.UUID `json:"applied_by_user_id"`
	ApprovedByUserID  uuid.UUID `json:"approved_by_user_id"`
	CreatedAt         time.Time `json:"created_at"`
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
		SELECT id, order_id, type::text, amount_cents, reason,
		       applied_by_user_id, approved_by_user_id, created_at
		FROM order_adjustments
		WHERE order_id = $1
		ORDER BY created_at
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
			&appliedBy, &approvedBy, &a.CreatedAt); err != nil {
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
			approvalReq
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

		approverID, ok, why := requireManagerOrApproval(r.Context(), r, body.approvalReq)
		if !ok {
			auditEvent(r.Context(), "discount.denied", "order", orderID.String(),
				map[string]any{"amount_cents": body.AmountCents, "reason": body.Reason, "denied_because": why})
			writeErr(w, http.StatusForbidden, "approval_required", why)
			return
		}

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
		hub.Broadcast(t.ID, realtime.Event{
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

		// Removing a discount is itself a manager-level action.
		var body struct {
			approvalReq
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, ok, why := requireManagerOrApproval(r.Context(), r, body.approvalReq)
		if !ok {
			writeErr(w, http.StatusForbidden, "approval_required", why)
			return
		}

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
		cmd, err := tx.Exec(r.Context(),
			`DELETE FROM order_adjustments WHERE id = $1 AND order_id = $2`, adjID, orderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if cmd.RowsAffected() == 0 {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		t, _ := appctx.TenantFromContext(r.Context())
		auditEvent(r.Context(), "order.adjustment_removed", "order", orderID.String(),
			map[string]any{"adjustment_id": adjID.String()})
		hub.Broadcast(t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.adjustment.removed",
			Ref:    map[string]any{"order_id": orderID.String(), "adjustment_id": adjID.String()},
		})
		w.WriteHeader(http.StatusNoContent)
	}
}
