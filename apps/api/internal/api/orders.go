package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// types
// =========================================================================

type Order struct {
	ID                 uuid.UUID  `json:"id"`
	ServiceTableID     *uuid.UUID `json:"service_table_id,omitempty"`
	ServiceTableName   *string    `json:"service_table_name,omitempty"`
	Status             string     `json:"status"`
	OpenedByUserID     uuid.UUID  `json:"opened_by_user_id"`
	OpenedAt           time.Time  `json:"opened_at"`
	ClosedAt           *time.Time `json:"closed_at,omitempty"`
	Notes              string     `json:"notes"`
	SubtotalCents      int64      `json:"subtotal_cents"`
	DiscountCents      int64      `json:"discount_cents"`
	TaxCents           int64      `json:"tax_cents"`
	ServiceChargeCents int64      `json:"service_charge_cents"`
	TotalCents         int64      `json:"total_cents"`
	// LiveSubtotalCents is recomputed on every read for OPEN tabs.
	// For closed/cancelled orders, it equals SubtotalCents.
	LiveSubtotalCents int64       `json:"live_subtotal_cents"`
	Items             []OrderItem `json:"items,omitempty"`
	// Per-status item counts (non-voided), populated by list/get for OPEN
	// tabs so the floor + tab UIs can show "all served / settle pending"
	// style summaries without fetching every line.
	ItemsPending    int `json:"items_pending"`
	ItemsInProgress int `json:"items_in_progress"`
	ItemsReady      int `json:"items_ready"`
	ItemsServed     int `json:"items_served"`
	ItemsTotal      int `json:"items_total"`
	// PaidCents is the sum of recorded payments. For closed orders it
	// equals total_cents; for open tabs the FE uses (live total − paid) to
	// decide if a tab is fully paid but still open.
	PaidCents int64 `json:"paid_cents"`
}

