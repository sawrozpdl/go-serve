package api

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// =========================================================================
// Local seeders for the redemption path. These insert through the ADMIN pool
// (bypassing RLS) so a test can arrive at "a guest has already won a code"
// without going through the whole public play flow.
// =========================================================================

// engageSeedCampaign creates an active campaign and returns its id.
func engageSeedCampaign(t *testing.T, fx *fixture) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := adminPool.QueryRow(context.Background(), `
		INSERT INTO engage_campaigns (tenant_id, name, game, status)
		VALUES ($1, 'Test campaign', 'stack', 'active') RETURNING id`,
		fx.Tenant).Scan(&id); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	return id
}

// engageSeedCode mints a live reward code, as the public play flow would.
// ttl/grace are relative to now so a test can make a code fresh, expired but
// inside grace, or dead.
func engageSeedCode(t *testing.T, fx *fixture, campaign uuid.UUID, code string,
	kind string, amountCents *int64, ttl, grace string) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var sessionID uuid.UUID
	if err := adminPool.QueryRow(ctx, `
		INSERT INTO engage_sessions
		  (tenant_id, campaign_id, session_token_hash, device_hash, play_day, game, seed,
		   status, outcome, is_winnable, score)
		VALUES ($1, $2, $3, $4, current_date, 'stack', 42, 'completed', 'win', true, 99)
		RETURNING id`,
		fx.Tenant, campaign, "hash-"+code, "device-"+code).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	var id uuid.UUID
	if err := adminPool.QueryRow(ctx, `
		INSERT INTO engage_codes
		  (tenant_id, campaign_id, session_id, code, code_norm, reward_kind, label,
		   amount_cents, estimated_value_cents, issued_on, expires_at, grace_until)
		VALUES ($1, $2, $3, $4, $5, $6, 'Test reward', $7::bigint, COALESCE($7::bigint, 0), current_date,
		        now() + $8::interval, now() + $9::interval)
		RETURNING id`,
		// code_norm goes through the SAME normaliser the handler uses to look the
		// code up. Storing the display form here would make every lookup miss.
		fx.Tenant, campaign, sessionID, code, normalizeRewardCode(code), kind, amountCents, ttl, grace).Scan(&id); err != nil {
		t.Fatalf("seed code: %v", err)
	}
	return id
}

// engageSeedRedemption marks a code as spent against an order + adjustment,
// exactly as the redeem handler will.
func engageSeedRedemption(t *testing.T, fx *fixture, codeID, orderID, adjID uuid.UUID, amount int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := adminPool.Exec(ctx, `
		INSERT INTO engage_redemptions
		  (tenant_id, code_id, order_id, order_adjustment_id, amount_cents,
		   intended_amount_cents, redeemed_on)
		VALUES ($1, $2, $3, $4, $5, $5, current_date)`,
		fx.Tenant, codeID, orderID, adjID, amount); err != nil {
		t.Fatalf("seed redemption: %v", err)
	}
	if _, err := adminPool.Exec(ctx,
		`UPDATE engage_codes SET status = 'redeemed' WHERE id = $1`, codeID); err != nil {
		t.Fatalf("mark code redeemed: %v", err)
	}
}

// engageCodeStatus reads a code's status through the admin pool.
func engageCodeStatus(t *testing.T, codeID uuid.UUID) string {
	t.Helper()
	var s string
	if err := adminPool.QueryRow(context.Background(),
		`SELECT status FROM engage_codes WHERE id = $1`, codeID).Scan(&s); err != nil {
		t.Fatalf("read code status: %v", err)
	}
	return s
}

// =========================================================================
// Un-redeem: removing the discount must hand the code back
// =========================================================================

