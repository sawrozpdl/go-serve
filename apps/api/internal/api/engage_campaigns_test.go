package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Engage campaign + reward tier configuration.
//
// These run on the APP pool via callHandler, so a missing GRANT or a broken RLS
// policy fails here rather than silently passing and then 500ing in the live API.
// =========================================================================

// engageBaseCampaign is a valid PUT body. Tests copy it and change one thing, so
// a failure points at the field under test rather than at setup drift.
func engageBaseCampaign() map[string]any {
	return map[string]any{
		"name":                     "Spin & Sip",
		"game":                     "tea_runner",
		"difficulty":               "normal",
		"reward_ttl_seconds":       300,
		"grace_seconds":            600,
		"allow_claim_without_play": false,
		"contact_capture_enabled":  true,
		"headline":                 "Play for a treat",
	}
}

// putCampaign saves the base campaign and returns its id.
func putCampaign(t *testing.T, fx *fixture, body map[string]any) uuid.UUID {
	t.Helper()
	res := callHandler(t, fx, PutEngageCampaign, "PUT", "/", body).expectStatus(200)
	var out struct {
		Campaign EngageCampaign `json:"campaign"`
	}
	res.decode(&out)
	return out.Campaign.ID
}

// =========================================================================
// GET / PUT
// =========================================================================

func TestGetEngageCampaign_NoneConfigured(t *testing.T) {
	fx := newTenant(t)
	// A café that has never set one up gets an empty editor, not a 404 — the
	// Engage page is reachable the moment the feature is switched on.
	res := callHandler(t, fx, GetEngageCampaign, "GET", "/", nil).expectStatus(200)
	body := res.json()
	if body["campaign"] != nil {
		t.Fatalf("campaign = %v, want nil", body["campaign"])
	}
	if tiers, ok := body["tiers"].([]any); !ok || len(tiers) != 0 {
		t.Fatalf("tiers = %v, want []", body["tiers"])
	}
}

func TestPutEngageCampaign_CreatesThenUpdates(t *testing.T) {
	fx := newTenant(t)
	id := putCampaign(t, fx, engageBaseCampaign())

	// A second PUT must EDIT the same row, not open a second campaign — the
	// café-wide QR has to resolve to one.
	body := engageBaseCampaign()
	body["name"] = "Renamed"
	body["game"] = "memory_match"
	id2 := putCampaign(t, fx, body)
	if id != id2 {
		t.Fatalf("second PUT created a new campaign (%s -> %s); it must update in place", id, id2)
	}

	var out struct {
		Campaign EngageCampaign `json:"campaign"`
	}
	callHandler(t, fx, GetEngageCampaign, "GET", "/", nil).expectStatus(200).decode(&out)
	if out.Campaign.Name != "Renamed" || out.Campaign.Game != "memory_match" {
		t.Fatalf("got %q/%q, want Renamed/memory_match", out.Campaign.Name, out.Campaign.Game)
	}
	if out.Campaign.Status != "draft" {
		t.Fatalf("status = %q, want draft — saving must never switch the QR on", out.Campaign.Status)
	}
}

func TestPutEngageCampaign_Validation(t *testing.T) {
	cases := []struct {
		name  string
		mutot func(map[string]any)
	}{
		{"blank name", func(b map[string]any) { b["name"] = "  " }},
		{"unknown game", func(b map[string]any) { b["game"] = "chess" }},
		{"unknown difficulty", func(b map[string]any) { b["difficulty"] = "brutal" }},
		{"ttl too short", func(b map[string]any) { b["reward_ttl_seconds"] = 30 }},
		{"ttl too long", func(b map[string]any) { b["reward_ttl_seconds"] = 99999 }},
		{"negative grace", func(b map[string]any) { b["grace_seconds"] = -1 }},
		{"bad weekday", func(b map[string]any) { b["active_days"] = []int{0, 9} }},
		{"negative budget", func(b map[string]any) { b["budget_total_cents"] = -100 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newTenant(t)
			body := engageBaseCampaign()
			tc.mutot(body)
			callHandler(t, fx, PutEngageCampaign, "PUT", "/", body).expectErr(400, "bad_request")
		})
	}
}