type OrderItem struct {
	ID              uuid.UUID  `json:"id"`
	OrderID         uuid.UUID  `json:"order_id"`
	MenuItemID      uuid.UUID  `json:"menu_item_id"`
	MenuItemName    string     `json:"menu_item_name"`
	Qty             int        `json:"qty"`
	UnitPriceCents  int64      `json:"unit_price_cents"`
	LineCents       int64      `json:"line_cents"`
	Modifiers       any        `json:"modifiers"`
	Notes           string     `json:"notes"`
	KitchenStatus   string     `json:"kitchen_status"`
	SentToKitchenAt *time.Time `json:"sent_to_kitchen_at,omitempty"`
	ReadyAt         *time.Time `json:"ready_at,omitempty"`
	ServedAt        *time.Time `json:"served_at,omitempty"`
	VoidedAt        *time.Time `json:"voided_at,omitempty"`
	VoidReason      *string    `json:"void_reason,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

// =========================================================================
// LIST orders (with optional ?status= filter)
// =========================================================================

func ListOrders(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "orders.list",
		"status", r.URL.Query().Get("status"))
	tx := appctx.Tx(r.Context())
	status := r.URL.Query().Get("status")

	args := []any{}
	// Per-order item-status counts and paid_cents are folded in here so the
	// floor + tab UIs can label each tab ("all served · settle pending",
	// "ready to serve", "fully paid · close pending") in a single round-trip.
	q := `
		SELECT o.id, o.service_table_id, st.name, o.status::text, o.opened_by_user_id, o.opened_at,
		       o.closed_at, o.notes,
		       o.subtotal_cents, o.discount_cents, o.tax_cents, o.service_charge_cents, o.total_cents,
		       COALESCE(s.live_subtotal_cents, 0) AS live_subtotal_cents,
		       COALESCE(s.items_pending, 0),
		       COALESCE(s.items_in_progress, 0),
		       COALESCE(s.items_ready, 0),
		       COALESCE(s.items_served, 0),
		       COALESCE(s.items_total, 0),
		       COALESCE(p.paid_cents, 0)
		FROM orders o
		LEFT JOIN service_tables st ON st.id = o.service_table_id
		LEFT JOIN LATERAL (
		  SELECT
		    SUM(qty * unit_price_cents)::bigint                                       AS live_subtotal_cents,
		    COUNT(*) FILTER (WHERE kitchen_status = 'pending')::int                   AS items_pending,
		    COUNT(*) FILTER (WHERE kitchen_status = 'in_progress')::int               AS items_in_progress,
		    COUNT(*) FILTER (WHERE kitchen_status = 'ready')::int                     AS items_ready,
		    COUNT(*) FILTER (WHERE kitchen_status = 'served')::int                    AS items_served,
		    COUNT(*)::int                                                             AS items_total
		  FROM order_items oi
		  WHERE oi.order_id = o.id AND oi.voided_at IS NULL
		) s ON TRUE
		LEFT JOIN LATERAL (
		  SELECT SUM(amount_cents)::bigint AS paid_cents
		  FROM payments WHERE order_id = o.id
		) p ON TRUE
	`
	if status != "" {
		q += ` WHERE o.status = $1`
		args = append(args, status)
	}
	q += ` ORDER BY o.opened_at DESC LIMIT 100`

	rows, err := tx.Query(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []Order{}
	for rows.Next() {
		o := Order{}
		if err := rows.Scan(&o.ID, &o.ServiceTableID, &o.ServiceTableName, &o.Status,
			&o.OpenedByUserID, &o.OpenedAt, &o.ClosedAt, &o.Notes,
			&o.SubtotalCents, &o.DiscountCents, &o.TaxCents, &o.ServiceChargeCents, &o.TotalCents,
			&o.LiveSubtotalCents,
			&o.ItemsPending, &o.ItemsInProgress, &o.ItemsReady, &o.ItemsServed, &o.ItemsTotal,
			&o.PaidCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, o)
	}
	writeJSON(w, http.StatusOK, map[string]any{"orders": out})
}

// =========================================================================
// GET single order with items
// =========================================================================

func GetOrder(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "orders.get", "id", id)
	tx := appctx.Tx(r.Context())

	o := Order{}
	err = tx.QueryRow(r.Context(), `
		SELECT o.id, o.service_table_id, st.name, o.status::text, o.opened_by_user_id, o.opened_at,
		       o.closed_at, o.notes,
		       o.subtotal_cents, o.discount_cents, o.tax_cents, o.service_charge_cents, o.total_cents
		FROM orders o
		LEFT JOIN service_tables st ON st.id = o.service_table_id
		WHERE o.id = $1
	`, id).Scan(&o.ID, &o.ServiceTableID, &o.ServiceTableName, &o.Status,
		&o.OpenedByUserID, &o.OpenedAt, &o.ClosedAt, &o.Notes,
		&o.SubtotalCents, &o.DiscountCents, &o.TaxCents, &o.ServiceChargeCents, &o.TotalCents)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	rows, err := tx.Query(r.Context(), `
		SELECT oi.id, oi.order_id, oi.menu_item_id, mi.name, oi.qty, oi.unit_price_cents,
		       (oi.qty * oi.unit_price_cents)::bigint AS line_cents,
		       oi.modifiers, oi.notes, oi.kitchen_status::text,
		       oi.sent_to_kitchen_at, oi.ready_at, oi.served_at,
		       oi.voided_at, oi.void_reason, oi.created_at
		FROM order_items oi
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE oi.order_id = $1
		ORDER BY oi.created_at
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	o.Items = []OrderItem{}
	var live int64
	for rows.Next() {
		it := OrderItem{}
		var mod []byte
		if err := rows.Scan(&it.ID, &it.OrderID, &it.MenuItemID, &it.MenuItemName,
			&it.Qty, &it.UnitPriceCents, &it.LineCents, &mod, &it.Notes, &it.KitchenStatus,
			&it.SentToKitchenAt, &it.ReadyAt, &it.ServedAt,
			&it.VoidedAt, &it.VoidReason, &it.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		_ = json.Unmarshal(mod, &it.Modifiers)
		if it.VoidedAt == nil {
			live += it.LineCents
			o.ItemsTotal++
			switch it.KitchenStatus {
			case "pending":
				o.ItemsPending++
			case "in_progress":
				o.ItemsInProgress++
			case "ready":
				o.ItemsReady++
			case "served":
				o.ItemsServed++
			}
		}
		o.Items = append(o.Items, it)
	}
	o.LiveSubtotalCents = live

	if err := tx.QueryRow(r.Context(),
		`SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM payments WHERE order_id = $1`, id,
	).Scan(&o.PaidCents); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, o)
}