// TestRemoveAdjustment_ReturnsRewardCode is the regression for the double harm a
// cashier would otherwise do by correcting a bill: the discount comes off AND
// the guest's code stays spent.
func TestRemoveAdjustment_ReturnsRewardCode(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	ctx := context.Background()

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Tea", 20000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 20000)

	campaign := engageSeedCampaign(t, fx)
	amount := int64(5000)
	codeID := engageSeedCode(t, fx, campaign, "TEA-AAAA", "flat", &amount, "5 minutes", "15 minutes")

	// The adjustment the redemption created.
	var adjID uuid.UUID
	if err := adminPool.QueryRow(ctx, `
		INSERT INTO order_adjustments (tenant_id, order_id, type, amount_cents, reason)
		VALUES ($1, $2, 'discount', $3, 'promotion') RETURNING id`,
		fx.Tenant, order, amount).Scan(&adjID); err != nil {
		t.Fatalf("seed adjustment: %v", err)
	}
	engageSeedRedemption(t, fx, codeID, order, adjID, amount)

	if got := engageCodeStatus(t, codeID); got != "redeemed" {
		t.Fatalf("precondition: code status = %q, want redeemed", got)
	}

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adjID.String()})).
		expectStatus(204)

	if got := engageCodeStatus(t, codeID); got != "issued" {
		t.Fatalf("code status = %q after the discount was removed, want issued — "+
			"the guest earned it and must be able to use it again", got)
	}

	// The redemption row is kept and stamped, not deleted: a café working out
	// where its reward budget went needs to see that this code was applied and
	// then taken off.
	var reverted *string
	if err := adminPool.QueryRow(ctx,
		`SELECT reverted_at::text FROM engage_redemptions WHERE code_id = $1`, codeID).Scan(&reverted); err != nil {
		t.Fatalf("read redemption: %v", err)
	}
	if reverted == nil {
		t.Fatal("redemption row was not stamped reverted_at")
	}
}

// TestRemoveAdjustment_PlainDiscountUnaffected guards the common path: the vast
// majority of adjustments have nothing to do with rewards, and the new lookup
// must be a no-op for them.
func TestRemoveAdjustment_PlainDiscountUnaffected(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Tea", 20000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 20000)

	res := callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/", map[string]any{
		"type": "discount", "amount_cents": 3000, "reason": "regular",
	}, withParam("id", order.String())).expectStatus(201)
	var adj OrderAdjustment
	res.decode(&adj)

	callHandler(t, fx, RemoveOrderAdjustment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "adjId": adj.ID.String()})).
		expectStatus(204)

	if got := fx.countRows("order_adjustments"); got != 0 {
		t.Fatalf("order_adjustments has %d rows, want 0", got)
	}
}

// =========================================================================
// Redemption at the till
// =========================================================================

// accuracyViolations runs the money invariants over this tenant. Every test that
// redeems a reward and closes the tab must end with this at zero — a redemption
// that broke `subtotal − discount + service (+ tax) = total` would make the
// café's own receipts stop adding up.
func accuracyViolations(fx *fixture) int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n}, `SELECT count(*)::int FROM platform_accuracy_check($1)`, fx.Tenant)
	return n
}

// redeemFixture is the common setup: an open tab with one item, and a live code.
type redeemFixture struct {
	fx     *fixture
	order  uuid.UUID
	item   uuid.UUID
	code   uuid.UUID
	campID uuid.UUID
}

func newRedeemFixture(t *testing.T, itemPrice int64, kind string, amount *int64) *redeemFixture {
	t.Helper()
	fx := newTenant(t)
	requireDB(t)
	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Tea", itemPrice)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, itemPrice)
	camp := engageSeedCampaign(t, fx)
	code := engageSeedCode(t, fx, camp, "TEA-"+uuid.NewString()[:4], kind, amount, "5 minutes", "15 minutes")
	return &redeemFixture{fx: fx, order: order, item: item, code: code, campID: camp}
}

// codeText reads the display form so tests can type it the way a cashier would.
func codeText(t *testing.T, id uuid.UUID) string {
	t.Helper()
	var s string
	if err := adminPool.QueryRow(context.Background(),
		`SELECT code FROM engage_codes WHERE id = $1`, id).Scan(&s); err != nil {
		t.Fatalf("read code: %v", err)
	}
	return s
}

