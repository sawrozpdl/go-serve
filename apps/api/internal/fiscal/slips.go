package fiscal

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
)

// OrderSlip is a numbered kitchen order ticket (KOT). Procedure 2082 §6.2(घ):
// hotels and restaurants may use order slips, which must be numbered in
// sequence, logged, and linked to the invoice. The link is the order: every
// slip of an order and its invoice share order_id.
type OrderSlip struct {
	ID         uuid.UUID       `json:"id"`
	OrderID    uuid.UUID       `json:"order_id"`
	FiscalYear string          `json:"fiscal_year"`
	Seq        int64           `json:"seq"`
	Number     string          `json:"number"`
	SentAt     time.Time       `json:"sent_at"`
	BSDate     string          `json:"bs_date"`
	SentByName string          `json:"sent_by_name"`
	Lines      []OrderSlipLine `json:"lines"`
}

// OrderSlipLine is one line the slip carried to the kitchen.
type OrderSlipLine struct {
	OrderItemID uuid.UUID  `json:"order_item_id"`
	Name        string     `json:"name"`
	Qty         string     `json:"qty"`
	Notes       string     `json:"notes,omitempty"`
	OutletID    *uuid.UUID `json:"outlet_id,omitempty"`
}

// RecordOrderSlip numbers and logs the lines that the current transaction
// just sent to the kitchen. It must run in the same transaction as the
// send, after the UPDATEs: those stamp sent_to_kitchen_at = now(), and now()
// is the transaction's start time, so "sent in this transaction" is exactly
// sent_to_kitchen_at = now(). Returns (nil, nil) for a café not in fiscal mode,
// or when nothing was sent.
func RecordOrderSlip(ctx context.Context, tx pgx.Tx, tenantID, orderID, userID uuid.UUID) (*OrderSlip, error) {
	prof, err := LoadProfile(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if !prof.FiscalMode() {
		return nil, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT id, menu_item_name, qty::text, COALESCE(notes, ''), outlet_id
		FROM order_items
		WHERE order_id = $1 AND voided_at IS NULL AND sent_to_kitchen_at = now()
		ORDER BY created_at, id
	`, orderID)
	if err != nil {
		return nil, err
	}
	var lines []OrderSlipLine
	for rows.Next() {
		var l OrderSlipLine
		if err := rows.Scan(&l.OrderItemID, &l.Name, &l.Qty, &l.Notes, &l.OutletID); err != nil {
			rows.Close()
			return nil, err
		}
		lines = append(lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return nil, nil
	}

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return nil, err
	}
	bs, err := bsdate.FromTime(now)
	if err != nil {
		return nil, err
	}
	fy := bsdate.FiscalYearOf(bs)
	seq, err := NextNumber(ctx, tx, tenantID, DocOrderSlip, fy)
	if err != nil {
		return nil, err
	}
	slip := &OrderSlip{
		OrderID: orderID, FiscalYear: fy.String(), Seq: seq,
		Number: FormatNumber(prof.OutletCode, "KOT", seq),
		SentAt: now, BSDate: bs.String(), Lines: lines,
	}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(NULLIF(name, ''), email) FROM users WHERE id = $1`, userID).
		Scan(&slip.SentByName); err != nil {
		return nil, fmt.Errorf("fiscal: load sender: %w", err)
	}
	raw, err := json.Marshal(lines)
	if err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO order_slips (tenant_id, order_id, fiscal_year, seq, number, sent_at, bs_date, sent_by, sent_by_name, lines)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id
	`, tenantID, orderID, slip.FiscalYear, slip.Seq, slip.Number, slip.SentAt, slip.BSDate, userID, slip.SentByName, raw).
		Scan(&slip.ID); err != nil {
		return nil, fmt.Errorf("fiscal: insert order slip: %w", err)
	}
	return slip, nil
}