// =========================================================================
// OPEN a tab — POST /v1/orders
// =========================================================================

func OpenOrder(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _ := appctx.UserFromContext(r.Context())
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			ServiceTableID *uuid.UUID `json:"service_table_id"`
			Notes          string     `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.open",
			"service_table_id", ifNotNilUUID(body.ServiceTableID))
		tx := appctx.Tx(r.Context())

		var o Order
		err := tx.QueryRow(r.Context(), `
		INSERT INTO orders (tenant_id, service_table_id, opened_by_user_id, notes)
		VALUES ($1, $2, $3, $4)
		RETURNING id, service_table_id, status::text, opened_by_user_id, opened_at, notes,
		          subtotal_cents, discount_cents, tax_cents, service_charge_cents, total_cents
	`, t.ID, body.ServiceTableID, user.ID, body.Notes).Scan(
			&o.ID, &o.ServiceTableID, &o.Status, &o.OpenedByUserID, &o.OpenedAt, &o.Notes,
			&o.SubtotalCents, &o.DiscountCents, &o.TaxCents, &o.ServiceChargeCents, &o.TotalCents)
		if err != nil {
			// Unique-violation on the partial index = table already has an open tab.
			if isUniqueViolation(err) {
				writeErr(w, http.StatusConflict, "tab_already_open", "this table already has an open tab")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Flip the table to occupied if one was specified.
		tableLabel := "(walk-in)"
		if body.ServiceTableID != nil {
			_, _ = tx.Exec(r.Context(),
				`UPDATE service_tables SET status = 'occupied' WHERE id = $1 AND status = 'free'`,
				*body.ServiceTableID)
			_ = tx.QueryRow(r.Context(),
				`SELECT name FROM service_tables WHERE id = $1`, *body.ServiceTableID).Scan(&tableLabel)
		}
		o.Items = []OrderItem{}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "open", Entity: "order", EntityID: &o.ID,
			Summary: fmt.Sprintf("opened order on %s", tableLabel),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicTables,
			Action: "table.occupied",
			Ref: map[string]any{
				"order_id":         o.ID.String(),
				"service_table_id": ifNotNilUUID(o.ServiceTableID),
			},
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.opened",
			Ref:    map[string]any{"order_id": o.ID.String()},
		})

		writeJSON(w, http.StatusCreated, o)
	}
}

// =========================================================================
// ADD ITEMS to a tab — POST /v1/orders/:id/items
// Body: { items: [{ id?, menu_item_id, qty, notes?, modifiers? }] }
// Captures unit_price_cents from menu_items at insert-time.
//
// Idempotency: the client MAY supply the line id (a fresh UUID). A replayed
// request (offline-queue retry, double-tap on flaky wifi) then hits
// ON CONFLICT (id) DO NOTHING and gets the already-inserted row back instead
// of double-adding. Without an id the server generates one (legacy path).
// =========================================================================

func AddOrderItems(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			Items []struct {
				ID         *uuid.UUID `json:"id"`
				MenuItemID uuid.UUID  `json:"menu_item_id"`
				Qty        int        `json:"qty"`
				Notes      string     `json:"notes"`
				Modifiers  any        `json:"modifiers"`
			} `json:"items"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Items) == 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "items required")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.add_items",
			"order_id", orderID, "count", len(body.Items))
		tx := appctx.Tx(r.Context())

		// Order must exist and be open.
		var status string
		if err := tx.QueryRow(r.Context(), `SELECT status::text FROM orders WHERE id = $1`, orderID).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "order not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open", "cannot add items to a "+status+" order")
			return
		}

		added := []OrderItem{}
		for _, in := range body.Items {
			if in.Qty <= 0 {
				in.Qty = 1
			}
			mod, err := json.Marshal(in.Modifiers)
			if err != nil || string(mod) == "null" {
				mod = []byte("{}")
			}
			// Look up the active price + cost atomically. Cost is captured
			// onto the order_items row so later edits to menu_items.cost_cents
			// don't rewrite history.
			var price int64
			var cost *int64
			var menuName string
			if err := tx.QueryRow(r.Context(), `
			SELECT price_cents, cost_cents, name FROM menu_items
			WHERE id = $1 AND deleted_at IS NULL AND is_active = true
		`, in.MenuItemID).Scan(&price, &cost, &menuName); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeErr(w, http.StatusBadRequest, "menu_item_not_found",
						"menu item not found or inactive")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			var unitCost int64
			if cost != nil {
				unitCost = *cost
			}
			// Client-supplied id (or a fresh one). ON CONFLICT (id) DO NOTHING
			// makes a replay a no-op; the follow-up SELECT returns the row the
			// first attempt inserted so the response is identical either way.
			lineID := uuid.New()
			if in.ID != nil && *in.ID != uuid.Nil {
				lineID = *in.ID
			}
			if _, err := tx.Exec(r.Context(), `
			INSERT INTO order_items (id, tenant_id, order_id, menu_item_id, qty, unit_price_cents, unit_cost_cents, modifiers, notes)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (id) DO NOTHING
		`, lineID, t.ID, orderID, in.MenuItemID, in.Qty, price, unitCost, mod, in.Notes); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			it := OrderItem{}
			var modOut []byte
			err = tx.QueryRow(r.Context(), `
			SELECT id, order_id, menu_item_id, qty, unit_price_cents,
			       (qty * unit_price_cents)::bigint, modifiers, notes,
			       kitchen_status::text, sent_to_kitchen_at, ready_at, served_at,
			       voided_at, void_reason, created_at
			FROM order_items WHERE id = $1 AND order_id = $2
		`, lineID, orderID).Scan(
				&it.ID, &it.OrderID, &it.MenuItemID, &it.Qty, &it.UnitPriceCents, &it.LineCents,
				&modOut, &it.Notes, &it.KitchenStatus, &it.SentToKitchenAt, &it.ReadyAt, &it.ServedAt,
				&it.VoidedAt, &it.VoidReason, &it.CreatedAt)
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					// The id exists but belongs to a different order — a client
					// bug or a forged replay. Refuse rather than report success.
					writeErr(w, http.StatusConflict, "item_id_conflict", "item id already used by another order")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			_ = json.Unmarshal(modOut, &it.Modifiers)
			it.MenuItemName = menuName
			added = append(added, it)
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.items.added",
			Ref:    map[string]any{"order_id": orderID.String(), "count": len(added)},
		})

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "order", EntityID: &orderID,
			Summary: fmt.Sprintf("added %d item(s) to order", len(added)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{"items": added})
	}
}

