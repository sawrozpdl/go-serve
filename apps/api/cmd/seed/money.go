package main

// Shifts, spending, credit collection, owner capital — the money-out and
// money-moved side of a day, written so every derived figure reconciles.

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (w *world) openShift(ctx context.Context, tx pgx.Tx, at time.Time, float int64) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents, opened_at)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, w.tenantID, w.owner, float, at).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("open shift: %w", err)
	}
	return id, nil
}

// closeShift stamps the reconciliation. expected_cash is RECOMPUTED from the
// shift's own rows rather than accumulated in Go — the same query the app uses —
// so the stored figure can never drift from the rows behind it. A counted figure
// that differs by a few rupees is realistic; the variance is stored either way,
// exactly as the handler does.
func (w *world) closeShift(ctx context.Context, tx pgx.Tx, rng *rand.Rand,
	shiftID uuid.UUID, at time.Time,
) error {
	var expected int64
	if err := tx.QueryRow(ctx, `
		SELECT (s.opening_float_cents
		  + COALESCE((SELECT SUM(amount_cents) FROM payments
		              WHERE shift_id = s.id AND method = 'cash'), 0)
		  + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
		              WHERE shift_id = s.id AND payment_method = 'cash'
		                AND reversed_at IS NULL), 0)
		  + COALESCE((SELECT SUM(amount_cents) FROM cash_drops
		              WHERE shift_id = s.id AND direction = 'in'), 0)
		  - COALESCE((SELECT SUM(amount_cents) FROM cash_drops
		              WHERE shift_id = s.id AND direction = 'out'), 0))::bigint
		FROM shifts s WHERE s.id = $1
	`, shiftID).Scan(&expected); err != nil {
		return fmt.Errorf("recompute expected cash: %w", err)
	}

	// Most closes are exact. One in four is out by a small amount — a coin
	// shortage, a mis-keyed tender — which is what makes the variance bands and
	// the variance-match suggestion worth having.
	counted := expected
	if rng.Intn(4) == 0 {
		off := int64((rng.Intn(9) + 1) * 500) // Rs 5–45
		if rng.Intn(2) == 0 {
			off = -off
		}
		counted += off
		if counted < 0 {
			counted = 0
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE shifts SET
		  closed_by_user_id = $2, closed_at = $3,
		  closing_count_cents = $4, expected_cash_cents = $5, variance_cents = $6
		WHERE id = $1
	`, shiftID, w.owner, at, counted, expected, counted-expected); err != nil {
		return fmt.Errorf("close shift: %w", err)
	}
	return nil
}

// openTodayShift leaves a shift open with a few serves already through it, so the
// live drawer, expected cash and the close panel have real numbers today.
func (w *world) openTodayShift(ctx context.Context, tx pgx.Tx, rng *rand.Rand) error {
	midnight, err := w.localMidnight(0)
	if err != nil {
		return err
	}
	openAt := midnight.Add(8 * time.Hour)
	if openAt.After(time.Now()) {
		// Seeded before 08:00 local: open the shift an hour ago instead.
		openAt = time.Now().Add(-time.Hour)
	}
	shiftID, err := w.openShift(ctx, tx, openAt, 400000)
	if err != nil {
		return err
	}
	w.stats.shifts++

	// A handful of serves, all in the past hour so they're inside the shift.
	for i := 0; i < 3+rng.Intn(4); i++ {
		at := openAt.Add(time.Duration(5+rng.Intn(40)) * time.Minute)
		if at.After(time.Now()) {
			at = time.Now().Add(-time.Duration(rng.Intn(20)) * time.Minute)
		}
		if _, err := w.serve(ctx, tx, rng, shiftID, at); err != nil {
			return err
		}
	}
	// An expense paid from the till, so the drawer shows an outflow too.
	if _, err := w.spend(ctx, tx, "Veg supplier", 45000, "drawer", "cash",
		&shiftID, openAt.Add(30*time.Minute)); err != nil {
		return err
	}
	return nil
}

// daySpending records what the cafe bought, from a realistic mix of sources.
// Returns the cash that left the till.
func (w *world) daySpending(ctx context.Context, tx pgx.Tx, rng *rand.Rand,
	shiftID uuid.UUID, midnight time.Time, daysAgo int,
) error {
	// Daily-ish: vegetables and milk from the drawer.
	if rng.Intn(3) > 0 {
		amt := int64(20000 + rng.Intn(40)*1000)
		if _, err := w.spend(ctx, tx, "Vegetable market", amt, "drawer", "cash",
			&shiftID, midnight.Add(8*time.Hour)); err != nil {
			return err
		}
		w.stats.expenses++
	}
	// Weekly: gas and a bulk supplier run, paid by bank.
	if daysAgo%7 == 0 {
		amt := int64(150000 + rng.Intn(20)*10000)
		if _, err := w.spend(ctx, tx, "Gas + bulk supplies", amt, "bank", "bank",
			nil, midnight.Add(11*time.Hour)); err != nil {
			return err
		}
		w.stats.expenses++
	}
	// Monthly: rent, and payroll for the staff.
	if daysAgo%30 == 1 {
		if _, err := w.spend(ctx, tx, "Rent", 2500000, "bank", "bank",
			nil, midnight.Add(10*time.Hour)); err != nil {
			return err
		}
		w.stats.expenses++
		if err := w.payroll(ctx, tx, midnight.Add(12*time.Hour)); err != nil {
			return err
		}
	}
	// Occasionally an owner buys something out of their own pocket: a real cafe
	// cost, but no cafe account moves — it books a loan the cafe owes them.
	if len(w.owners) > 0 && rng.Intn(20) == 0 {
		amt := int64(30000 + rng.Intn(50)*1000)
		if err := w.ownerPaidExpense(ctx, tx, w.owners[0], amt, midnight.Add(15*time.Hour)); err != nil {
			return err
		}
		w.stats.expenses++
	}
	// Now and then an owner takes cash from the till.
	if len(w.owners) > 0 && rng.Intn(10) == 0 {
		if _, err := w.ownerTakesCash(ctx, tx, shiftID, w.owners[0], rng,
			midnight.Add(20*time.Hour)); err != nil {
			return err
		}
	}
	// …or the day's takings go to the bank, sometimes with a fee.
	if rng.Intn(6) == 0 {
		amt := int64(200000 + rng.Intn(10)*50000)
		var fee int64
		if rng.Intn(3) == 0 {
			fee = int64(50 + rng.Intn(10)*25)
		}
		if err := w.transferCashToBank(ctx, tx, shiftID, amt, fee,
			midnight.Add(20*time.Hour+30*time.Minute)); err != nil {
			return err
		}
	}
	return nil
}

// spend writes an expense and, when it came from the till, the paired cash drop
// that makes the drawer agree with it.
func (w *world) spend(ctx context.Context, tx pgx.Tx, vendor string, amount int64,
	paidFrom, method string, shiftID *uuid.UUID, at time.Time,
) (uuid.UUID, error) {
	var catID *uuid.UUID
	var id uuid.UUID
	// Reuse a category if one exists (keeps the expense list realistic).
	_ = tx.QueryRow(ctx,
		`SELECT id FROM expense_categories WHERE tenant_id = $1 AND lower(name) = 'supplies' AND deleted_at IS NULL`,
		w.tenantID).Scan(&catID)
	if catID == nil {
		var newID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO expense_categories (tenant_id, name) VALUES ($1, 'Supplies')
			ON CONFLICT DO NOTHING RETURNING id`, w.tenantID).Scan(&newID); err == nil {
			catID = &newID
		}
	}

	if err := tx.QueryRow(ctx, `
		INSERT INTO expenses
		  (tenant_id, expense_category_id, vendor, amount_cents, paid_at, payment_method,
		   paid_from, shift_id, recorded_by_user_id)
		VALUES ($1, $2, $3, $4, $5, $6::payment_method, $7::expense_source, $8, $9)
		RETURNING id
	`, w.tenantID, catID, vendor, amount, at, method, paidFrom, shiftID, w.owner).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("expense %s: %w", vendor, err)
	}

	if paidFrom == "drawer" && shiftID != nil {
		if _, err := tx.Exec(ctx, `
			INSERT INTO cash_drops
			  (tenant_id, shift_id, direction, kind, amount_cents, reason, expense_id, recorded_by_user_id, recorded_at)
			VALUES ($1, $2, 'out', 'expense', $3, $4, $5, $6, $7)
		`, w.tenantID, *shiftID, amount, vendor, id, w.owner, at); err != nil {
			return uuid.Nil, fmt.Errorf("expense drop: %w", err)
		}
	}
	return id, nil
}