func redeem(t *testing.T, rf *redeemFixture, code string) *apiResp {
	t.Helper()
	return callHandler(t, rf.fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": rf.order}, withParam("code", code))
}

func TestRedeem_FlatRewardBecomesAnOrdinaryDiscount(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)

	res := redeem(t, rf, codeText(t, rf.code)).expectStatus(201)
	var out struct {
		AmountCents int64 `json:"amount_cents"`
	}
	res.decode(&out)
	if out.AmountCents != 5000 {
		t.Fatalf("applied %d, want 5000", out.AmountCents)
	}

	// The whole design rests on this being an ordinary discount row.
	if got := rf.fx.countRows("order_adjustments"); got != 1 {
		t.Fatalf("order_adjustments has %d rows, want 1", got)
	}
	if got := engageCodeStatus(t, rf.code); got != "redeemed" {
		t.Fatalf("code status = %q, want redeemed", got)
	}

	rf.fx.closeOrderWithTotals(rf.order)
	if n := accuracyViolations(rf.fx); n != 0 {
		t.Fatalf("%d money invariant violations after redeeming and closing", n)
	}
}

// TestRedeem_PercentAppliesToSubtotalNotService pins what "10% off" means. The
// service charge is the café's, not the guest's discount base.
func TestRedeem_PercentAppliesToSubtotalNotService(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	fx.setTenantRates("10", "13") // 10% service charge

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Tea", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 10000) // subtotal 20000, service 2000

	camp := engageSeedCampaign(t, fx)
	var codeID uuid.UUID
	if err := adminPool.QueryRow(context.Background(), `
		INSERT INTO engage_codes
		  (tenant_id, campaign_id, session_id, code, code_norm, reward_kind, label,
		   percent_bp, max_discount_cents, estimated_value_cents, issued_on, expires_at, grace_until)
		SELECT $1, $2, s.id, 'PCT-0001', 'PCT0001', 'percent', '10% off', 1000, 999999, 999999,
		       current_date, now() + interval '5 min', now() + interval '15 min'
		FROM engage_sessions s WHERE s.tenant_id = $1 LIMIT 1
		RETURNING id`, fx.Tenant, camp).Scan(&codeID); err == pgx.ErrNoRows {
		// No session seeded yet — mint one through the helper instead.
		codeID = engageSeedCode(t, fx, camp, "PCT-0001", "flat", nil, "5 minutes", "15 minutes")
		fx.adminExec(`UPDATE engage_codes SET reward_kind='percent', percent_bp=1000,
		              max_discount_cents=999999, amount_cents=NULL WHERE id=$1`, codeID)
	} else if err != nil {
		t.Fatalf("seed percent code: %v", err)
	}

	res := callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": order}, withParam("code", "PCT-0001")).expectStatus(201)
	var out struct {
		AmountCents int64 `json:"amount_cents"`
	}
	res.decode(&out)
	// 10% of the 20000 subtotal. If service were included it would be 2200.
	if out.AmountCents != 2000 {
		t.Fatalf("applied %d, want 2000 (10%% of subtotal, not of subtotal+service)", out.AmountCents)
	}
}

func TestRedeem_PercentRespectsItsCeiling(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Feast", 100000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 100000)

	camp := engageSeedCampaign(t, fx)
	codeID := engageSeedCode(t, fx, camp, "CAP-0001", "flat", nil, "5 minutes", "15 minutes")
	// 50% of a Rs 1000 bill would be Rs 500; the tier's ceiling is Rs 100.
	fx.adminExec(`UPDATE engage_codes SET reward_kind='percent', percent_bp=5000,
	              max_discount_cents=10000, amount_cents=NULL WHERE id=$1`, codeID)

	res := callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": order}, withParam("code", "CAP-0001")).expectStatus(201)
	var out struct {
		AmountCents int64 `json:"amount_cents"`
	}
	res.decode(&out)
	if out.AmountCents != 10000 {
		t.Fatalf("applied %d, want 10000 — the ceiling is what makes a percent reward's cost knowable", out.AmountCents)
	}
}

