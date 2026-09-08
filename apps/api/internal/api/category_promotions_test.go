package api

// Integration tests for category-wise discounts (migration 0078,
// category_promotions.go).
//
// The promotion is applied automatically but MATERIALISED as ordinary
// order_adjustments rows, so most of what needs proving is that those rows say
// exactly the right thing and that nothing downstream had to change to cope
// with them. Everything that writes goes through fx.appTx so the app role's
// grants and the RLS policies are exercised, not bypassed.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// appctxWithTx makes a context buildQuote and friends can read a tx out of,
// so a test can call them directly inside fx.appTx.
func appctxWithTx(tx pgx.Tx) context.Context {
	return appctx.WithTx(context.Background(), tx)
}

// =========================================================================
// helpers
// =========================================================================

func (fx *fixture) seedCategoryWithDiscount(name string, bp int) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO menu_categories (tenant_id, name, discount_percent_bp)
		 VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, name, bp)
	return id
}

// seedOrderItemQty is seedOrderItem for a fractional quantity — half portions
// are the case the rounding design has to survive.
func (fx *fixture) seedOrderItemQty(orderID, menuItemID uuid.UUID, qty float64, unitPriceCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO order_items (tenant_id, order_id, menu_item_id, qty, unit_price_cents)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		fx.Tenant, orderID, menuItemID, qty, unitPriceCents)
	return id
}

// promoRows reads back the materialised promotion for an order, newest schema
// fields included, ordered for stable comparison.
type promoRow struct {
	CategoryID  uuid.UUID
	PercentBP   int
	AmountCents int64
}

func readPromoRows(t *testing.T, tx pgx.Tx, orderID uuid.UUID) []promoRow {
	t.Helper()
	rows, err := tx.Query(context.Background(), `
		SELECT menu_category_id, percent_bp, amount_cents
		FROM order_adjustments
		WHERE order_id = $1 AND menu_category_id IS NOT NULL
		ORDER BY menu_category_id
	`, orderID)
	if err != nil {
		t.Fatalf("read promo rows: %v", err)
	}
	defer rows.Close()
	var out []promoRow
	for rows.Next() {
		var r promoRow
		if err := rows.Scan(&r.CategoryID, &r.PercentBP, &r.AmountCents); err != nil {
			t.Fatalf("scan promo row: %v", err)
		}
		out = append(out, r)
	}
	return out
}

func sumPromo(rows []promoRow) int64 {
	var n int64
	for _, r := range rows {
		n += r.AmountCents
	}
	return n
}

// =========================================================================
// pctOfBP — the shared rounding primitive
// =========================================================================

func TestPctOfBP(t *testing.T) {
	cases := []struct {
		amount int64
		bp     int
		want   int64
		why    string
	}{
		{10000, 1000, 1000, "10% of Rs 100"},
		{10000, 1500, 1500, "15%"},
		{10000, 0, 0, "no promotion"},
		{10000, 10000, 10000, "100% off is allowed"},
		{0, 1000, 0, "nothing to discount"},
		{-500, 1000, 0, "never invents a discount from a negative basis"},
		{5, 1000, 1, "half a paisa rounds up, like pctOf"},
		{4, 1000, 0, "below half rounds down"},
		{333, 3333, 111, "awkward thirds stay integral"},
	}
	for _, c := range cases {
		if got := pctOfBP(c.amount, c.bp); got != c.want {
			t.Errorf("pctOfBP(%d, %d) = %d, want %d (%s)", c.amount, c.bp, got, c.want, c.why)
		}
	}
}

// =========================================================================
// the arithmetic
// =========================================================================