// =========================================================================
// UPDATE an order item — PATCH /v1/orders/:id/items/:itemId
// (qty, notes, modifiers — only allowed while still 'pending')
// =========================================================================

func UpdateOrderItem(w http.ResponseWriter, r *http.Request) {
	itemID, err := uuid.Parse(chi.URLParam(r, "itemId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid item id")
		return
	}
	var body struct {
		Qty       *int    `json:"qty"`
		Notes     *string `json:"notes"`
		Modifiers any     `json:"modifiers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "orders.update_item", "item_id", itemID)

	tx := appctx.Tx(r.Context())

	// Only allow edits while still pending (not yet sent to kitchen).
	var ks string
	if err := tx.QueryRow(r.Context(),
		`SELECT kitchen_status::text FROM order_items WHERE id = $1 AND voided_at IS NULL`, itemID,
	).Scan(&ks); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ks != "pending" {
		writeErr(w, http.StatusConflict, "already_sent",
			"cannot edit an item that's already with the kitchen — void it instead")
		return
	}

	var modBytes []byte = nil
	if body.Modifiers != nil {
		if b, err := json.Marshal(body.Modifiers); err == nil {
			modBytes = b
		}
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE order_items
		SET qty       = COALESCE($2, qty),
		    notes     = COALESCE($3, notes),
		    modifiers = COALESCE($4::jsonb, modifiers)
		WHERE id = $1 AND voided_at IS NULL
	`, itemID, body.Qty, body.Notes, modBytes); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "order_item", EntityID: &itemID,
		Summary: "updated order item",
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// SEND TO KITCHEN — POST /v1/orders/:id/send-to-kitchen
// Flips all 'pending' items on this order to 'in_progress'.
// =========================================================================

func SendOrderToKitchen(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.send_to_kitchen", "order_id", orderID)
		tx := appctx.Tx(r.Context())

		cmd, err := tx.Exec(r.Context(), `
		UPDATE order_items
		SET kitchen_status = 'in_progress',
		    sent_to_kitchen_at = now()
		WHERE order_id = $1
		  AND kitchen_status = 'pending'
		  AND voided_at IS NULL
	`, orderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if cmd.RowsAffected() > 0 {
			t, _ := appctx.TenantFromContext(r.Context())
			hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
				Topic:  realtime.TopicKitchen,
				Action: "tickets.new",
				Ref:    map[string]any{"order_id": orderID.String(), "count": cmd.RowsAffected()},
			})
			hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
				Topic:  realtime.TopicOrders,
				Action: "order.items.sent",
				Ref:    map[string]any{"order_id": orderID.String()},
			})
			if err := audit.Log(r.Context(), tx, audit.Entry{
				Action: "update", Entity: "order", EntityID: &orderID,
				Summary: fmt.Sprintf("sent %d item(s) to kitchen", cmd.RowsAffected()),
			}); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"sent": cmd.RowsAffected()})
	}
}