func TestPutEngageCampaign_EndBeforeStartRejected(t *testing.T) {
	fx := newTenant(t)
	body := engageBaseCampaign()
	body["starts_on"] = "2026-09-10"
	body["ends_on"] = "2026-09-01"
	// The DB CHECK is the backstop; the handler must turn it into a sentence the
	// owner can act on rather than leaking a constraint name.
	res := callHandler(t, fx, PutEngageCampaign, "PUT", "/", body).expectErr(400, "bad_request")
	if msg := res.errMsg(); msg == "" || msg == "engage_campaigns_dates_sane" {
		t.Fatalf("error message %q is not owner-readable", msg)
	}
}

// =========================================================================
// Status transitions
// =========================================================================

func TestSetEngageStatus_RefusesLiveWithNoWinningTier(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())

	// No tiers at all: every guest would lose. Refuse rather than let a café run
	// a campaign that can only disappoint.
	callHandler(t, fx, SetEngageCampaignStatus, "POST", "/", map[string]any{"status": "active"}).
		expectErr(409, "no_reward_tiers")

	// A consolation-only ladder is the same trap in disguise.
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 0, "label": "So close", "reward_kind": "none"},
	}}).expectStatus(200)
	callHandler(t, fx, SetEngageCampaignStatus, "POST", "/", map[string]any{"status": "active"}).
		expectErr(409, "no_reward_tiers")
}

func TestSetEngageStatus_GoesLiveWithAWinner(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 10, "label": "10% off", "reward_kind": "percent", "percent_bp": 1000, "max_discount_cents": 20000},
	}}).expectStatus(200)

	callHandler(t, fx, SetEngageCampaignStatus, "POST", "/", map[string]any{"status": "active"}).expectStatus(200)

	var out struct {
		Campaign EngageCampaign `json:"campaign"`
	}
	callHandler(t, fx, GetEngageCampaign, "GET", "/", nil).expectStatus(200).decode(&out)
	if out.Campaign.Status != "active" {
		t.Fatalf("status = %q, want active", out.Campaign.Status)
	}
}

func TestSetEngageStatus_BadStatus(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())
	callHandler(t, fx, SetEngageCampaignStatus, "POST", "/", map[string]any{"status": "live"}).
		expectErr(400, "bad_request")
}

func TestSetEngageStatus_NoCampaign(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, SetEngageCampaignStatus, "POST", "/", map[string]any{"status": "active"}).
		expectErr(404, "not_found")
}

// TestEngageCampaign_OnlyOneActivePerTenant proves the invariant at the DB level.
// The singleton API cannot produce a second active row, so this goes around it —
// the index is what protects the café-wide QR from an ambiguous campaign if a
// future handler ever inserts directly.
func TestEngageCampaign_OnlyOneActivePerTenant(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	ctx := context.Background()

	for _, name := range []string{"first", "second"} {
		_, err := adminPool.Exec(ctx, `
			INSERT INTO engage_campaigns (tenant_id, name, game, status)
			VALUES ($1, $2, 'stack', 'active')`, fx.Tenant, name)
		if name == "first" && err != nil {
			t.Fatalf("first active campaign should insert: %v", err)
		}
		if name == "second" && err == nil {
			t.Fatal("a second ACTIVE campaign was allowed — the café-wide QR would be ambiguous")
		}
	}
}

// =========================================================================
// Reward tiers
// =========================================================================

func TestPutEngageTiers_RequiresACampaign(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 10, "label": "x", "reward_kind": "flat", "amount_cents": 5000},
	}}).expectErr(404, "not_found")
}