func TestCategoryPromotions_PerCategoryAmounts(t *testing.T) {
	fx := newTenant(t)
	breakfast := fx.seedCategoryWithDiscount("Breakfast", 1000) // 10%
	desserts := fx.seedCategoryWithDiscount("Desserts", 1500)   // 15%
	coffee := fx.seedCategoryWithDiscount("Coffee", 0)          // no promotion

	toast := fx.seedMenuItem(breakfast, "Toast", 20000)
	cake := fx.seedMenuItem(desserts, "Cake", 30000)
	latte := fx.seedMenuItem(coffee, "Latte", 15000)

	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, toast, 2, 20000) // 40000
	fx.seedOrderItem(order, cake, 1, 30000)  // 30000
	fx.seedOrderItem(order, latte, 1, 15000) // 15000  → subtotal 85000

	if err := fx.appTx(func(tx pgx.Tx) error {
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		got := readPromoRows(t, tx, order)
		if len(got) != 2 {
			t.Fatalf("got %d promo rows, want 2 (the un-promoted category must not get one): %+v", len(got), got)
		}
		byCat := map[uuid.UUID]promoRow{}
		for _, r := range got {
			byCat[r.CategoryID] = r
		}
		// Hand-computed: 10% of 40000 and 15% of 30000.
		if r := byCat[breakfast]; r.AmountCents != 4000 || r.PercentBP != 1000 {
			t.Errorf("breakfast = %d @ %dbp, want 4000 @ 1000", r.AmountCents, r.PercentBP)
		}
		if r := byCat[desserts]; r.AmountCents != 4500 || r.PercentBP != 1500 {
			t.Errorf("desserts = %d @ %dbp, want 4500 @ 1500", r.AmountCents, r.PercentBP)
		}
		if _, ok := byCat[coffee]; ok {
			t.Error("coffee has no promotion but got a row")
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

// The test that protects the rounding design. order_items.qty is numeric(6,2)
// and buildQuote rounds the subtotal ONCE, so per-category sums cast to bigint
// individually do NOT add up to it (money.go's header carries the
// counterexample). allocateByShare is what keeps the two reconciled.
func TestCategoryPromotions_HalfPortionsSumExactly(t *testing.T) {
	fx := newTenant(t)
	// 100% on every category, so Σ amounts == Σ bases and any drift is visible
	// as a discount that exceeds the subtotal.
	a := fx.seedCategoryWithDiscount("A", 10000)
	b := fx.seedCategoryWithDiscount("B", 10000)
	// An odd unit price so halving lands on a half-paisa.
	itemA := fx.seedMenuItem(a, "A item", 33)
	itemB := fx.seedMenuItem(b, "B item", 33)

	order := fx.seedOpenOrder(nil)
	fx.seedOrderItemQty(order, itemA, 0.5, 33)
	fx.seedOrderItemQty(order, itemB, 0.5, 33)

	if err := fx.appTx(func(tx pgx.Tx) error {
		var subtotal int64
		if err := tx.QueryRow(context.Background(), `
			SELECT COALESCE(SUM(qty * unit_price_cents), 0)::bigint
			FROM order_items WHERE order_id = $1 AND voided_at IS NULL
		`, order).Scan(&subtotal); err != nil {
			return err
		}
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		got := sumPromo(readPromoRows(t, tx, order))
		if got != subtotal {
			t.Errorf("100%% promotion summed to %d but the subtotal is %d — "+
				"per-category rounding has drifted away from buildQuote", got, subtotal)
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

func TestCategoryPromotions_NeverExceedsSubtotalAcrossManyCategories(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	// Seven categories all at 100%, each with a half portion at an awkward
	// price: the worst case for largest-remainder drift.
	for i, price := range []int64{33, 67, 99, 101, 7, 1, 12345} {
		cat := fx.seedCategoryWithDiscount(string(rune('A'+i)), 10000)
		item := fx.seedMenuItem(cat, "item", price)
		fx.seedOrderItemQty(order, item, 0.5, price)
	}

	if err := fx.appTx(func(tx pgx.Tx) error {
		var subtotal int64
		if err := tx.QueryRow(context.Background(), `
			SELECT COALESCE(SUM(qty * unit_price_cents), 0)::bigint
			FROM order_items WHERE order_id = $1 AND voided_at IS NULL
		`, order).Scan(&subtotal); err != nil {
			return err
		}
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		if got := sumPromo(readPromoRows(t, tx, order)); got != subtotal {
			t.Errorf("Σ promotion = %d, subtotal = %d", got, subtotal)
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

func TestCategoryPromotions_ExcludesVoidedLines(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategoryWithDiscount("Breakfast", 1000)
	item := fx.seedMenuItem(cat, "Toast", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	voided := fx.seedOrderItem(order, item, 1, 10000)
	fx.adminExec(`UPDATE order_items SET voided_at = now() WHERE id = $1`, voided)

	if err := fx.appTx(func(tx pgx.Tx) error {
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		// 10% of the ONE live line, not of both.
		if got := sumPromo(readPromoRows(t, tx, order)); got != 1000 {
			t.Errorf("promotion = %d, want 1000 (the voided line must not be discounted)", got)
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

// =========================================================================
// idempotence and stacking
// =========================================================================

func TestCategoryPromotions_ResyncIsIdempotent(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategoryWithDiscount("Breakfast", 1000)
	item := fx.seedMenuItem(cat, "Toast", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)

	if err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		// Three syncs in a row must leave exactly one row, at the same amount.
		// This is also the delete-then-measure-headroom ordering guard: a promo
		// row counts against headroom, so measuring before the delete would
		// clamp the re-sync to nothing.
		for i := range 3 {
			if err := syncCategoryPromotions(ctx, tx, order, fx.User); err != nil {
				return err
			}
			got := readPromoRows(t, tx, order)
			if len(got) != 1 {
				t.Fatalf("sync #%d left %d rows, want 1", i+1, len(got))
			}
			if got[0].AmountCents != 1000 {
				t.Fatalf("sync #%d gave %d, want 1000 (headroom measured before the delete?)", i+1, got[0].AmountCents)
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

func TestCategoryPromotions_ClampedByAManualDiscount(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategoryWithDiscount("Breakfast", 10000) // 100% off
	item := fx.seedMenuItem(cat, "Toast", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	// A manual discount already took Rs 60 of the Rs 100 bill.
	adjSeedAdjustment(fx, order, "discount", 6000, "regular")

	if err := fx.appTx(func(tx pgx.Tx) error {
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		// Only Rs 40 of headroom is left, so the promotion takes 4000, not 10000.
		if got := sumPromo(readPromoRows(t, tx, order)); got != 4000 {
			t.Errorf("promotion = %d, want 4000 (clamped to the remaining headroom)", got)
		}
		// And the bill still reconciles: total may not go negative.
		q, err := buildQuote(appctxWithTx(tx), order)
		if err != nil {
			return err
		}
		if q.TotalCents < 0 {
			t.Errorf("total went negative: %+v", q)
		}
		if q.DiscountCents != 10000 {
			t.Errorf("discount = %d, want 10000 (6000 manual + 4000 promotion)", q.DiscountCents)
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

// =========================================================================
// the no-op cases
// =========================================================================

func TestCategoryPromotions_SkipsWaivedOrder(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategoryWithDiscount("Breakfast", 1000)
	item := fx.seedMenuItem(cat, "Toast", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	fx.adminExec(`UPDATE orders SET promotions_waived = true WHERE id = $1`, order)

	if err := fx.appTx(func(tx pgx.Tx) error {
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		if got := readPromoRows(t, tx, order); len(got) != 0 {
			t.Errorf("waived order got %d promo rows, want 0 — a cashier's waive must stick", len(got))
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

func TestCategoryPromotions_SkipsClosedOrder(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategoryWithDiscount("Breakfast", 1000)
	item := fx.seedMenuItem(cat, "Toast", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	fx.adminExec(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, order)

	if err := fx.appTx(func(tx pgx.Tx) error {
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		if got := readPromoRows(t, tx, order); len(got) != 0 {
			t.Errorf("non-open order got %d promo rows, want 0", len(got))
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

func TestCategoryPromotions_SkipsStaffMeal(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Cook")
	cat := fx.seedCategoryWithDiscount("Breakfast", 1000)
	item := fx.seedMenuItem(cat, "Toast", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	fx.adminExec(`UPDATE orders SET staff_id = $2 WHERE id = $1`, order, staff)

	if err := fx.appTx(func(tx pgx.Tx) error {
		if err := syncCategoryPromotions(context.Background(), tx, order, fx.User); err != nil {
			return err
		}
		// A staff meal is already free and CloseOrder writes zeros for it, so a
		// discount row here would be orphaned against a bill of nothing.
		if got := readPromoRows(t, tx, order); len(got) != 0 {
			t.Errorf("staff meal got %d promo rows, want 0", len(got))
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

// =========================================================================
// Reporting: the promotion has to land on the category that earned it
// =========================================================================

// promoProfitWorld closes one order spanning a promoted and an un-promoted
// category, and returns the day to query plus the two category ids.
type promoProfitWorld struct {
	fx       *fixture
	day      string
	promoted uuid.UUID
	plain    uuid.UUID
}

func seedPromoProfitWorld(t *testing.T, bp int, withServiceAndVat bool) *promoProfitWorld {
	t.Helper()
	fx := newTenant(t)
	fx.grantRole(fx.User, "owner")
	if withServiceAndVat {
		fx.setTenantRates("10.00", "13.00")
		fx.setTenantVat("exclusive", "13.00")
	}
	at := pastUTC(3)

	desserts := fx.seedCategoryWithDiscount("Desserts", bp)
	coffee := fx.seedCategoryWithDiscount("Coffee", 0)

	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, fx.seedMenuItem(desserts, "Cake", 30000), 1, 30000)
	fx.seedOrderItem(order, fx.seedMenuItem(coffee, "Latte", 15000), 1, 15000)

	// Materialise the promotion the way the live write paths do, then close with
	// the same arithmetic buildQuote/CloseOrder use.
	if err := fx.appTx(func(tx pgx.Tx) error {
		return syncCategoryPromotions(context.Background(), tx, order, fx.User)
	}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	// appTx rolls back, so re-run it committed via the admin pool.
	fx.adminExec(`
		INSERT INTO order_adjustments
		  (tenant_id, order_id, type, amount_cents, reason, applied_by_user_id, menu_category_id, percent_bp)
		SELECT $1, $2, 'discount',
		       round(SUM(oi.qty * oi.unit_price_cents) * $4 / 10000.0)::bigint,
		       'promotion', $3, $5, $4
		FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE oi.order_id = $2 AND oi.voided_at IS NULL AND mi.category_id = $5`,
		fx.Tenant, order, fx.User, bp, desserts)

	fx.closeOrderWithTotals(order)
	// Pay it in full, or platform_accuracy_check's payments_vs_total invariant
	// fires and the "everything is clean" assertion becomes about the seeding
	// rather than about promotions.
	shift := fx.seedOpenShift(500000)
	fx.seedPayment(order, "cash", orderTotal(t, fx, order), &shift)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, order, at)

	return &promoProfitWorld{fx: fx, day: localDay(t, at), promoted: desserts, plain: coffee}
}

func (w *promoProfitWorld) query() string {
	return "range=custom&from=" + w.day + "&to=" + w.day
}

func (w *promoProfitWorld) report(t *testing.T) ProfitReport {
	t.Helper()
	var prof ProfitReport
	callHandler(t, w.fx, GetProfitability, "GET", "/reports/profitability", nil,
		withQuery(w.query())).expectStatus(200).decode(&prof)
	return prof
}

func rowFor(prof ProfitReport, id uuid.UUID) (ProfitRow, bool) {
	for _, c := range prof.Categories {
		if c.MenuCategoryID != nil && *c.MenuCategoryID == id {
			return c, true
		}
	}
	return ProfitRow{}, false
}

// The defect this feature would otherwise have introduced: a proportional
// spread gave the un-promoted category the same haircut, so an owner reading
// the margin report would conclude the promotion cost nothing.
func TestProfitability_PromotionLandsOnItsOwnCategory(t *testing.T) {
	w := seedPromoProfitWorld(t, 1500, false) // 15% off desserts, no service/VAT
	prof := w.report(t)

	promoted, ok := rowFor(prof, w.promoted)
	if !ok {
		t.Fatalf("no row for the promoted category: %+v", prof.Categories)
	}
	plain, ok := rowFor(prof, w.plain)
	if !ok {
		t.Fatalf("no row for the un-promoted category")
	}

	// Cake 30000 at 15% = 4500 off → 25500. Latte untouched at 15000.
	if promoted.NetRevenueCents != 25500 {
		t.Errorf("promoted category net revenue = %d, want 25500 (30000 less its own 4500)",
			promoted.NetRevenueCents)
	}
	if plain.NetRevenueCents != 15000 {
		t.Errorf("un-promoted category net revenue = %d, want 15000 — it must NOT absorb "+
			"any of another category's promotion (this is the old proportional bug)",
			plain.NetRevenueCents)
	}
	// Menu item sales are a pre-discount figure and must not move.
	if promoted.ItemSalesCents != 30000 || plain.ItemSalesCents != 15000 {
		t.Errorf("item sales moved: promoted=%d plain=%d, want 30000/15000",
			promoted.ItemSalesCents, plain.ItemSalesCents)
	}
}

// I4 in miniature: the category rows must still sum to billed sales − VAT
// EXACTLY once an attributed discount is in play, with service charge and VAT on
// top to make the arithmetic awkward.
func TestProfitability_CategoryRowsStillSumExactlyWithAPromotion(t *testing.T) {
	w := seedPromoProfitWorld(t, 1500, true) // 10% service, 13% exclusive VAT
	prof := w.report(t)

	var summed int64
	for _, c := range prof.Categories {
		summed += c.NetRevenueCents
	}
	wantNet := prof.BilledSalesCents - prof.VatCents
	if summed != wantNet {
		t.Errorf("category net revenue summed to %d, want %d (billed sales %d − VAT %d) — "+
			"the allocation no longer reconciles",
			summed, wantNet, prof.BilledSalesCents, prof.VatCents)
	}
}

// A 100% promotion zeroes every weight; the service charge that survives a full
// discount still has to be attributed rather than silently dropped.
func TestProfitability_FullPromotionStillAttributesTheServiceCharge(t *testing.T) {
	w := seedPromoProfitWorld(t, 10000, true)
	prof := w.report(t)

	var summed int64
	for _, c := range prof.Categories {
		summed += c.NetRevenueCents
	}
	wantNet := prof.BilledSalesCents - prof.VatCents
	if summed != wantNet {
		t.Errorf("100%%-off order: summed %d, want %d", summed, wantNet)
	}
}

// The drill-down and the list row read the same allocation string now, so they
// cannot drift. Before the extraction they were two copies.
func TestProfitability_DrilldownAgreesWithTheListRow(t *testing.T) {
	w := seedPromoProfitWorld(t, 1500, true)
	prof := w.report(t)

	for _, want := range prof.Categories {
		if want.MenuCategoryID == nil {
			continue
		}
		var got ProfitDrilldown
		callHandler(t, w.fx, GetProfitabilityDrilldown, "GET", "/reports/profitability/drilldown", nil,
			withQuery(w.query()), withParam("categoryId", want.MenuCategoryID.String()),
		).expectStatus(200).decode(&got)

		if got.Category.NetRevenueCents != want.NetRevenueCents {
			t.Errorf("%s: drill-down net revenue %d != list row %d",
				want.Name, got.Category.NetRevenueCents, want.NetRevenueCents)
		}
		if got.Category.ItemSalesCents != want.ItemSalesCents {
			t.Errorf("%s: drill-down item sales %d != list row %d",
				want.Name, got.Category.ItemSalesCents, want.ItemSalesCents)
		}
	}
}

// A closed bill is frozen: changing the percentage afterwards must not rewrite
// what the café actually gave away.
func TestProfitability_ClosedOrderIsUnaffectedByALaterPercentageChange(t *testing.T) {
	w := seedPromoProfitWorld(t, 1500, true)
	before := w.report(t)

	w.fx.adminExec(`UPDATE menu_categories SET discount_percent_bp = 5000 WHERE id = $1`, w.promoted)

	after := w.report(t)
	if before.BilledSalesCents != after.BilledSalesCents {
		t.Errorf("billed sales moved after a percentage change: %d → %d",
			before.BilledSalesCents, after.BilledSalesCents)
	}
	for _, b := range before.Categories {
		if b.MenuCategoryID == nil {
			continue
		}
		a, ok := rowFor(after, *b.MenuCategoryID)
		if !ok {
			t.Errorf("%s vanished from the report", b.Name)
			continue
		}
		if a.NetRevenueCents != b.NetRevenueCents {
			t.Errorf("%s net revenue moved after a percentage change: %d → %d",
				b.Name, b.NetRevenueCents, a.NetRevenueCents)
		}
	}
}

// =========================================================================
// The accuracy check (migration 0079)
// =========================================================================

// accuracyRows runs an accuracy-check function the way it is actually reachable.
//
// These functions are all gated on is_platform_admin(current_user_id()), and
// current_user_id() reads the app.user_id GUC — which the fixtures' admin pool
// never sets. So calling one with plain adminScan ALWAYS returns an empty set,
// and a test asserting `count(*) = 0` against it passes without checking
// anything. (Two existing tests do exactly that: modifiers_test.go and
// engage_redeem_test.go.) Registering the fixture user as a platform admin and
// setting the GUC is what makes the assertion mean something.
func accuracyRows(t *testing.T, fx *fixture, fn string) []string {
	t.Helper()
	fx.adminExec(`INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, fx.User)
	t.Cleanup(func() {
		fx.adminExec(`DELETE FROM platform_admins WHERE user_id = $1`, fx.User)
	})

	var out []string
	if err := fx.appTx(func(tx pgx.Tx) error {
		ctx := context.Background()
		rows, err := tx.Query(ctx,
			`SELECT check_key || ': ' || detail FROM `+fn+`($1)`, fx.Tenant)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				return err
			}
			out = append(out, s)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("run %s: %v", fn, err)
	}
	return out
}

// The guard on the guard: prove the harness can SEE a violation before trusting
// it to report their absence.
func TestAccuracyCheck_DiscountRowsCatchesTampering(t *testing.T) {
	w := seedPromoProfitWorld(t, 1500, true)
	w.fx.adminExec(`
		DELETE FROM order_adjustments
		WHERE menu_category_id = $1
		  AND order_id IN (SELECT id FROM orders WHERE tenant_id = $2)`, w.promoted, w.fx.Tenant)

	got := accuracyRows(t, w.fx, "platform_accuracy_check_discounts")
	if len(got) == 0 {
		t.Error("a discount row was deleted after close and the check stayed silent")
	}
}

// A promoted order that closes normally must leave every invariant clean —
// discount_cents and the sum of its discount rows have to agree, because
// Profitability now reads the rows while History reads the column.
func TestAccuracyCheck_PromotedOrderIsClean(t *testing.T) {
	w := seedPromoProfitWorld(t, 1500, true)

	if got := accuracyRows(t, w.fx, "platform_accuracy_check_discounts"); len(got) != 0 {
		t.Errorf("order_discount_rows fired: %v", got)
	}
	// And the pre-existing money invariants are still clean with a promotion on
	// the bill — order_arithmetic in particular.
	if got := accuracyRows(t, w.fx, "platform_accuracy_check"); len(got) != 0 {
		t.Errorf("platform_accuracy_check fired: %v", got)
	}
	if got := accuracyRows(t, w.fx, "platform_accuracy_check_addons"); len(got) != 0 {
		t.Errorf("platform_accuracy_check_addons fired: %v", got)
	}
}
