package main

// The unhappy path, on purpose.
//
// messy-cafe carries one instance of each drift pattern platform_accuracy_check
// reports. Two reasons that matters:
//
//  1. You can see what a violation looks like in the UI, and confirm the check
//     catches it, without corrupting a tenant you're demoing.
//  2. verify.go asserts the check finds EXACTLY these — so if a future change
//     stops detecting one, seeding fails loudly instead of the check quietly
//     going blind.
//
// Every write here bypasses a handler guard on purpose. None of it is reachable
// through the API any more; these are the shapes legacy rows can have.

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// expectedMessyChecks is the contract: these check keys, and only these, must
// fire for messy-cafe. Keep it in step with breakThings.
var expectedMessyChecks = []string{
	"cash_without_shift",
	"credit_without_tab",
	"order_arithmetic",
	"payments_vs_total",
	"post_close_void",
	"shift_expected_cash",
}

func (w *world) breakThings(ctx context.Context, tx pgx.Tx) error {
	pick := func(offset int) (uuid.UUID, error) {
		var id uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT id FROM orders
			WHERE tenant_id = $1 AND status = 'closed'
			ORDER BY closed_at DESC OFFSET $2 LIMIT 1
		`, w.tenantID, offset).Scan(&id)
		return id, err
	}

	// 1. A line voided AFTER its order closed. The order's totals are frozen, so
	//    they no longer match the lines behind them — and the payments now exceed
	//    the recomputed line sum.
	if id, err := pick(0); err == nil {
		if _, err := tx.Exec(ctx, `
			UPDATE order_items SET voided_at = (
			    SELECT closed_at + interval '20 minutes' FROM orders WHERE id = $1
			  ), voided_by_user_id = $2, void_reason = 'voided after settling (legacy)'
			WHERE order_id = $1 AND voided_at IS NULL
			  AND id = (SELECT id FROM order_items WHERE order_id = $1 AND voided_at IS NULL LIMIT 1)
		`, id, w.owner); err != nil {
			return fmt.Errorf("messy post-close void: %w", err)
		}
	}

	// 2. A stored total that doesn't reconcile with its components, as an
	//    uncapped discount used to produce (buildQuote clamped the base at zero).
	if id, err := pick(1); err == nil {
		if _, err := tx.Exec(ctx, `
			UPDATE orders SET discount_cents = subtotal_cents + 5000 WHERE id = $1
		`, id); err != nil {
			return fmt.Errorf("messy arithmetic: %w", err)
		}
	}

	// 3. Payments that no longer equal the order total — what deleting a payment
	//    out of a closed shift used to leave behind.
	if id, err := pick(2); err == nil {
		if _, err := tx.Exec(ctx,
			`UPDATE payments SET amount_cents = amount_cents - 1500 WHERE order_id = $1`, id); err != nil {
			return fmt.Errorf("messy payments: %w", err)
		}
	}

	// 4. Cash taken outside any shift: in the cash ledger, invisible to every
	//    drawer count. Target an actual CASH payment — picking the Nth order and
	//    hoping it was paid in cash silently does nothing when it wasn't, which is
	//    how this pattern first failed to appear.
	if _, err := tx.Exec(ctx, `
		UPDATE payments SET shift_id = NULL
		WHERE id = (
		  SELECT id FROM payments
		  WHERE tenant_id = $1 AND method = 'cash' AND shift_id IS NOT NULL
		  ORDER BY recorded_at DESC LIMIT 1
		)
	`, w.tenantID); err != nil {
		return fmt.Errorf("messy shiftless cash: %w", err)
	}

	// 5. A credit charge attached to no credit account — a receivable that belongs
	//    to nobody, invisible on the Credit page while the order reads as settled.
	if id, err := pick(4); err == nil {
		if _, err := tx.Exec(ctx, `
			UPDATE payments SET method = 'house_tab', house_tab_id = NULL, shift_id = NULL
			WHERE order_id = $1
		`, id); err != nil {
			return fmt.Errorf("messy orphan credit: %w", err)
		}
	}
	// Belt and braces: if that order had no payment row, orphan one directly.
	if _, err := tx.Exec(ctx, `
		UPDATE payments SET method = 'house_tab', house_tab_id = NULL, shift_id = NULL
		WHERE id = (
		  SELECT p.id FROM payments p
		  WHERE p.tenant_id = $1 AND p.method <> 'house_tab'
		  ORDER BY p.recorded_at ASC LIMIT 1
		) AND NOT EXISTS (
		  SELECT 1 FROM payments WHERE tenant_id = $1 AND method = 'house_tab' AND house_tab_id IS NULL
		)
	`, w.tenantID); err != nil {
		return fmt.Errorf("messy orphan credit fallback: %w", err)
	}

	// 6. A closed shift whose stamped expected cash no longer matches its rows.
	if _, err := tx.Exec(ctx, `
		UPDATE shifts SET expected_cash_cents = expected_cash_cents + 7500
		WHERE tenant_id = $1 AND closed_at IS NOT NULL
		  AND id = (SELECT id FROM shifts WHERE tenant_id = $1 AND closed_at IS NOT NULL
		            ORDER BY closed_at DESC LIMIT 1)
	`, w.tenantID); err != nil {
		return fmt.Errorf("messy shift drift: %w", err)
	}

	// Also leave one legitimately reversed credit collection, so the UI has a
	// reversed row to render. This is CORRECT data — a reversal is the supported
	// way to fix a mis-entry — so the accuracy check must NOT flag it.
	if len(w.tabs) > 0 {
		at := time.Now().Add(-36 * time.Hour)
		var setID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO house_tab_settlements
			  (tenant_id, house_tab_id, amount_cents, payment_method, notes, recorded_by_user_id, recorded_at)
			VALUES ($1, $2, 2500, 'cash'::payment_method, 'entered on the wrong tab', $3, $4)
			RETURNING id
		`, w.tenantID, w.tabs[0], w.owner, at).Scan(&setID); err != nil {
			return fmt.Errorf("messy reversed collection: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE house_tab_settlements
			SET reversed_at = $2, reversed_by_user_id = $3, reversal_reason = 'wrong tab'
			WHERE id = $1
		`, setID, at.Add(time.Hour), w.owner); err != nil {
			return fmt.Errorf("messy reversal: %w", err)
		}
	}
	return nil
}
