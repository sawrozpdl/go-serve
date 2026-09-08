package api

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// =========================================================================
// Category-wise discounts (migration 0078)
//
// A café can put a standing promotion on a menu category — "10% off breakfast,
// 15% off desserts" — and it applies to every bill without the cashier doing
// anything.
//
// The percentage lives on menu_categories.discount_percent_bp, but the DISCOUNT
// lives where every other discount lives: as ordinary order_adjustments rows of
// type='discount', reason='promotion', tagged with the category they came from.
// syncCategoryPromotions materialises them.
//
// WHY MATERIALISE RATHER THAN DERIVE IN buildQuote
//
// Deriving would be less code and wrong. order_adjustments would stop being the
// complete record of what came off a bill, and four separate things depend on it
// being complete: remainingDiscountHeadroom (so a manual discount stacked on a
// promo could push the bill negative), the per-row delete in the discount UI (so
// a promo could not be waived for one bill), platform_accuracy_check's
// order_arithmetic invariant, and per-category reporting. Rows keep all four
// working with no changes to any of them — buildQuote in particular is untouched.
//
// This is the same call engage_redeem.go made for QR rewards.
// =========================================================================

// categoryPromoLine is one category's slice of an order's promotion.
type categoryPromoLine struct {
	CategoryID uuid.UUID
	PercentBP  int
	// BasisCents is this category's exact share of the order subtotal — see the
	// rounding note in computeCategoryPromotions.
	BasisCents  int64
	AmountCents int64
}

// pctOfBP computes round(amount * bp / 10000) with integer math, rounding half
// up. Mirrors pctOf (which takes a numeric(5,2) string) for basis points, so
// every discount percentage in the codebase rounds the same way.
func pctOfBP(amount int64, bp int) int64 {
	if amount <= 0 || bp <= 0 {
		return 0
	}
	return (amount*int64(bp) + 5000) / 10000
}

