package main

// A trading day, written the way the app writes one: open a shift, serve tables
// through the day, take money in a realistic mix, record what the cafe spent,
// then count the till and close.
//
// The shape matters as much as the volume. Weekends are busier than Mondays;
// most serves are cash, some online, a few go on credit; discounts are
// occasional, not on every bill; a line gets voided now and then BEFORE the bill
// is settled; half plates appear on the items that allow them. That mix is what
// makes the reports look like a real cafe's and what makes an edge case (a
// discount that spans two categories, a half portion in a VAT-inclusive tenant)
// actually get exercised.

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (w *world) trade(ctx context.Context, tx pgx.Tx, rng *rand.Rand) error {
	if w.bp.Days == 0 {
		return nil
	}
	// Owner capital goes in first, dated before trading starts.
	if len(w.owners) > 0 {
		at, err := w.localMidnight(w.bp.Days + 1)
		if err != nil {
			return err
		}
		if err := w.capital(ctx, tx, at); err != nil {
			return err
		}
	}

	// Oldest day first so "opening balance" style history reads forward.
	for d := w.bp.Days; d >= 1; d-- {
		if err := w.tradingDay(ctx, tx, rng, d); err != nil {
			return fmt.Errorf("day -%d: %w", d, err)
		}
		// Retire a table a third of the way in, so orders exist both before and
		// after its retirement.
		if w.retired != uuid.Nil && d == w.bp.Days*2/3 {
			at, err := w.localMidnight(d)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`UPDATE service_tables SET deleted_at = $2 WHERE id = $1`, w.retired, at); err != nil {
				return fmt.Errorf("retire table: %w", err)
			}
		}
	}
	if w.bp.LeaveShiftOpen {
		return w.openTodayShift(ctx, tx, rng)
	}
	return nil
}

// busyness scales a day by weekday: Fri/Sat busy, Mon quiet.
func busyness(t time.Time) float64 {
	switch t.Weekday() {
	case time.Friday:
		return 1.35
	case time.Saturday:
		return 1.5
	case time.Sunday:
		return 1.1
	case time.Monday:
		return 0.7
	default:
		return 1.0
	}
}

func (w *world) tradingDay(ctx context.Context, tx pgx.Tx, rng *rand.Rand, daysAgo int) error {
	midnight, err := w.localMidnight(daysAgo)
	if err != nil {
		return err
	}
	// A cafe day: open ~07:30 local, close ~21:00 local.
	openAt := midnight.Add(7*time.Hour + 30*time.Minute)
	closeAt := midnight.Add(21 * time.Hour)

	float := int64(300000 + rng.Intn(6)*50000) // Rs 3000–5500 in the till
	shiftID, err := w.openShift(ctx, tx, openAt, float)
	if err != nil {
		return err
	}
	w.stats.shifts++

	n := int(float64(w.bp.OrdersPerDay) * busyness(midnight.In(time.UTC)))
	n += rng.Intn(5) - 2
	if n < 1 {
		n = 1
	}

	for i := 0; i < n; i++ {
		// Serves spread across the day, weighted toward lunch and dinner.
		closed := openAt.Add(time.Duration(w.serviceMinutes(rng)) * time.Minute)
		if closed.After(closeAt) {
			closed = closeAt.Add(-time.Duration(rng.Intn(30)) * time.Minute)
		}
		if _, err := w.serve(ctx, tx, rng, shiftID, closed); err != nil {
			return err
		}
	}

	// What the cafe spent today, and the odd bit of housekeeping.
	if err := w.daySpending(ctx, tx, rng, shiftID, midnight, daysAgo); err != nil {
		return err
	}

	// A regular settles part of their tab, in cash, a couple of times a week.
	if len(w.tabs) > 0 && rng.Intn(3) == 0 {
		if _, err := w.collectCredit(ctx, tx, rng, shiftID, midnight.Add(19*time.Hour)); err != nil {
			return err
		}
	}

	// Close the till. Expected cash is recomputed from the shift's own rows —
	// never accumulated in Go — so the stamped figure can't drift from them. The
	// counted figure is usually exact, sometimes a few rupees out, as real counts are.
	return w.closeShift(ctx, tx, rng, shiftID, closeAt)
}