// =========================================================================
// VOID AN ITEM — POST /v1/orders/:id/items/:itemId/void
// Manager approval enforced in M11; for now any member can void with reason.
// =========================================================================

func VoidOrderItem(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		itemID, err := uuid.Parse(chi.URLParam(r, "itemId"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid item id")
			return
		}
		user, _ := appctx.UserFromContext(r.Context())

		var body struct {
			Reason string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.void_item",
			"item_id", itemID, "has_reason", body.Reason != "")

		// Pre-kitchen voids are friction-free: any active member can drop
		// a pending line with no reason and no manager approval. Once the
		// ticket has gone to the kitchen we treat it as a financial event:
		// reason becomes mandatory and an approver is required.
		tx := appctx.Tx(r.Context())
		var kitchenStatus string
		var voidedAt *time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT kitchen_status::text, voided_at FROM order_items WHERE id = $1`, itemID,
		).Scan(&kitchenStatus, &voidedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Replay-safe: voiding an already-voided line is a no-op success, not
		// a 404 — an offline-queue retry must not surface as an error.
		if voidedAt != nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		alreadySent := kitchenStatus != "pending"

		// Permission gate is mounted on the route (order:void_item). The
		// post-kitchen path still requires a reason so the audit log captures
		// why; the actor is the approver now that PIN-approvals are gone.
		if alreadySent && body.Reason == "" {
			writeErr(w, http.StatusBadRequest, "reason_required",
				"reason is required for items already sent to the kitchen")
			return
		}
		approverID := user.ID

		cmd, err := tx.Exec(r.Context(), `
			UPDATE order_items
			SET voided_at                = now(),
			    voided_by_user_id        = $2,
			    void_reason              = $3,
			    void_approved_by_user_id = $4
			WHERE id = $1 AND voided_at IS NULL
		`, itemID, user.ID, body.Reason, approverID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if cmd.RowsAffected() == 0 {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}

		t, _ := appctx.TenantFromContext(r.Context())
		auditEvent(r.Context(), "order.item.voided", "order_item", itemID.String(), map[string]any{
			"reason":      body.Reason,
			"approver_id": approverID.String(),
		})
		summary := "voided order item"
		if body.Reason != "" {
			summary = fmt.Sprintf("voided order item (%s)", body.Reason)
		}
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "void", Entity: "order_item", EntityID: &itemID,
			Summary: summary,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicKitchen,
			Action: "ticket.voided",
			Ref:    map[string]any{"item_id": itemID.String()},
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.item.voided",
			Ref:    map[string]any{"item_id": itemID.String()},
		})
		w.WriteHeader(http.StatusNoContent)
	}
}

// =========================================================================
// CANCEL an order — POST /v1/orders/:id/cancel
// Allowed only if no items have been sent to kitchen.
// =========================================================================

func CancelOrder(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.cancel", "order_id", orderID)
		tx := appctx.Tx(r.Context())

		var sentCount int
		if err := tx.QueryRow(r.Context(), `
		SELECT count(*) FROM order_items
		WHERE order_id = $1 AND sent_to_kitchen_at IS NOT NULL AND voided_at IS NULL
	`, orderID).Scan(&sentCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if sentCount > 0 {
			writeErr(w, http.StatusConflict, "items_in_kitchen",
				"cannot cancel — items are with the kitchen; void them first")
			return
		}

		var serviceTableID *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
		UPDATE orders
		SET status = 'cancelled', cancelled_at = now()
		WHERE id = $1 AND status = 'open'
		RETURNING service_table_id
	`, orderID).Scan(&serviceTableID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Free the table.
		if serviceTableID != nil {
			_, _ = tx.Exec(r.Context(),
				`UPDATE service_tables SET status = 'free' WHERE id = $1 AND status = 'occupied'`,
				*serviceTableID)
		}
		t, _ := appctx.TenantFromContext(r.Context())
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicTables,
			Action: "table.freed",
			Ref:    map[string]any{"order_id": orderID.String(), "service_table_id": ifNotNilUUID(serviceTableID)},
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.cancelled",
			Ref:    map[string]any{"order_id": orderID.String()},
		})
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "order", EntityID: &orderID,
			Summary: "cancelled order",
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// =========================================================================
// MOVE / MERGE a tab — POST /v1/orders/:id/move
// Body: { service_table_id: uuid|null }
//
//   - null target    → detach to take-away (frees the old table)
//   - free table      → transfer the tab (frees old, occupies new)
//   - occupied table  → MERGE this tab's items + adjustments into the table's
//                       existing open order, then retire the (now empty)
//                       source order as cancelled.
//
// Handles the "guests changed tables mid-order" and "assign a walk-in tab to a
// table" flows from one place so there's a single, well-tested path.
// =========================================================================

