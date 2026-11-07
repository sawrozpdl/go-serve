package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// Corrections to issued IRD invoices (0093): sales returns and reverse
// entries. The invoice itself is never touched.
// =========================================================================

// POST /v1/invoices/{id}/credit-notes — fiscal:correct
//
//	{"kind": "sales_return" | "reversal", "reason": "...",
//	 "lines": [{"line_no": 1, "qty": "1"}],      // sales_return; omit = all
//	 "refund_method": "cash" | "online" | "credit", "refund_reference": "...",
//	 "reopen": true}                               // reversal: re-bill it
//
// "reopen" is the restaurant fix for a bill closed wrong (wrong method, wrong
// table, a missed item): the reverse entry cancels it, and the same lines are
// put on a new open order to settle again. The stock taken by the first close
// is put back, because the re-bill's close takes it again.
func CreateCreditNote(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		invID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid invoice id")
			return
		}
		var body struct {
			Kind            string              `json:"kind"`
			Reason          string              `json:"reason"`
			Lines           []fiscal.ReturnLine `json:"lines"`
			RefundMethod    string              `json:"refund_method"`
			RefundReference string              `json:"refund_reference"`
			Reopen          bool                `json:"reopen"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if body.Reopen && body.Kind != "reversal" {
			writeErr(w, http.StatusBadRequest, "bad_request", "only a reverse entry can re-open a bill")
			return
		}
		t, _ := appctx.TenantFromContext(r.Context())
		u, _ := appctx.UserFromContext(r.Context())
		tx := appctx.Tx(r.Context())

		cn, err := fiscal.IssueCreditNote(r.Context(), tx, fiscal.CreditParams{
			TenantID: t.ID, InvoiceID: invID, UserID: u.ID, Kind: body.Kind, Reason: body.Reason,
			Lines: body.Lines, RefundMethod: body.RefundMethod, RefundRef: body.RefundReference,
		})
		if err != nil {
			var ce *fiscal.CreditError
			var pgErr *pgconn.PgError
			switch {
			case errors.As(err, &ce):
				writeErr(w, ce.Status, ce.Code, ce.Msg)
			case errors.As(err, &pgErr) && (pgErr.Hint == "fiscal_over_credit" || pgErr.Hint == "fiscal_reversal_whole"):
				writeErr(w, http.StatusConflict, "over_credit", pgErr.Message)
			default:
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			}
			return
		}

		if body.Reopen {
			newID, err := reopenAsNewOrder(r.Context(), tx, t.ID, u.ID, cn)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", "re-open bill: "+err.Error())
				return
			}
			cn.ReopenedOrderID = &newID
			hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
				Topic: realtime.TopicOrders, Action: "order.opened", Ref: map[string]any{"order_id": newID.String()},
			})
		}

		kind := map[string]string{"sales_return": "sales return", "reversal": "reverse entry"}[cn.Kind]
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "credit_note", EntityID: &cn.ID,
			Summary: fmt.Sprintf("issued %s %s for bill %s (%s, refund %s): %s",
				kind, cn.Number, cn.InvoiceNumber, audit.Money(cn.TotalCents), cn.RefundMethod, cn.Reason),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, cn)
	}
}

// reopenAsNewOrder puts a reversed bill's lines (with their add-ons and
// prices as charged) on a new open order, and returns the stock its first
// close consumed.
func reopenAsNewOrder(ctx context.Context, tx pgx.Tx, tenantID, userID uuid.UUID, cn *fiscal.CreditNote) (uuid.UUID, error) {
	var oldOrder uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_id FROM invoices WHERE id = $1`, cn.InvoiceID).Scan(&oldOrder); err != nil {
		return uuid.Nil, err
	}
	var newID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO orders (tenant_id, status, opened_by_user_id, order_type, table_label, notes)
		SELECT tenant_id, 'open', $2, order_type, $3, $4 FROM orders WHERE id = $1
		RETURNING id
	`, oldOrder, userID, "Re-bill "+cn.InvoiceNumber,
		fmt.Sprintf("Re-bill of bill %s (FY %s), cancelled by reverse entry %s: %s", cn.InvoiceNumber, cn.InvoiceFY, cn.Number, cn.Reason),
	).Scan(&newID); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(ctx, `
		WITH src AS (
		  SELECT oi.*, gen_random_uuid() AS new_id
		  FROM order_items oi WHERE oi.order_id = $1 AND oi.voided_at IS NULL
		), lines AS (
		  INSERT INTO order_items (id, tenant_id, order_id, menu_item_id, menu_item_name, qty, unit_price_cents,
		    unit_cost_cents, base_price_cents, base_cost_cents, modifiers, notes, kitchen_status,
		    sent_to_kitchen_at, ready_at, served_at, outlet_id)
		  SELECT new_id, tenant_id, $2, menu_item_id, menu_item_name, qty, unit_price_cents,
		    unit_cost_cents, base_price_cents, base_cost_cents, modifiers, notes, 'served',
		    now(), now(), now(), outlet_id
		  FROM src
		  RETURNING id
		)
		INSERT INTO order_item_modifiers (tenant_id, order_item_id, modifier_id, group_name, name, price_cents, cost_cents, qty)
		SELECT m.tenant_id, src.new_id, m.modifier_id, m.group_name, m.name, m.price_cents, m.cost_cents, m.qty
		FROM order_item_modifiers m JOIN src ON src.id = m.order_item_id
	`, oldOrder, newID); err != nil {
		return uuid.Nil, err
	}
	// Give back what the first close took; the re-bill's close takes it again.
	if _, err := tx.Exec(ctx, `
		INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, ref_type, ref_id, by_user_id, notes)
		SELECT $2, c.inventory_item_id, c.qty::numeric * c.qty_consumed_per_sale::numeric, 'adjust', 'credit_note', $3, $4,
		       'returned by reverse entry ' || $5 || ' (re-billed)'
		FROM (`+orderConsumptionSQL+`) AS c(order_item_id, qty, inventory_item_id, qty_consumed_per_sale)
		WHERE c.qty::numeric * c.qty_consumed_per_sale::numeric <> 0
	`, oldOrder, tenantID, cn.ID, userID, cn.Number); err != nil {
		return uuid.Nil, err
	}
	return newID, nil
}

// POST /v1/credit-notes/{id}/print — fiscal:print
func PrintCreditNote(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid credit note id")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	cn, err := fiscal.LoadCreditNote(r.Context(), tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	label, err := fiscal.RecordPrint(r.Context(), tx, t.ID, "credit_note", cn.ID, u.ID,
		func(n int) fiscal.PrintLabel { return fiscal.CreditNotePrintLabel(cn.Kind, n) }, "")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "print", Entity: "credit_note", EntityID: &cn.ID,
		Summary: fmt.Sprintf("printed %s %s (%s)", label.Title, cn.Number, label.CopyLabel),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"copy_no": label.CopyNo, "title": label.Title, "title_ne": label.TitleNE, "copy_label": label.CopyLabel,
		"credit_note": cn,
	})
}