// TestRedeem_ClampsToTheBill: a reward worth more than the tab takes the tab to
// zero rather than erroring at the counter with a guest watching.
func TestRedeem_ClampsToTheBill(t *testing.T) {
	amount := int64(50000)
	rf := newRedeemFixture(t, 12000, "flat", &amount) // reward 500, bill 120

	res := redeem(t, rf, codeText(t, rf.code)).expectStatus(201)
	var out struct {
		AmountCents  int64 `json:"amount_cents"`
		IntendedCent int64 `json:"intended_amount_cents"`
		WasClamped   bool  `json:"was_clamped"`
	}
	res.decode(&out)
	if out.AmountCents != 12000 || !out.WasClamped {
		t.Fatalf("applied %d clamped=%v, want 12000 clamped=true", out.AmountCents, out.WasClamped)
	}
	// Both figures are kept so reward-cost reporting cannot overstate itself.
	if out.IntendedCent != 50000 {
		t.Fatalf("intended = %d, want the full 50000 recorded", out.IntendedCent)
	}

	rf.fx.closeOrderWithTotals(rf.order)
	if n := accuracyViolations(rf.fx); n != 0 {
		t.Fatalf("%d money invariant violations after a clamped redemption", n)
	}
}

func TestRedeem_FullyDiscountedTabRefusesWithoutSpendingTheCode(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)

	// Eat the whole bill with a manual discount first.
	callHandler(t, rf.fx, ApplyOrderAdjustment(testHub()), "POST", "/", map[string]any{
		"type": "discount", "amount_cents": 20000, "reason": "regular",
	}, withParam("id", rf.order.String())).expectStatus(201)

	redeem(t, rf, codeText(t, rf.code)).expectErr(409, "discount_exceeds_bill")

	// Crucially the guest keeps their code for another tab.
	if got := engageCodeStatus(t, rf.code); got != "issued" {
		t.Fatalf("code status = %q, want issued — a refused redemption must not spend it", got)
	}
}

func TestRedeem_FreeItemMustBeOnTheBill(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	cat := fx.seedCategory("Drinks")
	tea := fx.seedMenuItem(cat, "Masala Tea", 8000)
	cake := fx.seedMenuItem(cat, "Cake", 15000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, cake, 1, 15000) // the tab has cake, not tea

	camp := engageSeedCampaign(t, fx)
	codeID := engageSeedCode(t, fx, camp, "FRE-0001", "flat", nil, "5 minutes", "15 minutes")
	fx.adminExec(`UPDATE engage_codes SET reward_kind='free_item', menu_item_id=$2,
	              amount_cents=NULL WHERE id=$1`, codeID, tea)

	res := callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": order}, withParam("code", "FRE-0001")).
		expectErr(409, "reward_not_applicable")
	// The cashier gets a sentence naming the item, not an error kind.
	if msg := res.errMsg(); !strings.Contains(msg, "Masala Tea") {
		t.Fatalf("message %q should name the item the guest needs to order", msg)
	}
	if got := engageCodeStatus(t, codeID); got != "issued" {
		t.Fatalf("code status = %q — the guest can still add the item and use it", got)
	}

	// Add the tea and it works.
	fx.seedOrderItem(order, tea, 1, 8000)
	callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": order}, withParam("code", "FRE-0001")).expectStatus(201)
}

// TestRedeem_FreeItemPaysForOneUnit: "a free tea", not "free tea however many you
// ordered".
func TestRedeem_FreeItemPaysForOneUnit(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	cat := fx.seedCategory("Drinks")
	tea := fx.seedMenuItem(cat, "Tea", 8000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, tea, 3, 8000) // three teas on the tab

	camp := engageSeedCampaign(t, fx)
	codeID := engageSeedCode(t, fx, camp, "ONE-0001", "flat", nil, "5 minutes", "15 minutes")
	fx.adminExec(`UPDATE engage_codes SET reward_kind='free_item', menu_item_id=$2,
	              amount_cents=NULL WHERE id=$1`, codeID, tea)

	res := callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": order}, withParam("code", "ONE-0001")).expectStatus(201)
	var out struct {
		AmountCents int64 `json:"amount_cents"`
	}
	res.decode(&out)
	if out.AmountCents != 8000 {
		t.Fatalf("applied %d, want 8000 — one unit, not qty x price", out.AmountCents)
	}
}