// ownerPaidExpense: the owner paid a vendor from their own pocket. A real cost,
// but no cafe account moved — it books a loan the cafe owes back.
func (w *world) ownerPaidExpense(ctx context.Context, tx pgx.Tx, ownerID uuid.UUID,
	amount int64, at time.Time,
) error {
	var expenseID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, paid_at, payment_method, paid_from, owner_id, recorded_by_user_id)
		VALUES ($1, 'Hardware shop', $2, $3, 'cash'::payment_method, 'owner'::expense_source, $4, $5)
		RETURNING id
	`, w.tenantID, amount, at, ownerID, w.owner).Scan(&expenseID); err != nil {
		return fmt.Errorf("owner-paid expense: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, notes, expense_id, occurred_at, created_by_user_id)
		VALUES ($1, $2, 'loan_advance', $3, 'paid a supplier from own pocket', $4, $5, $6)
	`, w.tenantID, ownerID, amount, expenseID, at, w.owner); err != nil {
		return fmt.Errorf("loan advance: %w", err)
	}
	return nil
}

// ownerTakesCash moves cash from the till into an owner's custody: the drawer
// drops, the holding rises, and the cafe total is unchanged.
func (w *world) ownerTakesCash(ctx context.Context, tx pgx.Tx, shiftID, ownerID uuid.UUID,
	rng *rand.Rand, at time.Time,
) (int64, error) {
	amount := int64(100000 + rng.Int63n(4)*50000)
	var dropID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, recorded_by_user_id, recorded_at)
		VALUES ($1, $2, 'out', 'owner_draw', $3, 'owner took cash', $4, $5)
		RETURNING id
	`, w.tenantID, shiftID, amount, w.owner, at).Scan(&dropID); err != nil {
		return 0, fmt.Errorf("owner draw drop: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO owner_cash_entries
		  (tenant_id, owner_id, kind, amount_cents, cash_drop_id, shift_id, occurred_at, recorded_by_user_id)
		VALUES ($1, $2, 'withdrawal', $3, $4, $5, $6, $7)
	`, w.tenantID, ownerID, amount, dropID, shiftID, at, w.owner); err != nil {
		return 0, fmt.Errorf("owner cash entry: %w", err)
	}
	return amount, nil
}

