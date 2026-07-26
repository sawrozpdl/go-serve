package super

// The accuracy self-check is only worth having if it actually fires. Each test
// here plants exactly one broken row and asserts the check names it, then a
// healthy-tenant test asserts it stays quiet when nothing is wrong.

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// accSeedClosedOrder makes a consistent closed order paid in full in cash inside
// an open shift — a row that must NOT be flagged by anything.
func accSeedClosedOrder(sf *superFixture, tenantID uuid.UUID, cents int64) (order, shift uuid.UUID) {
	sf.t.Helper()
	var userID uuid.UUID
	sf.adminScan([]any{&userID}, `SELECT user_id FROM platform_admins LIMIT 1`)

	// One open shift per tenant is a DB constraint, so reuse it when a previous
	// call already opened one.
	sf.adminScan([]any{&shift}, `
		WITH existing AS (
		  SELECT id FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL LIMIT 1
		), created AS (
		  INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents)
		  SELECT $1, $2, 0 WHERE NOT EXISTS (SELECT 1 FROM existing)
		  RETURNING id
		)
		SELECT id FROM existing UNION ALL SELECT id FROM created`, tenantID, userID)

	suffix := uuid.NewString()[:6]
	var catID, itemID uuid.UUID
	sf.adminScan([]any{&catID}, `
		INSERT INTO menu_categories (tenant_id, name) VALUES ($1, 'AccCat-' || $2) RETURNING id`,
		tenantID, suffix)
	sf.adminScan([]any{&itemID}, `
		INSERT INTO menu_items (tenant_id, category_id, name, price_cents)
		VALUES ($1, $2, 'AccItem-' || $4, $3) RETURNING id`, tenantID, catID, cents, suffix)
	sf.adminScan([]any{&order}, `
		INSERT INTO orders (tenant_id, opened_by_user_id, status, closed_at,
		                    subtotal_cents, total_cents)
		VALUES ($1, $2, 'closed', now(), $3, $3) RETURNING id`, tenantID, userID, cents)
	sf.adminExec(`
		INSERT INTO order_items (tenant_id, order_id, menu_item_id, qty, unit_price_cents)
		VALUES ($1, $2, $3, 1, $4)`, tenantID, order, itemID, cents)
	sf.adminExec(`
		INSERT INTO payments (tenant_id, order_id, shift_id, method, amount_cents, recorded_by_user_id)
		VALUES ($1, $2, $3, 'cash', $4, $5)`, tenantID, order, shift, cents, userID)
	return order, shift
}

func accRun(t *testing.T, sf *superFixture, tenantID uuid.UUID) AccuracyCheckResp {
	t.Helper()
	var out AccuracyCheckResp
	callSuper(t, sf, AccuracyCheck, http.MethodGet, "/super/accuracy-check", nil,
		superQuery("tenant_id="+tenantID.String())).
		expectStatus(http.StatusOK).decode(&out)
	return out
}

func accHas(resp AccuracyCheckResp, key string) *AccuracyViolation {
	for i := range resp.Violations {
		if resp.Violations[i].CheckKey == key {
			return &resp.Violations[i]
		}
	}
	return nil
}

// A tenant whose books are consistent must report clean. If this ever fails,
// every other test here is meaningless.
func TestAccuracyCheck_HealthyTenantReportsClean(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Healthy Cafe")
	accSeedClosedOrder(sf, tenantID, 5000)

	resp := accRun(t, sf, tenantID)
	if !resp.Healthy {
		t.Fatalf("healthy tenant reported %d violations: %+v", len(resp.Violations), resp.Violations)
	}
	if len(resp.Summary) != 0 {
		t.Fatalf("summary should be empty, got %+v", resp.Summary)
	}
}

// The identity that makes a receipt add up.
func TestAccuracyCheck_CatchesBrokenOrderArithmetic(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad Arithmetic")
	order, _ := accSeedClosedOrder(sf, tenantID, 5000)

	// Knock the total out of line with its components, as an oversized discount
	// used to be able to (buildQuote clamped the base at zero).
	sf.adminExec(`UPDATE orders SET discount_cents = 9000 WHERE id = $1`, order)

	resp := accRun(t, sf, tenantID)
	v := accHas(resp, "order_arithmetic")
	if v == nil {
		t.Fatalf("order_arithmetic not flagged; got %+v", resp.Violations)
	}
	if v.EntityID != order {
		t.Fatalf("flagged %s, want the broken order %s", v.EntityID, order)
	}
	// subtotal 5000 − discount 9000 + service 0 = −4000; stored total is 5000.
	if v.DeltaCent != 9000 {
		t.Fatalf("delta = %d, want 9000 (the size of the discrepancy)", v.DeltaCent)
	}
	if resp.Healthy {
		t.Fatal("healthy must be false when a violation exists")
	}
}

// The close guard proved payments == total at close time, so a mismatch means
// something changed afterwards.
func TestAccuracyCheck_CatchesPaymentsNotMatchingTotal(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad Payments")
	order, _ := accSeedClosedOrder(sf, tenantID, 5000)
	sf.adminExec(`UPDATE payments SET amount_cents = 4000 WHERE order_id = $1`, order)

	v := accHas(accRun(t, sf, tenantID), "payments_vs_total")
	if v == nil {
		t.Fatal("payments_vs_total not flagged")
	}
	if v.DeltaCent != -1000 {
		t.Fatalf("delta = %d, want -1000 (underpaid by Rs 10)", v.DeltaCent)
	}
}

