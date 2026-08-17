package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
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
		fx.Tenant, campaign, sessionID, code, code, kind, amountCents, ttl, grace).Scan(&id); err != nil {
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