// TestRedeem_FreeItemTakesTheCheapestLine keeps the café from being charged for
// the dearer of two lines of the same item.
func TestRedeem_FreeItemTakesTheCheapestLine(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	cat := fx.seedCategory("Drinks")
	tea := fx.seedMenuItem(cat, "Tea", 8000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, tea, 1, 12000) // same item, dearer line (add-ons folded in)
	fx.seedOrderItem(order, tea, 1, 8000)

	camp := engageSeedCampaign(t, fx)
	codeID := engageSeedCode(t, fx, camp, "CHP-0001", "flat", nil, "5 minutes", "15 minutes")
	fx.adminExec(`UPDATE engage_codes SET reward_kind='free_item', menu_item_id=$2,
	              amount_cents=NULL WHERE id=$1`, codeID, tea)

	res := callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": order}, withParam("code", "CHP-0001")).expectStatus(201)
	var out struct {
		AmountCents int64 `json:"amount_cents"`
	}
	res.decode(&out)
	if out.AmountCents != 8000 {
		t.Fatalf("applied %d, want 8000 (the cheapest matching line)", out.AmountCents)
	}
}

// TestRedeem_IsIdempotent — a POS retrying over flaky wifi must not error at a
// cashier for a code it just applied, and must not discount twice.
func TestRedeem_IsIdempotent(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	code := codeText(t, rf.code)

	redeem(t, rf, code).expectStatus(201)
	res := redeem(t, rf, code).expectStatus(200)
	if body := res.json(); body["already_applied"] != true {
		t.Fatalf("second redeem should report already_applied, got %v", body)
	}
	if got := rf.fx.countRows("order_adjustments"); got != 1 {
		t.Fatalf("order_adjustments has %d rows after a retry, want 1", got)
	}
	if got := rf.fx.countRows("engage_redemptions"); got != 1 {
		t.Fatalf("engage_redemptions has %d rows after a retry, want 1", got)
	}
}