// serviceMinutes picks minutes-after-open with lunch and dinner humps.
func (w *world) serviceMinutes(rng *rand.Rand) int {
	switch r := rng.Intn(100); {
	case r < 20: // morning tea
		return rng.Intn(150)
	case r < 55: // lunch
		return 240 + rng.Intn(150)
	case r < 75: // afternoon lull
		return 400 + rng.Intn(120)
	default: // dinner
		return 600 + rng.Intn(180)
	}
}

// pickItem chooses a menu item by weight, so bestsellers actually sell best.
func (w *world) pickItem(rng *rand.Rand) seededItem {
	total := 0
	for _, it := range w.items {
		total += it.Weight
	}
	r := rng.Intn(total)
	for _, it := range w.items {
		if r < it.Weight {
			return it
		}
		r -= it.Weight
	}
	return w.items[0]
}

// serve writes one complete closed order and returns the cash it brought in.
func (w *world) serve(ctx context.Context, tx pgx.Tx, rng *rand.Rand,
	shiftID uuid.UUID, closedAt time.Time,
) (int64, error) {
	// Take-away roughly 1 serve in 5 — service_table_id NULL, which the
	// table-mix report has to account for rather than drop.
	var tableID *uuid.UUID
	if len(w.tables) > 0 && rng.Intn(5) > 0 {
		t := w.tables[rng.Intn(len(w.tables))]
		// Don't seat a serve on the retired table after it was retired.
		if t != w.retired || closedAt.Before(time.Now().Add(-24*time.Hour)) {
			tableID = &t
		}
	}
	openedAt := closedAt.Add(-time.Duration(10+rng.Intn(50)) * time.Minute)
	// Kitchen and void timestamps scale with how long the table actually sat, so
	// they always land strictly inside [openedAt, closedAt). Fixed offsets don't:
	// a 10-minute serve with a void stamped at +15 minutes is a POST-CLOSE void,
	// which is a defect — and the seed self-check rightly rejected it.
	dwell := closedAt.Sub(openedAt)
	sentAt := openedAt.Add(dwell / 5)
	servedAt := openedAt.Add(dwell / 2)
	voidAt := openedAt.Add(dwell * 3 / 4)

	var orderID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO orders (tenant_id, service_table_id, opened_by_user_id, status, opened_at)
		VALUES ($1, $2, $3, 'open', $4)
		RETURNING id
	`, w.tenantID, tableID, w.waiterOrOwner(), openedAt).Scan(&orderID); err != nil {
		return 0, fmt.Errorf("open order: %w", err)
	}

	lineCount := 1 + rng.Intn(4)
	var lineTotals []int64
	for i := 0; i < lineCount; i++ {
		it := w.pickItem(rng)
		qty := "1"
		mult := int64(1)
		switch {
		case it.AllowHalf && rng.Intn(8) == 0:
			qty = "0.5" // half plate: fractional qty, the rounding edge case
			mult = 0
		case rng.Intn(6) == 0:
			qty = "2"
			mult = 2
		case rng.Intn(20) == 0:
			qty = "3"
			mult = 3
		}
		var lineID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO order_items
			  (tenant_id, order_id, menu_item_id, qty, unit_price_cents, unit_cost_cents,
			   kitchen_status, sent_to_kitchen_at, served_at)
			VALUES ($1, $2, $3, $4::numeric, $5, $6, 'served', $7, $8)
			RETURNING id
		`, w.tenantID, orderID, it.ID, qty, it.Price, it.Cost,
			sentAt, servedAt).Scan(&lineID); err != nil {
			return 0, fmt.Errorf("add line: %w", err)
		}

		// A line gets voided before settling about 1 serve in 25 (wrong order,
		// customer changed their mind). Voided BEFORE close, so the stored totals
		// legitimately exclude it — a post-close void is a defect, not demo data.
		if rng.Intn(25) == 0 {
			if _, err := tx.Exec(ctx, `
				UPDATE order_items
				SET voided_at = $2, voided_by_user_id = $3, void_reason = 'customer changed their mind',
				    void_approved_by_user_id = $3
				WHERE id = $1
			`, lineID, voidAt, w.owner); err != nil {
				return 0, fmt.Errorf("void line: %w", err)
			}
			continue // excluded from the bill
		}

		switch mult {
		case 0: // half portion
			lineTotals = append(lineTotals, it.Price/2)
		default:
			lineTotals = append(lineTotals, it.Price*mult)
		}
	}
	if len(lineTotals) == 0 {
		// Every line got voided: cancel the serve rather than close an empty one
		// (CloseOrder refuses an empty order, so demo data must not contain one).
		if _, err := tx.Exec(ctx,
			`UPDATE orders SET status = 'cancelled', cancelled_at = $2 WHERE id = $1`,
			orderID, closedAt); err != nil {
			return 0, err
		}
		return 0, nil
	}

	// A discount on roughly 1 serve in 12 — regulars, staff meals, an apology.
	var discount int64
	if rng.Intn(12) == 0 {
		var subtotal int64
		for _, l := range lineTotals {
			subtotal += l
		}
		// 5–15% of the bill, and never more than it (the handler enforces that).
		pct := int64(5 + rng.Intn(11))
		discount = subtotal * pct / 100
		if _, err := tx.Exec(ctx, `
			INSERT INTO order_adjustments
			  (tenant_id, order_id, type, amount_cents, reason, applied_by_user_id, approved_by_user_id, created_at)
			VALUES ($1, $2, 'discount', $3, 'regular customer', $4, $4, $5)
		`, w.tenantID, orderID, discount, w.owner, closedAt); err != nil {
			return 0, fmt.Errorf("discount: %w", err)
		}
	}

	q := computeQuote(lineTotals, discount, w.bp.ServicePct, w.bp.VatPct, w.bp.VatMode)

	// How it was paid. Cash dominates in a Nepali cafe; online is growing; credit
	// is for regulars only.
	var cash int64
	method := "cash"
	var tabID *uuid.UUID
	switch r := rng.Intn(100); {
	case r < 62:
		method = "cash"
		cash = q.Total
	case r < 90:
		method = "other" // 'online' normalises to 'other' on write
	case len(w.tabs) > 0:
		method = "house_tab"
		t := w.tabs[rng.Intn(len(w.tabs))]
		tabID = &t
		w.stats.creditCharges++
	default:
		method = "cash"
		cash = q.Total
	}

	var payShift *uuid.UUID
	if method != "house_tab" {
		payShift = &shiftID // cash/online require an open shift, as the API does
	} else if rng.Intn(2) == 0 {
		payShift = &shiftID // tab charges carry the shift when one is open
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO payments
		  (tenant_id, order_id, shift_id, method, amount_cents, recorded_by_user_id, recorded_at, house_tab_id)
		VALUES ($1, $2, $3, $4::payment_method, $5, $6, $7, $8)
	`, w.tenantID, orderID, payShift, method, q.Total, w.waiterOrOwner(), closedAt, tabID); err != nil {
		return 0, fmt.Errorf("payment: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE orders SET
		  status = 'closed', closed_at = $2,
		  subtotal_cents = $3, discount_cents = $4, service_charge_cents = $5,
		  tax_cents = $6, total_cents = $7
		WHERE id = $1
	`, orderID, closedAt, q.Subtotal, q.Discount, q.Service, q.Tax, q.Total); err != nil {
		return 0, fmt.Errorf("close order: %w", err)
	}
	w.stats.orders++
	return cash, nil
}

func (w *world) waiterOrOwner() uuid.UUID {
	if id, ok := w.users["waiter"]; ok {
		return id
	}
	return w.owner
}