// transferCashToBank banks the day's takings. The paired drop carries amount+fee,
// because the fee is charged to the source — otherwise the drawer and the cash
// ledger disagree by the fee.
func (w *world) transferCashToBank(ctx context.Context, tx pgx.Tx, shiftID uuid.UUID,
	amount, fee int64, at time.Time,
) error {
	var dropID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, recorded_by_user_id, recorded_at)
		VALUES ($1, $2, 'out', 'transfer', $3, 'transfer → bank', $4, $5)
		RETURNING id
	`, w.tenantID, shiftID, amount+fee, w.owner, at).Scan(&dropID); err != nil {
		return fmt.Errorf("transfer drop: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_transfers
		  (tenant_id, from_method, to_method, amount_cents, fee_cents, notes,
		   transferred_at, shift_id, cash_drop_id, recorded_by_user_id)
		VALUES ($1, 'cash', 'bank', $2, $3, 'day takings', $4, $5, $6, $7)
	`, w.tenantID, amount, fee, at, shiftID, dropID, w.owner); err != nil {
		return fmt.Errorf("transfer: %w", err)
	}
	return nil
}

// collectCredit pays down part of a regular's tab, never more than is owed.
func (w *world) collectCredit(ctx context.Context, tx pgx.Tx, rng *rand.Rand,
	shiftID uuid.UUID, at time.Time,
) (int64, error) {
	tabID := w.tabs[rng.Intn(len(w.tabs))]
	var balance int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE((SELECT SUM(amount_cents) FROM payments
		                 WHERE house_tab_id = $1 AND method = 'house_tab'), 0)
		     - COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
		                 WHERE house_tab_id = $1 AND reversed_at IS NULL), 0)
	`, tabID).Scan(&balance); err != nil {
		return 0, fmt.Errorf("tab balance: %w", err)
	}
	if balance <= 0 {
		return 0, nil
	}
	// Usually the whole balance, sometimes a part payment.
	amount := balance
	if rng.Intn(3) == 0 && balance > 10000 {
		amount = balance / 2
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO house_tab_settlements
		  (tenant_id, house_tab_id, amount_cents, payment_method, notes, recorded_by_user_id, recorded_at, shift_id)
		VALUES ($1, $2, $3, 'cash'::payment_method, 'paid at the counter', $4, $5, $6)
	`, w.tenantID, tabID, amount, w.owner, at, shiftID); err != nil {
		return 0, fmt.Errorf("collect credit: %w", err)
	}
	w.stats.collections++
	return amount, nil
}