func TestRedeem_SameCodeOnAnotherTabRefused(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	code := codeText(t, rf.code)
	redeem(t, rf, code).expectStatus(201)

	other := rf.fx.seedOpenOrder(nil)
	rf.fx.seedOrderItem(other, rf.item, 1, 20000)
	callHandler(t, rf.fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": other}, withParam("code", code)).
		expectErr(409, "code_already_redeemed")
}

func TestRedeem_OneRewardPerBill(t *testing.T) {
	amount := int64(2000)
	rf := newRedeemFixture(t, 50000, "flat", &amount)
	redeem(t, rf, codeText(t, rf.code)).expectStatus(201)

	second := engageSeedCode(t, rf.fx, rf.campID, "SEC-0001", "flat", &amount, "5 minutes", "15 minutes")
	_ = second
	callHandler(t, rf.fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": rf.order}, withParam("code", "SEC-0001")).
		expectErr(409, "order_already_has_reward")
}

func TestRedeem_ClosedTabRefused(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	rf.fx.closeOrderWithTotals(rf.order)
	redeem(t, rf, codeText(t, rf.code)).expectErr(409, "order_not_open")
}

// TestRedeem_ExpiryAndGrace is the five-minute rule and the cashier's escape
// hatch from it.
func TestRedeem_ExpiryAndGrace(t *testing.T) {
	t.Run("inside the grace window is honoured and flagged", func(t *testing.T) {
		amount := int64(5000)
		rf := newRedeemFixture(t, 20000, "flat", &amount)
		// Expired two minutes ago, grace runs for another eight.
		rf.fx.adminExec(`UPDATE engage_codes SET expires_at = now() - interval '2 min',
		                 grace_until = now() + interval '8 min' WHERE id = $1`, rf.code)

		res := redeem(t, rf, codeText(t, rf.code)).expectStatus(201)
		if body := res.json(); body["was_grace_override"] != true {
			t.Fatalf("a post-expiry redemption must be recorded as an override, got %v", body)
		}
	})

	t.Run("past the grace window is refused", func(t *testing.T) {
		amount := int64(5000)
		rf := newRedeemFixture(t, 20000, "flat", &amount)
		rf.fx.adminExec(`UPDATE engage_codes SET expires_at = now() - interval '30 min',
		                 grace_until = now() - interval '20 min' WHERE id = $1`, rf.code)
		redeem(t, rf, codeText(t, rf.code)).expectErr(409, "code_expired")
	})
}

func TestRedeem_VoidCodeRefused(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	rf.fx.adminExec(`UPDATE engage_codes SET status = 'void' WHERE id = $1`, rf.code)
	redeem(t, rf, codeText(t, rf.code)).expectErr(409, "code_void")
}

func TestRedeem_UnknownCode(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	redeem(t, rf, "ZZZ-9999").expectErr(404, "code_not_found")
}

// TestRedeem_CrossTenantCodeIsInvisible is an RLS proof: café B typing café A's
// code gets "no such code", because under RLS the row does not exist at all.
func TestRedeem_CrossTenantCodeIsInvisible(t *testing.T) {
	amount := int64(5000)
	theirs := newRedeemFixture(t, 20000, "flat", &amount)
	theirCode := codeText(t, theirs.code)

	mine := newRedeemFixture(t, 20000, "flat", &amount)
	callHandler(t, mine.fx, RedeemRewardCode(testHub()), "POST", "/",
		map[string]any{"order_id": mine.order}, withParam("code", theirCode)).
		expectErr(404, "code_not_found")

	if got := engageCodeStatus(t, theirs.code); got != "issued" {
		t.Fatalf("the other café's code was touched: status = %q", got)
	}
}

// TestRedeem_CodeIsTypedTheWayCashiersType checks normalisation. The code is read
// aloud off a phone screen mid-service.
func TestRedeem_CodeIsTypedTheWayCashiersType(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	code := codeText(t, rf.code)

	messy := " " + strings.ToLower(strings.ReplaceAll(code, "-", " ")) + " "
	redeem(t, rf, messy).expectStatus(201)
}

// TestRedeem_MoneyInvariantsHoldAcrossVatModes is the property test behind the
// clamp. orders carries CHECK (discount_cents >= 0) and CHECK (total_cents >= 0),
// and platform_accuracy_check() asserts
// `subtotal − discount + service (+ tax) = total` over live rows. A reward worth
// more than the bill, in any VAT mode, must land inside all of that.
func TestRedeem_MoneyInvariantsHoldAcrossVatModes(t *testing.T) {
	for _, vat := range []string{"none", "inclusive", "exclusive"} {
		for _, shape := range []struct {
			name        string
			itemPrice   int64
			rewardCent  int64
			preDiscount int64
		}{
			{"reward smaller than bill", 50000, 5000, 0},
			{"reward larger than bill", 5000, 50000, 0},
			{"reward exactly the bill", 20000, 20000, 0},
			{"bill already part-discounted", 20000, 15000, 12000},
		} {
			t.Run(vat+"/"+shape.name, func(t *testing.T) {
				fx := newTenant(t)
				requireDB(t)
				fx.setTenantVat(vat, "13")
				fx.setTenantRates("10", "13")

				cat := fx.seedCategory("Drinks")
				item := fx.seedMenuItem(cat, "Tea", shape.itemPrice)
				order := fx.seedOpenOrder(nil)
				fx.seedOrderItem(order, item, 1, shape.itemPrice)

				if shape.preDiscount > 0 {
					callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/", map[string]any{
						"type": "discount", "amount_cents": shape.preDiscount, "reason": "regular",
					}, withParam("id", order.String())).expectStatus(201)
				}

				camp := engageSeedCampaign(t, fx)
				code := engageSeedCode(t, fx, camp, "VAT-"+uuid.NewString()[:6], "flat",
					&shape.rewardCent, "5 minutes", "15 minutes")

				res := callHandler(t, fx, RedeemRewardCode(testHub()), "POST", "/",
					map[string]any{"order_id": order}, withParam("code", codeText(t, code)))
				// Either it applies, or the tab had no headroom left — both are
				// legitimate; what must never happen is a broken set of totals.
				if res.Code != 201 && res.Code != 409 {
					t.Fatalf("status %d, want 201 or 409; body: %s", res.Code, res.Body)
				}

				fx.closeOrderWithTotals(order)
				if n := accuracyViolations(fx); n != 0 {
					t.Fatalf("%d money invariant violations (vat=%s, %s)", n, vat, shape.name)
				}
			})
		}
	}
}

