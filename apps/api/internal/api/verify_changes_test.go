package api

// Tests for the 2026-06-11 transparency / kitchen changes:
//   - house-tab SETTLEMENTS flow into the cafe balance (charges still don't)
//   - per-item auto_ready skips the kitchen (straight to served)
//
// Uses the shared two-pool RLS harness (newTenant, callHandler, seed helpers).

import "testing"

// =========================================================================
// House-tab settlements → cafe balance
// =========================================================================

// A cash settlement on an open shift lands physically in the drawer, so the
// live drawer total must rise by it — while the original tab CHARGE stays out
// of the balance (it's a receivable until settled).
func TestCafeBalance_CashSettlementHitsDrawer(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(0)
	tab := fx.seedHouseTab("Owner", true)

	// Charge 5000 to the tab — must NOT affect the drawer/balance.
	htSeedCharge(fx, tab, 5000)
	var b0 CafeBalance
	callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200).decode(&b0)
	if b0.DrawerCents != 0 {
		t.Fatalf("drawer = %d after a tab charge, want 0 (receivable)", b0.DrawerCents)
	}

	// Settle the 5000 in cash on the open shift → now in the drawer.
	htSeedSettlement(fx, tab, "cash", 5000, ptrUUID(shift))
	var b1 CafeBalance
	callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200).decode(&b1)
	if b1.DrawerCents != 5000 {
		t.Fatalf("drawer = %d, want 5000 after cash settlement", b1.DrawerCents)
	}
	if b1.TotalCents != 5000 {
		t.Fatalf("total = %d, want 5000 after cash settlement", b1.TotalCents)
	}
}

// An online settlement lands in the online channel, not the drawer.
func TestCafeBalance_OnlineSettlementHitsChannel(t *testing.T) {
	fx := newTenant(t)
	tab := fx.seedHouseTab("Owner", true)
	htSeedCharge(fx, tab, 4000)
	htSeedSettlement(fx, tab, "other", 4000, nil) // 'other' == online; no shift needed

	var b CafeBalance
	callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200).decode(&b)
	var online int64
	for _, c := range b.Channels {
		if c.Method == "online" {
			online = c.BalanceCents
		}
	}
	if online != 4000 {
		t.Fatalf("online channel = %d, want 4000 after online settlement", online)
	}
	if b.DrawerCents != 0 {
		t.Fatalf("drawer = %d, want 0 (online settlement shouldn't touch cash)", b.DrawerCents)
	}
}

// In the per-account view: the settlement is an inflow into its account; the
// underlying house-tab charge is excluded from every bucket.
func TestAccountBalances_SettlementInflowChargeExcluded(t *testing.T) {
	fx := newTenant(t)
	tab := fx.seedHouseTab("Owner", true)
	htSeedCharge(fx, tab, 6000)                   // method=house_tab → excluded
	htSeedSettlement(fx, tab, "other", 6000, nil) // settled online → inflow

	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).expectStatus(200).json()
	online := accountByMethod(m, "online")
	if int64(online["balance_cents"].(float64)) != 6000 {
		t.Fatalf("online balance = %v, want 6000 (settlement inflow)", online["balance_cents"])
	}
	// Cash + bank untouched.
	if int64(accountByMethod(m, "cash")["balance_cents"].(float64)) != 0 {
		t.Fatalf("cash balance should be 0")
	}
	if int64(accountByMethod(m, "bank")["balance_cents"].(float64)) != 0 {
		t.Fatalf("bank balance should be 0")
	}
}

// =========================================================================
// Auto-ready menu items skip the kitchen
// =========================================================================

func TestSendOrderToKitchen_AutoReadyStraightToServed(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)

	cig := ordSeedActiveItem(fx, "Cigarette", 200)
	fx.adminExec(`UPDATE menu_items SET auto_ready = true WHERE id = $1`, cig)
	momo := ordSeedActiveItem(fx, "Momo", 300)

	autoItem := fx.seedOrderItem(order, cig, 1, 200)
	cookItem := fx.seedOrderItem(order, momo, 1, 300)

	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).
		expectStatus(200).json()

	if int(r["auto_served"].(float64)) != 1 {
		t.Fatalf("auto_served = %v, want 1", r["auto_served"])
	}
	if int(r["to_kitchen"].(float64)) != 1 {
		t.Fatalf("to_kitchen = %v, want 1", r["to_kitchen"])
	}

	if got := ordItemKitchenStatus(fx, autoItem); got != "served" {
		t.Fatalf("auto-ready item status = %q, want served", got)
	}
	if ordItemSentAt(fx, autoItem) == nil {
		t.Fatal("auto-ready item should have sent_to_kitchen_at stamped")
	}
	var servedAt, readyAt *string
	fx.adminScan([]any{&servedAt, &readyAt},
		`SELECT served_at::text, ready_at::text FROM order_items WHERE id = $1`, autoItem)
	if servedAt == nil || readyAt == nil {
		t.Fatalf("auto-ready item should stamp ready_at + served_at (got ready=%v served=%v)", readyAt, servedAt)
	}

	if got := ordItemKitchenStatus(fx, cookItem); got != "in_progress" {
		t.Fatalf("normal item status = %q, want in_progress", got)
	}

	// The auto-served item must not appear on the kitchen board; only the
	// cooked item should be a ticket.
	tk := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).expectStatus(200).json()
	tickets, _ := tk["tickets"].([]any)
	if len(tickets) != 1 {
		t.Fatalf("kitchen tickets = %d, want 1 (auto-ready item must be off the board)", len(tickets))
	}
	if id := tickets[0].(map[string]any)["item_id"].(string); id != cookItem.String() {
		t.Fatalf("kitchen ticket item_id = %s, want the cooked item %s", id, cookItem)
	}
}
