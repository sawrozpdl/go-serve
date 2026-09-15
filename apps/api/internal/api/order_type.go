package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// The fulfilment channel of an order — see migration 0081 for why this is data
// rather than something derived from service_table_id.

const (
	OrderTypeDineIn   = "dine_in"
	OrderTypeTakeaway = "takeaway"
	OrderTypeDelivery = "delivery"
)

func knownOrderType(s string) bool {
	switch s {
	case OrderTypeDineIn, OrderTypeTakeaway, OrderTypeDelivery:
		return true
	}
	return false
}

// normalizeOrderType resolves the channel for a new order.
//
// A blank value reproduces exactly the meaning the product carried implicitly
// before 0081 — a table means dine-in, no table means takeaway — so a client
// that has never heard of the field keeps writing correct rows instead of
// defaulting everything to dine-in and quietly mislabelling every walk-in.
//
// A staff meal is forced to dine_in and REFUSES an explicit anything-else.
// Silently overriding what the caller asked for would hide a real client bug;
// the DB constraint would reject the row anyway, and a 400 here turns that
// constraint violation into a sentence.
func normalizeOrderType(in string, tableID *uuid.UUID, staffID *uuid.UUID) (string, error) {
	in = strings.ToLower(strings.TrimSpace(in))

	if staffID != nil {
		if in != "" && in != OrderTypeDineIn {
			return "", errors.New("a staff meal is not a takeaway or a delivery")
		}
		return OrderTypeDineIn, nil
	}

	if in == "" {
		if tableID != nil {
			return OrderTypeDineIn, nil
		}
		return OrderTypeTakeaway, nil
	}

	if !knownOrderType(in) {
		return "", fmt.Errorf("order_type must be one of dine_in, takeaway, delivery (got %q)", in)
	}
	return in, nil
}

// SetOrderType changes an open tab's fulfilment channel.
//
// Its own endpoint rather than a field on the move/merge handler, because the
// two say different things. Reseating a guest is not a statement about where
// the food is going: a delivery order parked on a table while it waits for the
// rider must not silently become dine-in, and a dine-in table whose guests
// decide to take it with them must not have to give up their table to say so.
func SetOrderType(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}

		var body struct {
			OrderType string `json:"order_type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		next := strings.ToLower(strings.TrimSpace(body.OrderType))
		if !knownOrderType(next) {
			writeErr(w, http.StatusBadRequest, "bad_order_type",
				"order_type must be one of dine_in, takeaway, delivery")
			return
		}

		tx := appctx.Tx(r.Context())

		// Everything is checked before the UPDATE: a 4xx still commits here.
		var status, current string
		var staffID *uuid.UUID
		err = tx.QueryRow(r.Context(),
			`SELECT status::text, order_type, staff_id FROM orders WHERE id = $1 FOR UPDATE`, id).
			Scan(&status, &current, &staffID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// staff_id, NOT status. The terminal 'staff_meal' status only exists
		// once the meal is closed; while it is being rung up the row is an
		// ordinary 'open' order carrying a staff_id. Testing the status alone
		// let an OPEN staff meal be relabelled as a takeaway, which then failed
		// the 0081 check constraint at close — turning a bad label into a serve
		// that could not be finished.
		if staffID != nil {
			writeErr(w, http.StatusConflict, "staff_meal",
				"a staff meal is not a takeaway or a delivery")
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open",
				"this serve is already closed — its type can no longer be changed")
			return
		}
		if current == next {
			writeJSON(w, http.StatusOK, map[string]any{"order_type": current})
			return
		}

		if _, err := tx.Exec(r.Context(),
			`UPDATE orders SET order_type = $2 WHERE id = $1`, id, next); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "order", EntityID: &id,
			Summary: fmt.Sprintf("changed serve type from %s to %s",
				orderTypeLabel(current), orderTypeLabel(next)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// The floor tile and the kitchen docket both show the type, so both
		// repaint. After commit, like every other broadcast here — a client
		// that refetches on an uncommitted change reads the old row back.
		t, _ := appctx.TenantFromContext(r.Context())
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.type_changed",
			Ref:    map[string]any{"order_id": id.String(), "order_type": next},
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicKitchen,
			Action: "order.type_changed",
			Ref:    map[string]any{"order_id": id.String(), "order_type": next},
		})

		writeJSON(w, http.StatusOK, map[string]any{"order_type": next})
	}
}

// orderTypeLabel is for prose — audit summaries and error messages.
func orderTypeLabel(t string) string {
	switch t {
	case OrderTypeTakeaway:
		return "takeaway"
	case OrderTypeDelivery:
		return "delivery"
	default:
		return "dine-in"
	}
}
