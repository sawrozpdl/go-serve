package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// /v1/orders/history?date=YYYY-MM-DD&table_id=<uuid?>
//
// Day-wise list of CLOSED serves (in the tenant timezone), optionally filtered
// to a single table. Each serve carries its full line items (voided rows
// included so the UI can show them struck-through) and how it was paid. Powers
// the History page: "show me everything served on Table A today".
// =========================================================================

type HistoryPayment struct {
	Method      string `json:"method"`
	AmountCents int64  `json:"amount_cents"`
	ReferenceNo string `json:"reference_no"`
}

type HistoryOrder struct {
	ID                 uuid.UUID  `json:"id"`
	ServiceTableID     *uuid.UUID `json:"service_table_id,omitempty"`
	ServiceTableName   *string    `json:"service_table_name,omitempty"`
	OpenedAt           time.Time  `json:"opened_at"`
	ClosedAt           *time.Time `json:"closed_at,omitempty"`
	Notes              string     `json:"notes"`
	SubtotalCents      int64      `json:"subtotal_cents"`
	DiscountCents      int64      `json:"discount_cents"`
	TaxCents           int64      `json:"tax_cents"`
	ServiceChargeCents int64      `json:"service_charge_cents"`
	TotalCents         int64      `json:"total_cents"`
	ItemCount          int        `json:"item_count"`
	Items              []OrderItem      `json:"items"`
	Payments           []HistoryPayment `json:"payments"`
}

func GetOrderHistory(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	tz := t.Timezone
	if tz == "" {
		tz = "Asia/Kathmandu"
	}
	tx := appctx.Tx(r.Context())

	// Date defaults to "today" in the tenant timezone. Validate any explicit
	// value so a malformed string can't reach the SQL ::date cast.
	date := r.URL.Query().Get("date")
	if date == "" {
		if err := tx.QueryRow(r.Context(),
			`SELECT (now() AT TIME ZONE $1)::date::text`, tz).Scan(&date); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	} else if _, err := time.Parse("2006-01-02", date); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "date must be YYYY-MM-DD")
		return
	}

	// Optional table filter. Empty → all tables (and take-away).
	var tableID *uuid.UUID
	if raw := r.URL.Query().Get("table_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid table_id")
			return
		}
		tableID = &id
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "orders.history", "date", date, "table_id", ifNotNilUUID(tableID))

	// Day window: local midnight → next local midnight, converted to the UTC
	// instants used by the timestamptz column.
	rows, err := tx.Query(r.Context(), `
		SELECT o.id, o.service_table_id, st.name, o.opened_at, o.closed_at, o.notes,
		       o.subtotal_cents, o.discount_cents, o.tax_cents, o.service_charge_cents, o.total_cents
		FROM orders o
		LEFT JOIN service_tables st ON st.id = o.service_table_id
		WHERE o.status = 'closed'
		  AND o.closed_at >= ($1::date)::timestamp AT TIME ZONE $3
		  AND o.closed_at <  (($1::date) + 1)::timestamp AT TIME ZONE $3
		  AND ($2::uuid IS NULL OR o.service_table_id = $2)
		ORDER BY o.closed_at DESC
	`, date, tableID, tz)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []HistoryOrder{}
	byID := map[uuid.UUID]*HistoryOrder{}
	ids := []uuid.UUID{}
	for rows.Next() {
		o := HistoryOrder{Items: []OrderItem{}, Payments: []HistoryPayment{}}
		if err := rows.Scan(&o.ID, &o.ServiceTableID, &o.ServiceTableName, &o.OpenedAt, &o.ClosedAt, &o.Notes,
			&o.SubtotalCents, &o.DiscountCents, &o.TaxCents, &o.ServiceChargeCents, &o.TotalCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, o)
		ids = append(ids, o.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for i := range out {
		byID[out[i].ID] = &out[i]
	}

	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"date": date, "timezone": tz, "orders": out})
		return
	}

	// Line items for every serve in the window, in one pass.
	irows, err := tx.Query(r.Context(), `
		SELECT oi.id, oi.order_id, oi.menu_item_id, mi.name, oi.qty, oi.unit_price_cents,
		       (oi.qty * oi.unit_price_cents)::bigint AS line_cents,
		       oi.modifiers, oi.notes, oi.kitchen_status::text,
		       oi.sent_to_kitchen_at, oi.ready_at, oi.served_at,
		       oi.voided_at, oi.void_reason, oi.created_at
		FROM order_items oi
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE oi.order_id = ANY($1)
		ORDER BY oi.created_at
	`, ids)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer irows.Close()
	for irows.Next() {
		it := OrderItem{}
		var mod []byte
		if err := irows.Scan(&it.ID, &it.OrderID, &it.MenuItemID, &it.MenuItemName,
			&it.Qty, &it.UnitPriceCents, &it.LineCents, &mod, &it.Notes, &it.KitchenStatus,
			&it.SentToKitchenAt, &it.ReadyAt, &it.ServedAt,
			&it.VoidedAt, &it.VoidReason, &it.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		_ = json.Unmarshal(mod, &it.Modifiers)
		if o := byID[it.OrderID]; o != nil {
			o.Items = append(o.Items, it)
			if it.VoidedAt == nil {
				o.ItemCount += it.Qty
			}
		}
	}
	irows.Close()
	if err := irows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// How each serve was paid.
	prows, err := tx.Query(r.Context(), `
		SELECT order_id, method::text, amount_cents, reference_no
		FROM payments
		WHERE order_id = ANY($1)
		ORDER BY recorded_at
	`, ids)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer prows.Close()
	for prows.Next() {
		var oid uuid.UUID
		var p HistoryPayment
		if err := prows.Scan(&oid, &p.Method, &p.AmountCents, &p.ReferenceNo); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if o := byID[oid]; o != nil {
			o.Payments = append(o.Payments, p)
		}
	}
	prows.Close()
	if err := prows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"date": date, "timezone": tz, "orders": out})
}