func TestPutEngageTiers_SortsAscendingAndIsIdempotent(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())

	body := map[string]any{"tiers": []map[string]any{
		{"min_score": 50, "label": "Free pastry", "reward_kind": "flat", "amount_cents": 15000},
		{"min_score": 10, "label": "10% off", "reward_kind": "percent", "percent_bp": 1000, "max_discount_cents": 20000},
		{"min_score": 0, "label": "So close", "reward_kind": "none"},
	}}

	var out struct {
		Tiers []EngageTier `json:"tiers"`
	}
	callHandler(t, fx, PutEngageTiers, "PUT", "/", body).expectStatus(200).decode(&out)
	if len(out.Tiers) != 3 {
		t.Fatalf("got %d tiers, want 3", len(out.Tiers))
	}
	// Whatever order the editor sent, the ladder the guest climbs is ascending.
	for i := 1; i < len(out.Tiers); i++ {
		if out.Tiers[i].MinScore <= out.Tiers[i-1].MinScore {
			t.Fatalf("tiers not ascending: %v", out.Tiers)
		}
	}

	// The editor is one form with a Save button, so re-saving the same ladder
	// must converge rather than accumulate.
	var again struct {
		Tiers []EngageTier `json:"tiers"`
	}
	callHandler(t, fx, PutEngageTiers, "PUT", "/", body).expectStatus(200).decode(&again)
	if len(again.Tiers) != 3 {
		t.Fatalf("re-saving the same ladder produced %d tiers, want 3", len(again.Tiers))
	}
	if got := fx.countRows("engage_tiers"); got != 3 {
		t.Fatalf("engage_tiers holds %d rows after two identical saves, want 3", got)
	}
}

func TestPutEngageTiers_PercentNeedsACeiling(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())
	// Without max_discount_cents the cost of a percentage reward is unknown until
	// it lands on a bill, which makes the budget cap unenforceable.
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 10, "label": "50% off", "reward_kind": "percent", "percent_bp": 5000},
	}}).expectErr(400, "bad_request")
}

func TestPutEngageTiers_Validation(t *testing.T) {
	cases := []struct {
		name  string
		tiers []map[string]any
	}{
		{"duplicate threshold", []map[string]any{
			{"min_score": 10, "label": "a", "reward_kind": "flat", "amount_cents": 100},
			{"min_score": 10, "label": "b", "reward_kind": "flat", "amount_cents": 200},
		}},
		{"blank label", []map[string]any{
			{"min_score": 10, "label": "   ", "reward_kind": "flat", "amount_cents": 100},
		}},
		{"negative threshold", []map[string]any{
			{"min_score": -1, "label": "a", "reward_kind": "flat", "amount_cents": 100},
		}},
		{"flat with no amount", []map[string]any{
			{"min_score": 10, "label": "a", "reward_kind": "flat"},
		}},
		{"free item with no item", []map[string]any{
			{"min_score": 10, "label": "a", "reward_kind": "free_item"},
		}},
		{"unknown kind", []map[string]any{
			{"min_score": 10, "label": "a", "reward_kind": "cashback"},
		}},
		{"percent out of range", []map[string]any{
			{"min_score": 10, "label": "a", "reward_kind": "percent", "percent_bp": 0, "max_discount_cents": 100},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newTenant(t)
			putCampaign(t, fx, engageBaseCampaign())
			callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": tc.tiers}).
				expectErr(400, "bad_request")
		})
	}
}

// TestPutEngageTiers_FreeItemValuedFromMenu checks the figure the budget caps are
// enforced against. estimated_value_cents is computed server-side precisely so a
// client cannot understate what a campaign is costing the café.
func TestPutEngageTiers_FreeItemValuedFromMenu(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Masala Tea", 8000)
	putCampaign(t, fx, engageBaseCampaign())

	var out struct {
		Tiers []EngageTier `json:"tiers"`
	}
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 25, "label": "Free tea", "reward_kind": "free_item", "menu_item_id": item},
	}}).expectStatus(200).decode(&out)

	if len(out.Tiers) != 1 {
		t.Fatalf("got %d tiers, want 1", len(out.Tiers))
	}
	if out.Tiers[0].EstimatedValueCents != 8000 {
		t.Fatalf("estimated value = %d, want 8000 (the item's price)", out.Tiers[0].EstimatedValueCents)
	}
	if out.Tiers[0].MenuItemName != "Masala Tea" {
		t.Fatalf("menu item name = %q, want Masala Tea", out.Tiers[0].MenuItemName)
	}
}

