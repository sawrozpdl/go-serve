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

// KitchenTicket is one ticket in the KDS view: an order_item that's
// currently in_progress or ready (i.e., kitchen has work to do).
type KitchenTicket struct {
	ItemID           uuid.UUID  `json:"item_id"`
	OrderID          uuid.UUID  `json:"order_id"`
	ServiceTableName *string    `json:"service_table_name,omitempty"`
	TableLabel       string     `json:"table_label"`
	MenuItemName     string     `json:"menu_item_name"`
	Qty              float64    `json:"qty"`
	Modifiers        any        `json:"modifiers"`
	Notes            string     `json:"notes"`
	KitchenStatus    string     `json:"kitchen_status"`
	SentToKitchenAt  *time.Time `json:"sent_to_kitchen_at,omitempty"`
	ReadyAt          *time.Time `json:"ready_at,omitempty"`
	// The prep outlet this ticket was routed to (stamped at send). Null for
	// tickets sent before outlets existed — those fall onto the default board.
	OutletID   *uuid.UUID `json:"outlet_id,omitempty"`
	OutletName *string    `json:"outlet_name,omitempty"`
}

// ListKitchenTickets returns tickets currently with the kitchen (in_progress +
// ready), oldest first so chefs work on what arrived first. An optional
// ?outlet=<id> filter narrows the board to one prep outlet; when it names the
// default outlet, unstamped (legacy) tickets are folded in too.
func ListKitchenTickets(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "kitchen.list_tickets")
	tx := appctx.Tx(r.Context())

	args := []any{}
	outletFilter := ""
	if s := r.URL.Query().Get("outlet"); s != "" {
		outletID, err := uuid.Parse(s)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid outlet id")
			return
		}
		args = append(args, outletID)
		outletFilter = `
		  AND (oi.outlet_id = $1
		       OR (oi.outlet_id IS NULL
		           AND $1 = (SELECT id FROM outlets WHERE is_default AND deleted_at IS NULL)))`
	}

	rows, err := tx.Query(r.Context(), `
		SELECT oi.id, oi.order_id, st.name, o.table_label, mi.name, oi.qty, oi.modifiers, oi.notes,
		       oi.kitchen_status::text, oi.sent_to_kitchen_at, oi.ready_at, oi.outlet_id, ou.name
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		LEFT JOIN service_tables st ON st.id = o.service_table_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		LEFT JOIN outlets ou ON ou.id = oi.outlet_id
		WHERE oi.voided_at IS NULL
		  AND oi.kitchen_status IN ('in_progress', 'ready')
		  AND o.status = 'open'`+outletFilter+`
		ORDER BY oi.sent_to_kitchen_at ASC NULLS LAST, oi.created_at ASC
	`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []KitchenTicket{}
	for rows.Next() {
		k := KitchenTicket{}
		var mod []byte
		if err := rows.Scan(&k.ItemID, &k.OrderID, &k.ServiceTableName, &k.TableLabel, &k.MenuItemName,
			&k.Qty, &mod, &k.Notes, &k.KitchenStatus, &k.SentToKitchenAt, &k.ReadyAt, &k.OutletID, &k.OutletName); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		_ = json.Unmarshal(mod, &k.Modifiers)
		out = append(out, k)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tickets": out})
}

// UpdateKitchenTicket flips kitchen_status to one of: in_progress, ready,
// served. Allowed transitions:
//
//	in_progress  → ready
//	ready        → served
//	(also accept idempotent same-state updates)
//
// Stamps the matching timestamp column.
func UpdateKitchenTicket(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, err := uuid.Parse(chi.URLParam(r, "itemId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid item id")
			return
		}
		var body struct {
			KitchenStatus string `json:"kitchen_status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		next := body.KitchenStatus
		if next != "in_progress" && next != "ready" && next != "served" {
			writeErr(w, http.StatusBadRequest, "bad_request", "kitchen_status must be in_progress|ready|served")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "kitchen.update_ticket",
			"item_id", itemID, "kitchen_status", next)

		tx := appctx.Tx(r.Context())

		var current string
		var orderID uuid.UUID
		err = tx.QueryRow(r.Context(),
			`SELECT kitchen_status::text, order_id FROM order_items WHERE id = $1 AND voided_at IS NULL`,
			itemID,
		).Scan(&current, &orderID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if !validTransition(current, next) {
			writeErr(w, http.StatusConflict, "invalid_transition",
				"cannot move from "+current+" to "+next)
			return
		}

		// Build the SQL based on which timestamp to stamp (only when
		// crossing into a new state; idempotent same-state updates skip).
		if current == next {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		t, _ := appctx.TenantFromContext(r.Context())

		// If the tenant has auto-serve enabled and the kitchen is marking an
		// item 'ready', collapse the ready→served hop in the same write — the
		// waiter doesn't need to tap again. The 'ready' column on the KDS
		// effectively goes unused for that tenant.
		applied := next
		if next == "ready" {
			prefs := loadTenantPreferences(r.Context(), t.ID)
			if prefs.AutoServeOnReady {
				applied = "served"
			}
		}

		stampCol := stampColumn(applied)
		sql := `UPDATE order_items SET kitchen_status = $2`
		if stampCol != "" {
			sql += `, ` + stampCol + ` = COALESCE(` + stampCol + `, now())`
		}
		// When auto-serving past 'ready', stamp ready_at too so reporting
		// still has the kitchen-throughput timestamp.
		if applied == "served" && next == "ready" {
			sql += `, ready_at = COALESCE(ready_at, now())`
		}
		sql += ` WHERE id = $1`
		if _, err := tx.Exec(r.Context(), sql, itemID, applied); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Broadcast to subscribers — hub fan-out is non-blocking.
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicKitchen,
			Action: "order.item.kitchen_status",
			Ref:    map[string]any{"order_id": orderID.String(), "item_id": itemID.String(), "to": applied},
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.item.kitchen_status",
			Ref:    map[string]any{"order_id": orderID.String(), "item_id": itemID.String(), "to": applied},
		})

		w.WriteHeader(http.StatusNoContent)
	}
}

func validTransition(from, to string) bool {
	if from == to {
		return true
	}
	switch from {
	case "in_progress":
		return to == "ready"
	case "ready":
		return to == "served"
	case "pending":
		// Pending → in_progress only happens via send-to-kitchen; reject
		// here so the route's intent stays clear (kitchen UI advances it).
		return false
	}
	return false
}

func stampColumn(state string) string {
	switch state {
	case "in_progress":
		return "sent_to_kitchen_at"
	case "ready":
		return "ready_at"
	case "served":
		return "served_at"
	}
	return ""
}