// The P0 fix blocks this at the handler; the check catches any row that predates
// the fix or arrives another way.
func TestAccuracyCheck_CatchesPostCloseVoid(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Post Close Void")
	order, _ := accSeedClosedOrder(sf, tenantID, 5000)

	var userID uuid.UUID
	sf.adminScan([]any{&userID}, `SELECT user_id FROM platform_admins LIMIT 1`)
	sf.adminExec(`
		UPDATE order_items SET voided_at = now() + interval '1 minute',
		                       voided_by_user_id = $2
		WHERE order_id = $1`, order, userID)

	if v := accHas(accRun(t, sf, tenantID), "post_close_void"); v == nil {
		t.Fatal("post_close_void not flagged")
	}
}

// A receivable that belongs to nobody: invisible on the Credit page while the
// order reads as settled.
func TestAccuracyCheck_CatchesCreditChargeWithoutTab(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Orphan Credit")
	order, _ := accSeedClosedOrder(sf, tenantID, 5000)
	sf.adminExec(`UPDATE payments SET method = 'house_tab', house_tab_id = NULL
	              WHERE order_id = $1`, order)

	if v := accHas(accRun(t, sf, tenantID), "credit_without_tab"); v == nil {
		t.Fatal("credit_without_tab not flagged")
	}
}

// Cash that no drawer count can ever include.
func TestAccuracyCheck_CatchesCashWithoutShift(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Shiftless Cash")
	order, _ := accSeedClosedOrder(sf, tenantID, 5000)
	sf.adminExec(`UPDATE payments SET shift_id = NULL WHERE order_id = $1`, order)

	v := accHas(accRun(t, sf, tenantID), "cash_without_shift")
	if v == nil {
		t.Fatal("cash_without_shift not flagged")
	}
	if v.DeltaCent != 5000 {
		t.Fatalf("delta = %d, want 5000", v.DeltaCent)
	}
}

// A signed-off reconciliation must keep reconciling.
func TestAccuracyCheck_CatchesDriftedShiftExpectedCash(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Drifted Shift")
	_, shift := accSeedClosedOrder(sf, tenantID, 5000)

	var userID uuid.UUID
	sf.adminScan([]any{&userID}, `SELECT user_id FROM platform_admins LIMIT 1`)
	// Close the shift with the correct expected cash…
	sf.adminExec(`
		UPDATE shifts SET closed_at = now(), closed_by_user_id = $2,
		                  closing_count_cents = 5000, expected_cash_cents = 5000,
		                  variance_cents = 0
		WHERE id = $1`, shift, userID)
	// …then change the underlying rows, as deleting a payment out of a closed
	// shift used to be able to.
	sf.adminExec(`DELETE FROM payments WHERE shift_id = $1`, shift)

	v := accHas(accRun(t, sf, tenantID), "shift_expected_cash")
	if v == nil {
		t.Fatal("shift_expected_cash not flagged")
	}
	if v.DeltaCent != 5000 {
		t.Fatalf("delta = %d, want 5000 (stamped 5000, now recomputes to 0)", v.DeltaCent)
	}
}

// The summary is what an operator reads first, so it must count and explain.
func TestAccuracyCheck_SummarisesAndExplains(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Two Problems")
	orderA, _ := accSeedClosedOrder(sf, tenantID, 5000)
	orderB, _ := accSeedClosedOrder(sf, tenantID, 3000)
	sf.adminExec(`UPDATE payments SET shift_id = NULL WHERE order_id IN ($1, $2)`, orderA, orderB)

	resp := accRun(t, sf, tenantID)
	var found *AccuracyCheckSummary
	for i := range resp.Summary {
		if resp.Summary[i].CheckKey == "cash_without_shift" {
			found = &resp.Summary[i]
		}
	}
	if found == nil {
		t.Fatalf("no summary row for cash_without_shift: %+v", resp.Summary)
	}
	if found.Count != 2 {
		t.Fatalf("count = %d, want 2", found.Count)
	}
	if found.TotalDelta != 8000 {
		t.Fatalf("total delta = %d, want 8000", found.TotalDelta)
	}
	if found.Means == "" {
		t.Fatal("every check must explain itself in words — an operator reads this, not the SQL")
	}
}

// Scoping to one tenant must not report another tenant's rows.
func TestAccuracyCheck_ScopesToTheRequestedTenant(t *testing.T) {
	sf := newSuperFixture(t)
	broken, _ := sf.seedTenant("Broken Cafe")
	clean, _ := sf.seedTenant("Clean Cafe")
	order, _ := accSeedClosedOrder(sf, broken, 5000)
	sf.adminExec(`UPDATE payments SET shift_id = NULL WHERE order_id = $1`, order)
	accSeedClosedOrder(sf, clean, 2000)

	if resp := accRun(t, sf, clean); !resp.Healthy {
		t.Fatalf("the clean tenant reported violations: %+v", resp.Violations)
	}
	if resp := accRun(t, sf, broken); resp.Healthy {
		t.Fatal("the broken tenant reported clean")
	}
}

// A bad tenant_id is a client error, not a 500.
func TestAccuracyCheck_RejectsBadTenantID(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, AccuracyCheck, http.MethodGet, "/super/accuracy-check", nil,
		superQuery("tenant_id=not-a-uuid")).
		expectStatus(http.StatusBadRequest)
}