// payroll pays each staff member, which also books a salary expense.
func (w *world) payroll(ctx context.Context, tx pgx.Tx, at time.Time) error {
	for i, staffID := range w.staff {
		amount := int64(1500000 + int64(i)*100000) // Rs 15,000+, stable per person
		var catID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO expense_categories (tenant_id, name) VALUES ($1, 'Salaries')
			ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL DO UPDATE SET name = 'Salaries'
			RETURNING id
		`, w.tenantID).Scan(&catID); err != nil {
			return fmt.Errorf("salaries category: %w", err)
		}
		var expenseID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO expenses
			  (tenant_id, expense_category_id, vendor, amount_cents, paid_at, payment_method,
			   paid_from, recorded_by_user_id)
			VALUES ($1, $2, (SELECT full_name FROM staff WHERE id = $3), $4, $5,
			        'bank'::payment_method, 'bank'::expense_source, $6)
			RETURNING id
		`, w.tenantID, catID, staffID, amount, at, w.owner).Scan(&expenseID); err != nil {
			return fmt.Errorf("salary expense: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO staff_pay
			  (tenant_id, staff_id, paid_on, amount, period_label, expense_id, created_by_user_id)
			VALUES ($1, $2, $3::date, $4::numeric, $5, $6, $7)
		`, w.tenantID, staffID, at.Format("2006-01-02"), float64(amount)/100,
			at.Format("Jan 2006"), expenseID, w.owner); err != nil {
			return fmt.Errorf("staff pay: %w", err)
		}
	}
	return nil
}

// capital seeds owner investments and a payout, so the Owners page and the ROI
// card have history.
func (w *world) capital(ctx context.Context, tx pgx.Tx, at time.Time) error {
	for i, ownerID := range w.owners {
		amount := int64(5000000 * (int64(i) + 1)) // Rs 50k, 100k…
		if _, err := tx.Exec(ctx, `
			INSERT INTO owner_ledger
			  (tenant_id, owner_id, kind, amount_cents, notes, occurred_at, created_by_user_id)
			VALUES ($1, $2, 'investment', $3, 'startup capital', $4, $5)
		`, w.tenantID, ownerID, amount, at, w.owner); err != nil {
			return fmt.Errorf("investment: %w", err)
		}
	}
	if len(w.owners) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO owner_ledger
			  (tenant_id, owner_id, kind, amount_cents, notes, occurred_at, created_by_user_id)
			VALUES ($1, $2, 'payout', 1500000, 'quarterly draw', $3, $4)
		`, w.tenantID, w.owners[0], at.AddDate(0, 0, 20), w.owner); err != nil {
			return fmt.Errorf("payout: %w", err)
		}
	}
	return nil
}