func TestPutEngageTiers_PercentValuedAtItsCeiling(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())

	var out struct {
		Tiers []EngageTier `json:"tiers"`
	}
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 10, "label": "20% off", "reward_kind": "percent", "percent_bp": 2000, "max_discount_cents": 30000},
	}}).expectStatus(200).decode(&out)

	// The worst case is the only honest basis for a budget cap.
	if out.Tiers[0].EstimatedValueCents != 30000 {
		t.Fatalf("estimated value = %d, want 30000 (the ceiling)", out.Tiers[0].EstimatedValueCents)
	}
}

// TestPutEngageTiers_CrossTenantMenuItemRejected is an RLS proof, not a handler
// proof: the lookup finds no row because the item belongs to another café, so a
// tier can never be stored pointing across the tenant boundary.
func TestPutEngageTiers_CrossTenantMenuItemRejected(t *testing.T) {
	other := newTenant(t)
	otherItem := other.seedMenuItem(other.seedCategory("Theirs"), "Their Tea", 5000)

	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 10, "label": "Free tea", "reward_kind": "free_item", "menu_item_id": otherItem},
	}}).expectErr(400, "bad_request")

	if got := fx.countRows("engage_tiers"); got != 0 {
		t.Fatalf("a rejected ladder left %d tier rows behind", got)
	}
}

// TestPutEngageTiers_FailedSaveLeavesLadderIntact is why menu-item values are
// resolved BEFORE anything is deleted: a café mid-service must not lose a working
// ladder to a bad save.
func TestPutEngageTiers_FailedSaveLeavesLadderIntact(t *testing.T) {
	fx := newTenant(t)
	putCampaign(t, fx, engageBaseCampaign())
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 10, "label": "Good tier", "reward_kind": "flat", "amount_cents": 5000},
	}}).expectStatus(200)

	// A free-item tier pointing at an item that does not exist.
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 20, "label": "Broken", "reward_kind": "free_item", "menu_item_id": uuid.New()},
	}}).expectErr(400, "bad_request")

	var out struct {
		Tiers []EngageTier `json:"tiers"`
	}
	callHandler(t, fx, GetEngageCampaign, "GET", "/", nil).expectStatus(200).decode(&out)
	if len(out.Tiers) != 1 || out.Tiers[0].Label != "Good tier" {
		t.Fatalf("the original ladder was damaged by a failed save: %v", out.Tiers)
	}
}

// TestEngageTier_SurvivesMenuItemDeletion is the regression for a constraint that
// contradicted its own ON DELETE SET NULL: a CHECK demanding menu_item_id on a
// free_item tier made deleting the referenced menu item (and the 'menu' purge
// scope) fail outright. A tier whose item is gone must be a BROKEN tier the
// editor can flag, not a row the database refuses to let exist.
func TestEngageTier_SurvivesMenuItemDeletion(t *testing.T) {
	fx := newTenant(t)
	requireDB(t)
	ctx := context.Background()

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Doomed Tea", 5000)
	putCampaign(t, fx, engageBaseCampaign())
	callHandler(t, fx, PutEngageTiers, "PUT", "/", map[string]any{"tiers": []map[string]any{
		{"min_score": 25, "label": "Free tea", "reward_kind": "free_item", "menu_item_id": item},
	}}).expectStatus(200)

	if _, err := adminPool.Exec(ctx, `DELETE FROM menu_items WHERE id = $1`, item); err != nil {
		t.Fatalf("deleting a menu item referenced by a reward tier must succeed: %v", err)
	}

	var out struct {
		Tiers []EngageTier `json:"tiers"`
	}
	callHandler(t, fx, GetEngageCampaign, "GET", "/", nil).expectStatus(200).decode(&out)
	if len(out.Tiers) != 1 {
		t.Fatalf("got %d tiers, want the tier to survive as broken", len(out.Tiers))
	}
	if out.Tiers[0].MenuItemID != nil {
		t.Fatalf("menu_item_id = %v, want NULL after the item was deleted", out.Tiers[0].MenuItemID)
	}
}