func MoveOrder(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orderID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		t, _ := appctx.TenantFromContext(r.Context())

		var body struct {
			ServiceTableID *uuid.UUID `json:"service_table_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "orders.move",
			"order_id", orderID, "target_table", ifNotNilUUID(body.ServiceTableID))
		tx := appctx.Tx(r.Context())

		// Source must exist + be open.
		var status string
		var srcTable *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text, service_table_id FROM orders WHERE id = $1`, orderID,
		).Scan(&status, &srcTable); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "order not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open", "only an open tab can be moved")
			return
		}

		target := body.ServiceTableID

		// No-op: the tab is already where it's being moved to.
		if uuidPtrEqual(srcTable, target) {
			writeJSON(w, http.StatusOK, map[string]any{"order_id": orderID.String(), "merged": false})
			return
		}

		// Resolve target label + whether it already carries an open tab.
		targetLabel := "take-away"
		var mergeInto *uuid.UUID
		if target != nil {
			if err := tx.QueryRow(r.Context(),
				`SELECT name FROM service_tables WHERE id = $1 AND deleted_at IS NULL`, *target,
			).Scan(&targetLabel); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeErr(w, http.StatusBadRequest, "table_not_found", "target table not found")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			var existing uuid.UUID
			err := tx.QueryRow(r.Context(),
				`SELECT id FROM orders WHERE service_table_id = $1 AND status = 'open' AND id <> $2`,
				*target, orderID,
			).Scan(&existing)
			if err == nil {
				mergeInto = &existing
			} else if !errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		resultID := orderID
		merged := false
		summary := ""

		if mergeInto != nil {
			// MERGE. Refuse if money has already been recorded on the source —
			// moving payments between tabs is a settlement event, not a move.
			var payCount int
			if err := tx.QueryRow(r.Context(),
				`SELECT count(*) FROM payments WHERE order_id = $1`, orderID,
			).Scan(&payCount); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if payCount > 0 {
				writeErr(w, http.StatusConflict, "settle_before_merge",
					"this tab already has recorded payments — settle or remove them before merging")
				return
			}
			// Re-point items + adjustments onto the destination tab.
			if _, err := tx.Exec(r.Context(),
				`UPDATE order_items SET order_id = $2 WHERE order_id = $1`, orderID, *mergeInto); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if _, err := tx.Exec(r.Context(),
				`UPDATE order_adjustments SET order_id = $2 WHERE order_id = $1`, orderID, *mergeInto); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			// Retire the (now empty) source. Done directly so the kitchen-sent
			// guard on CancelOrder doesn't block it — its items already moved.
			mergeNote := fmt.Sprintf("merged into %s", targetLabel)
			if _, err := tx.Exec(r.Context(), `
				UPDATE orders
				SET status = 'cancelled', cancelled_at = now(),
				    notes = CASE WHEN notes = '' THEN $2 ELSE notes || ' · ' || $2 END
				WHERE id = $1 AND status = 'open'
			`, orderID, mergeNote); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			resultID = *mergeInto
			merged = true
			summary = fmt.Sprintf("merged tab into %s", targetLabel)
		} else {
			// TRANSFER or DETACH — re-point the order itself.
			if _, err := tx.Exec(r.Context(),
				`UPDATE orders SET service_table_id = $2 WHERE id = $1`, orderID, target); err != nil {
				if isUniqueViolation(err) {
					writeErr(w, http.StatusConflict, "tab_already_open", "that table already has an open tab")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if target != nil {
				_, _ = tx.Exec(r.Context(),
					`UPDATE service_tables SET status = 'occupied' WHERE id = $1 AND status <> 'occupied'`, *target)
				summary = fmt.Sprintf("moved tab to %s", targetLabel)
			} else {
				summary = "moved tab to take-away"
			}
		}

		// Free the vacated table in every branch (transfer, detach, merge). A
		// frictionless 'free' (not 'dirty') keeps a wrong-table correction quick.
		if srcTable != nil {
			_, _ = tx.Exec(r.Context(),
				`UPDATE service_tables SET status = 'free' WHERE id = $1 AND status IN ('occupied', 'dirty')`,
				*srcTable)
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "order", EntityID: &orderID, Summary: summary,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicTables,
			Action: "table.moved",
			Ref: map[string]any{
				"order_id": orderID.String(),
				"from":     ifNotNilUUID(srcTable),
				"to":       ifNotNilUUID(target),
			},
		})
		// Invalidate both the source (now retired on merge) and the destination
		// order detail on every connected client.
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.moved",
			Ref:    map[string]any{"order_id": orderID.String()},
		})
		if resultID != orderID {
			hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
				Topic:  realtime.TopicOrders,
				Action: "order.moved",
				Ref:    map[string]any{"order_id": resultID.String()},
			})
		}

		writeJSON(w, http.StatusOK, map[string]any{"order_id": resultID.String(), "merged": merged})
	}
}

func ifNotNilUUID(p *uuid.UUID) any {
	if p == nil {
		return nil
	}
	return p.String()
}

// uuidPtrEqual reports whether two optional UUIDs point at the same value
// (both nil counts as equal — used to short-circuit a no-op table move).
func uuidPtrEqual(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// =========================================================================
// helpers
// =========================================================================

// isUniqueViolation matches pgcode 23505. We avoid pulling pgconn.PgError
// directly to keep this file compact — string match is fine for one code.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return contains(s, "23505") || contains(s, "duplicate key")
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