// =========================================================================
// The dry run
// =========================================================================

func TestLookupRewardCode_WritesNothing(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	code := codeText(t, rf.code)

	res := callHandler(t, rf.fx, LookupRewardCode, "GET", "/", nil,
		withParam("code", code), withQuery("order_id="+rf.order.String())).expectStatus(200)

	var out RewardLookup
	res.decode(&out)
	if !out.Redeemable || out.AppliesCents == nil || *out.AppliesCents != 5000 {
		t.Fatalf("lookup = %+v, want redeemable with applies_cents 5000", out)
	}
	// A preview that mutated anything would be a trap.
	if got := rf.fx.countRows("order_adjustments"); got != 0 {
		t.Fatalf("lookup created %d adjustments", got)
	}
	if got := engageCodeStatus(t, rf.code); got != "issued" {
		t.Fatalf("lookup changed the code status to %q", got)
	}
}

// TestLookupRewardCode_PredictsTheClamp: what the cashier is shown has to be what
// actually happens.
func TestLookupRewardCode_PredictsTheClamp(t *testing.T) {
	amount := int64(50000)
	rf := newRedeemFixture(t, 12000, "flat", &amount)
	code := codeText(t, rf.code)

	var preview RewardLookup
	callHandler(t, rf.fx, LookupRewardCode, "GET", "/", nil,
		withParam("code", code), withQuery("order_id="+rf.order.String())).
		expectStatus(200).decode(&preview)

	if preview.AppliesCents == nil || *preview.AppliesCents != 12000 || !preview.WouldClamp {
		t.Fatalf("preview = %+v, want applies 12000 with would_clamp", preview)
	}

	var applied struct {
		AmountCents int64 `json:"amount_cents"`
	}
	redeem(t, rf, code).expectStatus(201).decode(&applied)
	if applied.AmountCents != *preview.AppliesCents {
		t.Fatalf("preview said %d, redemption applied %d", *preview.AppliesCents, applied.AmountCents)
	}
}

func TestLookupRewardCode_ReportsGraceAndExpiry(t *testing.T) {
	amount := int64(5000)
	rf := newRedeemFixture(t, 20000, "flat", &amount)
	rf.fx.adminExec(`UPDATE engage_codes SET expires_at = now() - interval '1 min',
	                 grace_until = now() + interval '9 min' WHERE id = $1`, rf.code)

	var out RewardLookup
	callHandler(t, rf.fx, LookupRewardCode, "GET", "/", nil,
		withParam("code", codeText(t, rf.code))).expectStatus(200).decode(&out)

	if !out.NeedsGraceOverride || !out.Redeemable {
		t.Fatalf("lookup = %+v, want redeemable with needs_grace_override", out)
	}
	if out.SecondsLeft >= 0 {
		t.Fatalf("seconds_left = %d, want negative for an expired code", out.SecondsLeft)
	}
}

// =========================================================================
// The extracted headroom helper
// =========================================================================

// TestRemainingDiscountHeadroom_MatchesTheAppliedCap pins the behaviour that both
// the manual discount path and reward redemption depend on. Two copies of this
// arithmetic would drift, which is why it is one function.
func TestRemainingDiscountHeadroom_MatchesTheAppliedCap(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	fx.setTenantRates("10", "13") // 10% service charge

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Tea", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 10000) // subtotal 20000, service 2000

	// Headroom is subtotal + service, so a discount of exactly that must be
	// accepted and a single paisa more refused.
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/", map[string]any{
		"type": "discount", "amount_cents": 22001, "reason": "regular",
	}, withParam("id", order.String())).expectErr(409, "discount_too_large")

	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/", map[string]any{
		"type": "discount", "amount_cents": 22000, "reason": "regular",
	}, withParam("id", order.String())).expectStatus(201)

	// And once it is spent there is nothing left.
	callHandler(t, fx, ApplyOrderAdjustment(testHub()), "POST", "/", map[string]any{
		"type": "discount", "amount_cents": 1, "reason": "regular",
	}, withParam("id", order.String())).expectErr(409, "discount_too_large")
}