// computeCategoryPromotions works out what each promoted category takes off this
// order, clamped so the total can never exceed `headroom`.
//
// THE ROUNDING RULE, which is the whole reason this is not a one-line query.
//
// order_items.qty is numeric(6,2) (half portions, migration 0044), and buildQuote
// computes the subtotal as SUM(qty * unit_price_cents)::bigint — summed in
// numeric, rounded ONCE at the end. Per-category sums each cast to bigint do not
// add up to that number; money.go's header carries the counterexample
// ((0.5*33 + 0.5*33)::bigint = 33, but 33/2 rounded twice = 34). Summing them
// would let a 100% promotion exceed the subtotal by a paisa per category.
//
// So the per-category figures are used only as WEIGHTS, and the authoritative
// subtotal is split across them with allocateByShare — the same
// largest-remainder splitter the profitability report uses, documented for
// exactly this job. Σ basis == subtotal exactly, therefore Σ amount <= subtotal
// for any set of percentages within range.
func computeCategoryPromotions(ctx context.Context, tx pgx.Tx, orderID uuid.UUID, headroom int64) ([]categoryPromoLine, error) {

	// The authoritative subtotal: buildQuote's exact query and predicate, so the
	// basis can never disagree with the number on the bill.
	var subtotal int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(qty * unit_price_cents), 0)::bigint
		FROM order_items
		WHERE order_id = $1 AND voided_at IS NULL
	`, orderID).Scan(&subtotal); err != nil {
		return nil, err
	}
	if subtotal <= 0 || headroom <= 0 {
		return nil, nil
	}

	// Weights, in paisa. Per-group rounding here is harmless — these are only
	// proportions. Keep them in paisa: finer units push weight*total in
	// allocateByShare toward int64 overflow for no gain in exactness, because
	// the exactness comes from allocating the real subtotal, not from the
	// weights being fractional.
	//
	// No deleted_at filter on menu_categories: a line's category always exists,
	// and a soft-deleted category's items are already gone from the POS, so its
	// percentage is unreachable in practice.
	rows, err := tx.Query(ctx, `
		SELECT mi.category_id, mc.discount_percent_bp,
		       SUM(oi.qty * oi.unit_price_cents)::bigint AS weight_cents
		FROM order_items oi
		JOIN menu_items mi      ON mi.id = oi.menu_item_id
		JOIN menu_categories mc ON mc.id = mi.category_id
		WHERE oi.order_id = $1 AND oi.voided_at IS NULL
		GROUP BY mi.category_id, mc.discount_percent_bp
		ORDER BY mi.category_id
	`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var (
		ids     []uuid.UUID
		bps     []int
		weights []int64
	)
	for rows.Next() {
		var id uuid.UUID
		var bp int
		var w int64
		if err := rows.Scan(&id, &bp, &w); err != nil {
			return nil, err
		}
		ids = append(ids, id)
		bps = append(bps, bp)
		weights = append(weights, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Every category on the order takes part in the split, promoted or not —
	// otherwise the promoted ones would share the whole subtotal between them
	// and over-discount.
	bases := allocateByShare(subtotal, weights)

	out := make([]categoryPromoLine, 0, len(ids))
	var total int64
	for i := range ids {
		amt := pctOfBP(bases[i], bps[i])
		if amt <= 0 {
			continue
		}
		out = append(out, categoryPromoLine{
			CategoryID:  ids[i],
			PercentBP:   bps[i],
			BasisCents:  bases[i],
			AmountCents: amt,
		})
		total += amt
	}

	// Clamp to what the order can still absorb (a manual discount may already
	// have taken most of it). Spread the shortfall with allocateByShare so the
	// stored rows still sum to exactly what was deducted.
	if total > headroom {
		amounts := make([]int64, len(out))
		for i := range out {
			amounts[i] = out[i].AmountCents
		}
		clamped := allocateByShare(headroom, amounts)
		kept := out[:0]
		for i := range out {
			if clamped[i] <= 0 {
				continue
			}
			out[i].AmountCents = clamped[i]
			kept = append(kept, out[i])
		}
		out = kept
	}
	return out, nil
}

// syncCategoryPromotions brings an order's category-promotion rows in line with
// what it currently contains. Idempotent: it replaces its own rows rather than
// adding to them, so calling it twice is the same as calling it once.
//
// Call it inside the SAME transaction as anything that changes the order's
// lines, and again at close. It must be given a tx, not just a ctx, because the
// row lock below has to be held for the delete-and-reinsert.
func syncCategoryPromotions(ctx context.Context, tx pgx.Tx, orderID uuid.UUID, userID uuid.UUID) error {
	// FOR UPDATE serialises two cashiers touching one tab; without it a
	// concurrent pair of item-adds could each delete the other's rows and both
	// insert, doubling the promotion.
	var status string
	var staffID *uuid.UUID
	var waived bool
	if err := tx.QueryRow(ctx, `
		SELECT status::text, staff_id, promotions_waived
		FROM orders WHERE id = $1 FOR UPDATE
	`, orderID).Scan(&status, &staffID, &waived); err != nil {
		return err
	}
	// Only an open order earns a promotion. A closed one is frozen, and a staff
	// meal is free already — CloseOrder writes zeros for it, which would leave
	// these rows orphaned against a bill of nothing.
	if status != "open" || waived || staffID != nil {
		return nil
	}

	// Drop our own rows FIRST, then read the headroom — a promo row counts
	// against headroom, so measuring before the delete would make a re-sync of
	// an unchanged promotion clamp itself to zero.
	if _, err := tx.Exec(ctx, `
		DELETE FROM order_adjustments
		WHERE order_id = $1 AND menu_category_id IS NOT NULL
	`, orderID); err != nil {
		return err
	}

	headroom, err := remainingDiscountHeadroomTx(ctx, tx, orderID)
	if err != nil {
		return err
	}
	lines, err := computeCategoryPromotions(ctx, tx, orderID, headroom)
	if err != nil {
		return err
	}
	for _, l := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO order_adjustments
			  (tenant_id, order_id, type, amount_cents, reason,
			   applied_by_user_id, approved_by_user_id, menu_category_id, percent_bp)
			SELECT o.tenant_id, o.id, 'discount', $2, 'promotion', $3, $3, $4, $5
			FROM orders o WHERE o.id = $1
		`, orderID, l.AmountCents, nullUUID(userID), l.CategoryID, l.PercentBP); err != nil {
			return fmt.Errorf("insert category promotion: %w", err)
		}
	}
	return nil
}

// nullUUID turns the zero UUID into a NULL, so a promotion applied by a
// background path (no acting user) does not claim to have been applied by
// 00000000-0000-0000-0000-000000000000.
func nullUUID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}

// syncPromotionsForCategory re-syncs every OPEN order that contains a line from
// this category. Called when the percentage changes.
//
// Without it, an owner setting "Breakfast 10%" at 09:00 would not touch the tabs
// already running: they would keep the old figure on screen until something else
// edited them, then jump at close (CloseOrder re-syncs, and close is
// authoritative). The cashier would read one total and settle a different one —
// or, worse, type the total they can see and be told it is an overpayment.
//
// Doing it here instead makes the edit take effect where the owner can see it.
// The scan is bounded by open tabs, which is a couple of dozen at most for a
// café, and each order is skipped cheaply if nothing about it changed.
func syncPromotionsForCategory(ctx context.Context, tx pgx.Tx, categoryID uuid.UUID, userID uuid.UUID) error {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT o.id
		FROM orders o
		JOIN order_items oi ON oi.order_id = o.id AND oi.voided_at IS NULL
		JOIN menu_items mi  ON mi.id = oi.menu_item_id
		WHERE o.status = 'open' AND mi.category_id = $1
	`, categoryID)
	if err != nil {
		return err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	// Collected first: syncCategoryPromotions runs its own queries on the same
	// tx, and pgx allows only one active result set per connection.
	for _, id := range ids {
		if err := syncCategoryPromotions(ctx, tx, id, userID); err != nil {
			return err
		}
	}
	return nil
}
