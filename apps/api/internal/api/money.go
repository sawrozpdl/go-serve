package api

import (
	"context"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// THE MONEY VOCABULARY — one definition per figure, used everywhere.
//
// Before this file existed the same word meant different numbers on adjacent
// screens: "Sales" was SUM(orders.total_cents) on the Dashboard and
// SUM(qty * unit_price) on Profitability, and for a VAT-exclusive cafe with a
// service charge the two differed by ~14% with nothing on screen to explain it.
// Every money figure now derives from one of the definitions below, and every
// handler reads them through the helpers here rather than hand-rolling SQL.
//
// The order columns are the source of truth. buildQuote (payments.go) writes
// them once, at close, and nothing rewrites them afterwards:
//
//	subtotal_cents       Σ qty × unit_price over non-voided lines
//	discount_cents       Σ order_adjustments(type='discount')
//	service_charge_cents pct of subtotal
//	tax_cents            VAT: extracted from the base (inclusive mode) or added
//	                     on top (exclusive mode); 0 when vat_mode='none'
//	total_cents          base (+ tax when exclusive), where
//	                     base = subtotal − discount + service
//
// Note total_cents ALWAYS contains tax_cents, in every VAT mode.
//
// The figures:
//
//	BILLED SALES      Σ total_cents        What the guest was charged. Includes
//	                                       VAT and service charge, net of
//	                                       discounts. The receipt total.
//	VAT COLLECTED     Σ tax_cents          Owed to the government — a liability,
//	                                       never the cafe's income.
//	SERVICE CHARGE    Σ service_charge_cents  The cafe's income.
//	NET REVENUE       Σ (total − tax)      What the cafe actually earned: net of
//	                                       discounts, includes service charge,
//	                                       excludes VAT. THE basis for profit.
//	MENU ITEM SALES   Σ qty × unit_price    Menu price × quantity, before
//	                                       discounts and (in inclusive mode)
//	                                       with VAT still inside. Valid ONLY for
//	                                       ranking and mix — never for totals or
//	                                       profit. Must always be labelled as
//	                                       such in the UI.
//	COLLECTED         Σ payments(method ≠ house_tab)  Money actually taken.
//	ON CREDIT         Σ payments(house_tab)           Billed but not collected.
//	CREDIT COLLECTED  Σ house_tab_settlements(live)   Money in against EARLIER
//	                                       sales. Never sales again.
//
// Why net revenue and not menu item sales for profit: menu item sales ignores
// discounts entirely (a 10% discount does not reduce it), and for an
// inclusive-VAT tenant it contains VAT the cafe must hand over. Both inflate
// margin. Half portions make it worse — qty is numeric(6,2) since migration
// 0044, and (0.5*33 + 0.5*33)::bigint = 33 while (0.5*33)::bigint +
// (0.5*33)::bigint = 34, so per-group rounding of the item basis cannot even be
// reconciled with itself across groupings.
//
// ROUNDING RULE: round once, and force parts to sum. Figures come from the
// paisa-exact stored columns; any per-category or per-channel breakdown is
// allocated with largest-remainder (see allocateByShare) so the displayed parts
// always add up to the displayed total, exactly.
// =========================================================================

// closedOrdersInWindow is the standard sales population: orders closed inside a
// half-open [from, to) window. Every sales figure must use this predicate so
// that no two reports can disagree about which orders "count".
//
// Half-open is deliberate — an order closing exactly at a boundary instant
// belongs to exactly one window, so per-day figures sum to the range figure.
const closedOrdersInWindow = `o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2`

// netRevenueExpr is NET REVENUE for a set of order rows aliased `o`: billed
// sales minus the VAT liability. Discounts are already deducted inside
// total_cents and the service charge is already included.
const netRevenueExpr = `COALESCE(SUM(o.total_cents - o.tax_cents), 0)::bigint`

// =========================================================================
// THE ACCOUNT BUCKET IDENTITY — one implementation, three callers.
//
// A bucket (cash drawer / online pool / bank) holds:
//
//	+ payments(method ∈ bucket)              sales collected into it
//	+ house_tab_settlements(live, ∈ bucket)   credit collected into it
//	− expenses(payment_method ∈ bucket)       operating costs paid from it,
//	                                          excluding those an owner paid
//	                                          from their own pocket or from
//	                                          cash they are already holding
//	+ transfers(to_method ∈ bucket)           moved in
//	− transfers(from_method ∈ bucket) − fee   moved out (fee is charged here)
//
// Cash additionally moves through the drawer for reasons that are not sales or
// expenses (an owner taking cash, a recount correction), and the bank
// additionally moves with owner capital (investments, payouts, loan repayments)
// and with owner-held cash being deposited.
//
// This used to exist as five hand-written copies across accounts.go and
// finance.go, which had already drifted: the Accounts page's bank card omitted
// owner capital and owner-cash deposits, so it disagreed with the Balance page's
// bank tile by every such movement — two numbers for one bank account, on two
// screens. One function now answers for all of them.
// =========================================================================

// loadAccountBucket computes one bucket's balance and its itemisation.
func loadAccountBucket(ctx context.Context, b accountBucket) (AccountBalance, error) {
	out := AccountBalance{Method: b.Method, Label: b.Label}
	tx := appctx.Tx(ctx)

	if err := tx.QueryRow(ctx, `
		SELECT
		  -- Order payments only: this bucket's share of SALES.
		  COALESCE((SELECT SUM(amount_cents) FROM payments
		            WHERE method::text = ANY($1)), 0)::bigint,
		  -- Credit collected into this bucket. Real money in, but against an
		  -- EARLIER sale, so it is reported separately and never as sales.
		  -- Reversed collections count for nothing.
		  COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
		            WHERE payment_method::text = ANY($1) AND reversed_at IS NULL), 0)::bigint,
		  -- 'owner_cash' is absorbed by the owner-cash holding; 'owner' never
		  -- touched a cafe account at all (it books a loan instead). Counting
		  -- either here would debit an account that did not pay out.
		  COALESCE((SELECT SUM(amount_cents) FROM expenses
		            WHERE payment_method::text = ANY($1) AND deleted_at IS NULL
		              AND paid_from NOT IN ('owner_cash', 'owner')), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents) FROM account_transfers
		            WHERE to_method::text   = ANY($1)), 0)::bigint,
		  COALESCE((SELECT SUM(amount_cents + fee_cents) FROM account_transfers
		            WHERE from_method::text = ANY($1)), 0)::bigint
	`, b.Members).Scan(&out.PaymentsCents, &out.CreditCollectedCents, &out.ExpensesCents,
		&out.TransfersInCents, &out.TransfersOutCents); err != nil {
		return out, err
	}

	switch b.Method {
	case "cash":
		// Drawer movements that are not already represented by an expense or a
		// transfer row: an owner taking cash out, a recount correction, and the
		// legacy paid_in/paid_out/petty_change kinds. Excluding 'expense' and
		// 'transfer' is what keeps those two from being counted twice.
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents
			                         ELSE -amount_cents END), 0)::bigint
			FROM cash_drops
			WHERE kind::text NOT IN ('expense', 'transfer')
		`).Scan(&out.OtherMovementsCents); err != nil {
			return out, err
		}
	case "bank":
		// Owner capital in and out, plus owner-held cash banked. Corrected ledger
		// rows are excluded, as is the go-live opening investment (the opening bank
		// balance it funded is already recorded as a payment).
		if err := tx.QueryRow(ctx, `
			SELECT
			  COALESCE((SELECT SUM(amount_cents) FROM owner_ledger
			            WHERE kind = 'investment' AND is_correction = false AND is_opening = false
			              AND NOT EXISTS (SELECT 1 FROM owner_ledger c
			                              WHERE c.corrects_id = owner_ledger.id)), 0)::bigint
			  + COALESCE((SELECT SUM(amount_cents) FROM owner_cash_entries
			            WHERE kind = 'bank_deposit'), 0)::bigint
			  - COALESCE((SELECT SUM(amount_cents) FROM owner_ledger
			            WHERE kind IN ('payout','loan_repayment') AND is_correction = false
			              AND NOT EXISTS (SELECT 1 FROM owner_ledger c
			                              WHERE c.corrects_id = owner_ledger.id)), 0)::bigint
		`).Scan(&out.OtherMovementsCents); err != nil {
			return out, err
		}
	}

	out.BalanceCents = out.PaymentsCents + out.CreditCollectedCents - out.ExpensesCents +
		out.TransfersInCents - out.TransfersOutCents + out.OtherMovementsCents
	return out, nil
}

// allocateByShare splits `total` across `weights` proportionally, using the
// largest-remainder method so the returned parts sum to EXACTLY total — no
// paisa invented, none lost.
//
// This is what lets a per-category profit table add up: each order's discount,
// service charge and VAT have to be spread across the categories its lines
// belong to, and naive per-row rounding drifts (worst case half a paisa per
// order, systematically in one direction once thousands of orders accumulate).
//
// Weights may be any non-negative magnitudes (line revenue, in practice). A zero
// weight-sum returns all zeros: nothing to attribute.
func allocateByShare(total int64, weights []int64) []int64 {
	out := make([]int64, len(weights))
	if len(weights) == 0 {
		return out
	}
	var sum int64
	for _, w := range weights {
		if w > 0 {
			sum += w
		}
	}
	if sum == 0 {
		return out
	}

	// Floor each share, then hand the remaining paisa to the largest remainders.
	// Tracking remainders as (weight*total) mod sum keeps this exact in integers.
	type rem struct {
		idx int
		r   int64
	}
	rems := make([]rem, 0, len(weights))
	var assigned int64
	for i, w := range weights {
		if w <= 0 {
			continue
		}
		num := w * total
		share := num / sum
		out[i] = share
		assigned += share
		rems = append(rems, rem{i, num % sum})
	}

	left := total - assigned
	// Largest remainder first; ties go to the earlier index so the result is
	// deterministic (tests and repeat requests must agree).
	for left > 0 && len(rems) > 0 {
		best := 0
		for j := 1; j < len(rems); j++ {
			if rems[j].r > rems[best].r {
				best = j
			}
		}
		out[rems[best].idx]++
		left--
		rems = append(rems[:best], rems[best+1:]...)
	}
	// A negative total (shouldn't happen for money, but don't corrupt if it does)
	// distributes the same way in reverse.
	for left < 0 && len(rems) > 0 {
		out[rems[0].idx]--
		left++
		rems = rems[1:]
	}
	return out
}

// divRound divides two int64s rounding half away from zero, so an average is
// never silently truncated. `avg × count` can still differ from the total (that
// is inherent to averaging), but the average itself is the nearest paisa.
func divRound(num, den int64) int64 {
	if den == 0 {
		return 0
	}
	if (num < 0) != (den < 0) {
		return -((-num + den/2) / den)
	}
	return (num + den/2) / den
}
