package api

// Integration tests for:
//   - house_tabs.go  — ListHouseTabs, CreateHouseTab, GetHouseTab,
//                      UpdateHouseTab, DeleteHouseTab, CreateHouseTabSettlement
//   - accounts.go    — GetAccountBalances, ListTransfers,
//                      CreateTransfer, DeleteTransfer
//
// All tests run against the real local `cafe` database via the app-role
// (RLS + grant enforcement). Fixtures are tenant-isolated and cleaned up
// via CASCADE on tenants.
//
// MISSING-GRANT BUG (flagged per contract):
//   house_tab_settlements has only app=ar/pewssh (SELECT + INSERT).
//   UPDATE and DELETE are absent. No current handler needs them, so this
//   is not immediately breaking — but it will be a hard failure the moment
//   any settlement-edit or settlement-void path is added. Flag raised here
//   to match the pattern of 0028/0029 grant fix migrations.

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// local seed helpers (domain-prefixed to avoid collision with harness)
// =========================================================================

// htSeedSettlement inserts a house_tab_settlements row directly via the
// admin pool. shift may be nil.
func htSeedSettlement(fx *fixture, tabID uuid.UUID, method string, amountCents int64, shift *uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO house_tab_settlements
		   (tenant_id, house_tab_id, amount_cents, payment_method, recorded_by_user_id, shift_id)
		 VALUES ($1, $2, $3, $4::payment_method, $5, $6)
		 RETURNING id`,
		fx.Tenant, tabID, amountCents, method, fx.User, shift)
	return id
}

// htSeedCharge creates an open order, adds a single item, then inserts a
// house_tab payment row for it — simulating a full house-tab charge cycle
// without going through the payment handler. Returns (orderID, paymentID).
func htSeedCharge(fx *fixture, tabID uuid.UUID, amountCents int64) (uuid.UUID, uuid.UUID) {
	fx.t.Helper()
	cat := fx.seedCategory("HtCat-" + uuid.NewString()[:4])
	item := fx.seedMenuItem(cat, "HtItem", amountCents)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, amountCents)
	payID := fx.seedPayment(order, "house_tab", amountCents, nil)
	// stamp the house_tab_id directly — seedPayment doesn't expose it
	fx.adminExec(`UPDATE payments SET house_tab_id = $2 WHERE id = $1`, payID, tabID)
	return order, payID
}

// acctSeedTransfer inserts an account_transfers row directly. No cash_drop
// is created; shift is only needed when cash is involved (the DB CHECK
// enforces this).
func acctSeedTransfer(fx *fixture, from, to string, amountCents int64, shift *uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO account_transfers
		   (tenant_id, from_method, to_method, amount_cents, shift_id, recorded_by_user_id)
		 VALUES ($1, $2::payment_method, $3::payment_method, $4, $5, $6)
		 RETURNING id`,
		fx.Tenant, from, to, amountCents, shift, fx.User)
	return id
}

// =========================================================================
// ListHouseTabs
// =========================================================================

func TestListHouseTabs_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := r["house_tabs"].([]any)
	if len(tabs) != 0 {
		t.Fatalf("house_tabs = %d, want 0", len(tabs))
	}
}

func TestListHouseTabs_ReturnsRows(t *testing.T) {
	fx := newTenant(t)
	fx.seedHouseTab("Alpha", true)
	fx.seedHouseTab("Beta", false)
	r := callHandler(t, fx, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := r["house_tabs"].([]any)
	if len(tabs) != 2 {
		t.Fatalf("house_tabs = %d, want 2", len(tabs))
	}
}

// Active tabs must sort before inactive ones; within a group the order is
// case-insensitive by name.
func TestListHouseTabs_OrderingActiveThenName(t *testing.T) {
	fx := newTenant(t)
	fx.seedHouseTab("Zara", false) // inactive
	fx.seedHouseTab("Alpha", true) // active
	fx.seedHouseTab("Bravo", true) // active
	r := callHandler(t, fx, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := r["house_tabs"].([]any)
	if len(tabs) != 3 {
		t.Fatalf("house_tabs = %d, want 3", len(tabs))
	}
	name := func(i int) string {
		return tabs[i].(map[string]any)["name"].(string)
	}
	if name(0) != "Alpha" || name(1) != "Bravo" {
		t.Fatalf("first two should be active alphabetically, got %q %q", name(0), name(1))
	}
	if name(2) != "Zara" {
		t.Fatalf("inactive tab should be last, got %q", name(2))
	}
}

// Deleted tabs (soft-deleted) must be excluded from the list.
func TestListHouseTabs_DeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Phantom", true)
	fx.adminExec(`UPDATE house_tabs SET deleted_at = now() WHERE id = $1`, id)
	r := callHandler(t, fx, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := r["house_tabs"].([]any)
	if len(tabs) != 0 {
		t.Fatalf("deleted tab leaked into list; count = %d", len(tabs))
	}
}

// List response must be isolated by tenant.
func TestListHouseTabs_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedHouseTab("OnlyMine", true)
	r := callHandler(t, fx2, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := r["house_tabs"].([]any)
	if len(tabs) != 0 {
		t.Fatalf("cross-tenant leak: fx2 sees %d tabs", len(tabs))
	}
}

// Balance fields must be computed correctly in the list response.
func TestListHouseTabs_BalanceComputed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("StaffTab", true)
	htSeedCharge(fx, tabID, 5000)
	htSeedCharge(fx, tabID, 3000)
	htSeedSettlement(fx, tabID, "cash", 4000, nil)
	// charged = 8000, settled = 4000, balance = 4000

	r := callHandler(t, fx, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := r["house_tabs"].([]any)
	if len(tabs) != 1 {
		t.Fatalf("house_tabs = %d, want 1", len(tabs))
	}
	tab := tabs[0].(map[string]any)
	charged := int64(tab["charged_cents"].(float64))
	settled := int64(tab["settled_cents"].(float64))
	balance := int64(tab["balance_cents"].(float64))
	if charged != 8000 {
		t.Fatalf("charged_cents = %d, want 8000", charged)
	}
	if settled != 4000 {
		t.Fatalf("settled_cents = %d, want 4000", settled)
	}
	if balance != 4000 {
		t.Fatalf("balance_cents = %d, want 4000", balance)
	}
}

// =========================================================================
// CreateHouseTab
// =========================================================================

func TestCreateHouseTab_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateHouseTab, "POST", "/", "{not json").
		expectErr(400, "bad_request")
}

func TestCreateHouseTab_EmptyName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateHouseTab, "POST", "/", map[string]any{"name": ""}).
		expectErr(400, "bad_request")
}

func TestCreateHouseTab_WhitespaceName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateHouseTab, "POST", "/", map[string]any{"name": "   "}).
		expectErr(400, "bad_request")
}

func TestCreateHouseTab_DuplicateName(t *testing.T) {
	fx := newTenant(t)
	fx.seedHouseTab("Dupe", true)
	callHandler(t, fx, CreateHouseTab, "POST", "/", map[string]any{"name": "Dupe"}).
		expectErr(409, "name_taken")
}

// Duplicate check is case-insensitive (DB unique index is on lower(name)).
func TestCreateHouseTab_DuplicateNameCaseInsensitive(t *testing.T) {
	fx := newTenant(t)
	fx.seedHouseTab("OwnerA", true)
	callHandler(t, fx, CreateHouseTab, "POST", "/", map[string]any{"name": "ownera"}).
		expectErr(409, "name_taken")
}

func TestCreateHouseTab_Success(t *testing.T) {
	fx := newTenant(t)
	var ht HouseTab
	callHandler(t, fx, CreateHouseTab, "POST", "/",
		map[string]any{"name": "VIP Tab", "notes": "owner notes"}).
		expectStatus(201).decode(&ht)
	if ht.ID == uuid.Nil {
		t.Fatal("id is nil")
	}
	if ht.Name != "VIP Tab" {
		t.Fatalf("name = %q, want %q", ht.Name, "VIP Tab")
	}
	if ht.Notes != "owner notes" {
		t.Fatalf("notes = %q, want %q", ht.Notes, "owner notes")
	}
	if !ht.IsActive {
		t.Fatal("new tab should be active")
	}
	if n := fx.countRows("house_tabs"); n != 1 {
		t.Fatalf("house_tabs count = %d, want 1", n)
	}
}

func TestCreateHouseTab_NameTrimmed(t *testing.T) {
	fx := newTenant(t)
	var ht HouseTab
	callHandler(t, fx, CreateHouseTab, "POST", "/",
		map[string]any{"name": "  Padded  "}).
		expectStatus(201).decode(&ht)
	if ht.Name != "Padded" {
		t.Fatalf("name not trimmed: got %q", ht.Name)
	}
}

// Duplicate name from another tenant must NOT conflict.
func TestCreateHouseTab_DuplicateNameOtherTenantAllowed(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedHouseTab("Shared", true)
	callHandler(t, fx2, CreateHouseTab, "POST", "/",
		map[string]any{"name": "Shared"}).
		expectStatus(201)
}

// Negative opening balance must be rejected.
func TestCreateHouseTab_NegativeOpeningBalanceRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateHouseTab, "POST", "/",
		map[string]any{"name": "Bad", "opening_balance_cents": -100}).
		expectErr(400, "bad_request")
}

// Zero (or omitted) opening balance is the default — no seed payment/order created.
func TestCreateHouseTab_ZeroOpeningBalanceNoSeed(t *testing.T) {
	fx := newTenant(t)
	var ht HouseTab
	callHandler(t, fx, CreateHouseTab, "POST", "/",
		map[string]any{"name": "NoDebt"}).
		expectStatus(201).decode(&ht)
	if n := fx.countRows("payments"); n != 0 {
		t.Fatalf("payments = %d, want 0 when opening_balance_cents is omitted", n)
	}
	if n := fx.countRows("orders"); n != 0 {
		t.Fatalf("orders = %d, want 0 when opening_balance_cents is omitted", n)
	}
}

// A cafe onboarding with a customer who already owes money can seed that as
// an opening balance on tab creation — this must show up immediately in the
// tab's derived balance, via a house_tab payment anchored to a synthetic
// cancelled order (never a real serve, never touching a shift).
func TestCreateHouseTab_OpeningBalanceSeedsCharge(t *testing.T) {
	fx := newTenant(t)
	var ht HouseTab
	callHandler(t, fx, CreateHouseTab, "POST", "/",
		map[string]any{"name": "Old Customer", "opening_balance_cents": 15000}).
		expectStatus(201).decode(&ht)

	// The synthetic anchor order must carry no shift_id and be 'cancelled'.
	var status string
	var shiftUsed bool
	fx.adminScan([]any{&status}, `
		SELECT o.status::text FROM orders o
		JOIN payments p ON p.order_id = o.id
		WHERE p.house_tab_id = $1`, ht.ID)
	if status != "cancelled" {
		t.Fatalf("anchor order status = %q, want cancelled", status)
	}
	fx.adminScan([]any{&shiftUsed}, `
		SELECT shift_id IS NOT NULL FROM payments WHERE house_tab_id = $1`, ht.ID)
	if shiftUsed {
		t.Fatal("opening balance payment must not carry a shift_id")
	}

	// Balance must reflect the opening amount immediately, via both list
	// and detail reads.
	list := callHandler(t, fx, ListHouseTabs, "GET", "/", nil).
		expectStatus(200).json()
	tabs, _ := list["house_tabs"].([]any)
	tab := tabs[0].(map[string]any)
	if int64(tab["balance_cents"].(float64)) != 15000 {
		t.Fatalf("list balance_cents = %v, want 15000", tab["balance_cents"])
	}

	detail := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", ht.ID.String())).
		expectStatus(200).json()
	dht := detail["house_tab"].(map[string]any)
	if int64(dht["balance_cents"].(float64)) != 15000 {
		t.Fatalf("detail balance_cents = %v, want 15000", dht["balance_cents"])
	}
	charges, _ := detail["charges"].([]any)
	if len(charges) != 1 {
		t.Fatalf("charges = %d, want 1", len(charges))
	}
	charge := charges[0].(map[string]any)
	if charge["is_opening_balance"] != true {
		t.Fatalf("charge.is_opening_balance = %v, want true", charge["is_opening_balance"])
	}
	if int64(charge["amount_cents"].(float64)) != 15000 {
		t.Fatalf("charge.amount_cents = %v, want 15000", charge["amount_cents"])
	}

	// The synthetic order must stay out of ListOrders (existing marker filter).
	orders := callHandler(t, fx, ListOrders, "GET", "/", nil).
		expectStatus(200).json()
	oList, _ := orders["orders"].([]any)
	if len(oList) != 0 {
		t.Fatalf("synthetic opening-balance order leaked into ListOrders: %d", len(oList))
	}
}

// A regular (non-opening) charge must report is_opening_balance = false.
func TestGetHouseTab_RegularChargeNotFlaggedAsOpening(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Regular", true)
	htSeedCharge(fx, tabID, 4000)

	m := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", tabID.String())).
		expectStatus(200).json()
	charges, _ := m["charges"].([]any)
	if len(charges) != 1 {
		t.Fatalf("charges = %d, want 1", len(charges))
	}
	if charges[0].(map[string]any)["is_opening_balance"] != false {
		t.Fatalf("is_opening_balance = %v, want false", charges[0].(map[string]any)["is_opening_balance"])
	}
}

// =========================================================================
// GetHouseTab
// =========================================================================

func TestGetHouseTab_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestGetHouseTab_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

// Soft-deleted tabs must return 404.
func TestGetHouseTab_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Ghost", true)
	fx.adminExec(`UPDATE house_tabs SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestGetHouseTab_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Director", true)
	m := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", id.String())).
		expectStatus(200).json()
	ht, _ := m["house_tab"].(map[string]any)
	if ht == nil {
		t.Fatal("house_tab key missing")
	}
	if ht["name"] != "Director" {
		t.Fatalf("name = %v, want Director", ht["name"])
	}
	_, hasCharges := m["charges"]
	_, hasSettlements := m["settlements"]
	if !hasCharges || !hasSettlements {
		t.Fatal("response must include charges and settlements arrays")
	}
}

// Ledger arrays must be correctly populated.
func TestGetHouseTab_LedgerPopulated(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ledger", true)
	htSeedCharge(fx, tabID, 6000)
	htSeedSettlement(fx, tabID, "cash", 2000, nil)

	m := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", tabID.String())).
		expectStatus(200).json()

	charges, _ := m["charges"].([]any)
	settlements, _ := m["settlements"].([]any)
	if len(charges) != 1 {
		t.Fatalf("charges = %d, want 1", len(charges))
	}
	if len(settlements) != 1 {
		t.Fatalf("settlements = %d, want 1", len(settlements))
	}

	ht, _ := m["house_tab"].(map[string]any)
	charged := int64(ht["charged_cents"].(float64))
	settled := int64(ht["settled_cents"].(float64))
	balance := int64(ht["balance_cents"].(float64))
	if charged != 6000 || settled != 2000 || balance != 4000 {
		t.Fatalf("balance math: charged=%d settled=%d balance=%d; want 6000/2000/4000",
			charged, settled, balance)
	}
}

// Balance must equal zero when fully settled.
func TestGetHouseTab_BalanceZeroWhenFullySettled(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Zeroed", true)
	htSeedCharge(fx, tabID, 5000)
	htSeedSettlement(fx, tabID, "other", 5000, nil)

	m := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", tabID.String())).
		expectStatus(200).json()
	ht, _ := m["house_tab"].(map[string]any)
	if int64(ht["balance_cents"].(float64)) != 0 {
		t.Fatalf("balance should be 0 after full settlement; got %v", ht["balance_cents"])
	}
}

// Multiple charges from different orders must all appear.
func TestGetHouseTab_MultipleChargesListed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("MultiCharge", true)
	htSeedCharge(fx, tabID, 1000)
	htSeedCharge(fx, tabID, 2000)
	htSeedCharge(fx, tabID, 3000)

	m := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", tabID.String())).
		expectStatus(200).json()
	charges, _ := m["charges"].([]any)
	if len(charges) != 3 {
		t.Fatalf("charges = %d, want 3", len(charges))
	}
	ht, _ := m["house_tab"].(map[string]any)
	if int64(ht["charged_cents"].(float64)) != 6000 {
		t.Fatalf("charged_cents = %v, want 6000", ht["charged_cents"])
	}
}

// Tab from another tenant must return 404 (RLS isolation).
func TestGetHouseTab_CrossTenantBlocked(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := fx1.seedHouseTab("Private", true)
	callHandler(t, fx2, GetHouseTab, "GET", "/", nil, withParam("id", id.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// UpdateHouseTab
// =========================================================================

func TestUpdateHouseTab_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"name": "x"}, withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateHouseTab_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("ATab", true)
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/", "{badjson",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateHouseTab_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"name": "New"}, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateHouseTab_NameTaken(t *testing.T) {
	fx := newTenant(t)
	fx.seedHouseTab("Taken", true)
	id := fx.seedHouseTab("Original", true)
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"name": "Taken"}, withParam("id", id.String())).
		expectErr(409, "name_taken")
}

func TestUpdateHouseTab_UpdateName(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("OldName", true)
	var ht HouseTab
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"name": "NewName"}, withParam("id", id.String())).
		expectStatus(200).decode(&ht)
	if ht.Name != "NewName" {
		t.Fatalf("name = %q, want NewName", ht.Name)
	}
}

func TestUpdateHouseTab_UpdateNotes(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Tab", true)
	var ht HouseTab
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"notes": "some notes"}, withParam("id", id.String())).
		expectStatus(200).decode(&ht)
	if ht.Notes != "some notes" {
		t.Fatalf("notes = %q, want 'some notes'", ht.Notes)
	}
}

// Deactivating (is_active=false) must set archived_at.
func TestUpdateHouseTab_DeactivateSetsArchivedAt(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Active", true)
	isActive := false
	var ht HouseTab
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"is_active": isActive}, withParam("id", id.String())).
		expectStatus(200).decode(&ht)
	if ht.IsActive {
		t.Fatal("tab should be inactive after deactivate")
	}
	if ht.ArchivedAt == nil {
		t.Fatal("archived_at must be set when deactivated")
	}
}

// Reactivating (is_active=true) must clear archived_at.
func TestUpdateHouseTab_ReactivateClearsArchivedAt(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Arch", false)
	// archived_at starts nil in DB even though is_active=false unless set
	fx.adminExec(`UPDATE house_tabs SET archived_at = now() WHERE id = $1`, id)
	isActive := true
	var ht HouseTab
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"is_active": isActive}, withParam("id", id.String())).
		expectStatus(200).decode(&ht)
	if !ht.IsActive {
		t.Fatal("tab should be active after reactivate")
	}
	if ht.ArchivedAt != nil {
		t.Fatal("archived_at should be nil after reactivation")
	}
}

// Null patch (empty body {}) must be a no-op (COALESCE keeps existing values).
func TestUpdateHouseTab_NullPatchIsNoOp(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Stable", true)
	var ht HouseTab
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{}, withParam("id", id.String())).
		expectStatus(200).decode(&ht)
	if ht.Name != "Stable" {
		t.Fatalf("name changed unexpectedly: %q", ht.Name)
	}
}

// Soft-deleted tab must return 404 on update.
func TestUpdateHouseTab_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Dead", true)
	fx.adminExec(`UPDATE house_tabs SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, UpdateHouseTab, "PATCH", "/",
		map[string]any{"name": "Revive"}, withParam("id", id.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// DeleteHouseTab
// =========================================================================

func TestDeleteHouseTab_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteHouseTab, "DELETE", "/", nil, withParam("id", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteHouseTab_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteHouseTab, "DELETE", "/", nil, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

// Already soft-deleted tab must return 404 (idempotent guard).
func TestDeleteHouseTab_AlreadyDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Del", true)
	fx.adminExec(`UPDATE house_tabs SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, DeleteHouseTab, "DELETE", "/", nil, withParam("id", id.String())).
		expectErr(404, "not_found")
}

// Cannot delete a tab that has an outstanding balance.
func TestDeleteHouseTab_BalanceOutstandingBlocked(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("WithBalance", true)
	htSeedCharge(fx, tabID, 5000)
	// no settlement → balance = 5000
	callHandler(t, fx, DeleteHouseTab, "DELETE", "/", nil, withParam("id", tabID.String())).
		expectErr(409, "balance_outstanding")
}

// Can delete a tab that has a zero balance (fully settled).
func TestDeleteHouseTab_ZeroBalanceAllowed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Cleared", true)
	htSeedCharge(fx, tabID, 3000)
	htSeedSettlement(fx, tabID, "other", 3000, nil)
	callHandler(t, fx, DeleteHouseTab, "DELETE", "/", nil, withParam("id", tabID.String())).
		expectStatus(204)
	// Verify soft-deleted, not hard-deleted (payments FK still refers to it).
	var deletedAt *time.Time
	fx.adminScan([]any{&deletedAt}, `SELECT deleted_at FROM house_tabs WHERE id = $1`, tabID)
	if deletedAt == nil {
		t.Fatal("deleted_at not set after delete; row should be soft-deleted")
	}
}

// Can delete a tab that was never charged (no balance at all).
func TestDeleteHouseTab_NeverChargedAllowed(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Empty", true)
	callHandler(t, fx, DeleteHouseTab, "DELETE", "/", nil, withParam("id", id.String())).
		expectStatus(204)
	// Soft delete: the row stays (payments FK is RESTRICT) but deleted_at is set.
	var deleted bool
	fx.adminScan([]any{&deleted}, `SELECT deleted_at IS NOT NULL FROM house_tabs WHERE id = $1`, id)
	if !deleted {
		t.Fatal("house tab not soft-deleted")
	}
}

// =========================================================================
// CreateHouseTabSettlement
// =========================================================================

func TestCreateHouseTabSettlement_BadTabID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 100, "payment_method": "cash"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestCreateHouseTabSettlement_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Tab", true)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/", "{bad",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreateHouseTabSettlement_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Tab", true)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 0, "payment_method": "cash"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreateHouseTabSettlement_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Tab", true)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": -500, "payment_method": "cash"},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestCreateHouseTabSettlement_BadMethod(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Tab", true)
	htSeedCharge(fx, id, 2000)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 500, "payment_method": "bitcoin"},
		withParam("id", id.String())).
		expectErr(400, "bad_method")
}

// house_tab as payment_method must be rejected (not a valid settlement method).
func TestCreateHouseTabSettlement_HouseTabMethodRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Tab", true)
	htSeedCharge(fx, id, 2000)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 500, "payment_method": "house_tab"},
		withParam("id", id.String())).
		expectErr(400, "bad_method")
}

func TestCreateHouseTabSettlement_TabNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 500, "payment_method": "cash"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

// Soft-deleted tab must return 404.
func TestCreateHouseTabSettlement_DeletedTabNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.seedHouseTab("Del", true)
	fx.adminExec(`UPDATE house_tabs SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 100, "payment_method": "other"},
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

// Settlement that would push balance negative is overpayment.
func TestCreateHouseTabSettlement_Overpayment(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("OverTab", true)
	htSeedCharge(fx, tabID, 1000) // balance = 1000
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 2000, "payment_method": "cash"},
		withParam("id", tabID.String())).
		expectErr(409, "overpayment")
}

// Cash settlement without an open shift is now allowed: it records with a
// NULL shift_id and still lands in the cash account balance (it just isn't
// attributed to a drawer session).
func TestCreateHouseTabSettlement_CashNoShiftAllowed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("CashTab", true)
	htSeedCharge(fx, tabID, 5000) // balance = 5000
	var s HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 1000, "payment_method": "cash"},
		withParam("id", tabID.String())).
		expectStatus(201).decode(&s)
	if s.PaymentMethod != "cash" {
		t.Fatalf("payment_method = %q, want cash", s.PaymentMethod)
	}
	// shift_id must be NULL when no shift is open.
	var shiftNull bool
	fx.adminScan([]any{&shiftNull},
		`SELECT shift_id IS NULL FROM house_tab_settlements WHERE house_tab_id = $1`, tabID)
	if !shiftNull {
		t.Fatal("shift_id must be NULL when no shift is open")
	}
	// The cash lands in the cash account balance regardless of shift.
	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	cashAcc := accountByMethod(m, "cash")
	if int64(cashAcc["payments_cents"].(float64)) != 1000 {
		t.Fatalf("cash payments_cents = %v, want 1000 (cash settlement)", cashAcc["payments_cents"])
	}
}

// Bank settlement records payment_method='bank' and flows into the bank
// account bucket.
func TestCreateHouseTabSettlement_BankFlowsToBankBucket(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("BankTab", true)
	htSeedCharge(fx, tabID, 5000) // balance = 5000
	var s HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 3000, "payment_method": "bank",
			"reference_no": "TXN-9"},
		withParam("id", tabID.String())).
		expectStatus(201).decode(&s)
	if s.PaymentMethod != "bank" {
		t.Fatalf("payment_method = %q, want bank", s.PaymentMethod)
	}
	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	bankAcc := accountByMethod(m, "bank")
	if int64(bankAcc["payments_cents"].(float64)) != 3000 {
		t.Fatalf("bank payments_cents = %v, want 3000 (bank settlement)", bankAcc["payments_cents"])
	}
	// It must NOT bleed into cash/online buckets.
	cashAcc := accountByMethod(m, "cash")
	if int64(cashAcc["payments_cents"].(float64)) != 0 {
		t.Fatalf("cash payments_cents = %v, want 0", cashAcc["payments_cents"])
	}
}

// Non-cash methods do not require a shift.
func TestCreateHouseTabSettlement_OtherNoShiftNeeded(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("OnlineTab", true)
	htSeedCharge(fx, tabID, 5000)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 1000, "payment_method": "other"},
		withParam("id", tabID.String())).
		expectStatus(201)
}

// "online" is normalised to "other" in the stored row.
func TestCreateHouseTabSettlement_OnlineNormalisedToOther(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("NormTab", true)
	htSeedCharge(fx, tabID, 5000)
	var s HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 500, "payment_method": "online"},
		withParam("id", tabID.String())).
		expectStatus(201).decode(&s)
	if s.PaymentMethod != "other" {
		t.Fatalf("payment_method = %q, want other", s.PaymentMethod)
	}
}

// Cash settlement with open shift must succeed and decrease balance.
func TestCreateHouseTabSettlement_CashSuccess(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("ShiftTab", true)
	htSeedCharge(fx, tabID, 5000) // balance = 5000
	fx.seedOpenShift(0)
	var s HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 2000, "payment_method": "cash",
			"reference_no": "REF-1", "notes": "partial"},
		withParam("id", tabID.String())).
		expectStatus(201).decode(&s)
	if s.AmountCents != 2000 {
		t.Fatalf("amount_cents = %d, want 2000", s.AmountCents)
	}
	if s.PaymentMethod != "cash" {
		t.Fatalf("payment_method = %q, want cash", s.PaymentMethod)
	}
	// verify DB row count
	var cnt int
	fx.adminScan([]any{&cnt},
		`SELECT count(*) FROM house_tab_settlements WHERE house_tab_id = $1`, tabID)
	if cnt != 1 {
		t.Fatalf("house_tab_settlements = %d, want 1", cnt)
	}
}

// Full settlement must bring balance to exactly zero.
func TestCreateHouseTabSettlement_FullSettlementZerosBalance(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("ZeroOut", true)
	htSeedCharge(fx, tabID, 3000)
	htSeedSettlement(fx, tabID, "other", 1000, nil) // remaining = 2000
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 2000, "payment_method": "other"},
		withParam("id", tabID.String())).
		expectStatus(201)
	// Confirm balance via GetHouseTab.
	m := callHandler(t, fx, GetHouseTab, "GET", "/", nil, withParam("id", tabID.String())).
		expectStatus(200).json()
	ht := m["house_tab"].(map[string]any)
	if int64(ht["balance_cents"].(float64)) != 0 {
		t.Fatalf("balance after full settlement = %v, want 0", ht["balance_cents"])
	}
}

// A settlement exactly equal to the current balance is allowed (not overpayment).
func TestCreateHouseTabSettlement_ExactBalanceAllowed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Exact", true)
	htSeedCharge(fx, tabID, 4000)
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 4000, "payment_method": "other"},
		withParam("id", tabID.String())).
		expectStatus(201)
}

// Settling an inactive tab is allowed — settlement is independent of
// is_active; the guard is only checked on new charges (RecordPayment).
func TestCreateHouseTabSettlement_InactiveTabAllowed(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Inactive", false)
	htSeedCharge(fx, tabID, 2000) // balance seeded before deactivation
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 500, "payment_method": "other"},
		withParam("id", tabID.String())).
		expectStatus(201)
}

// =========================================================================
// GetAccountBalances
// =========================================================================

func TestGetAccountBalances_ZeroOnFreshTenant(t *testing.T) {
	fx := newTenant(t)
	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	accounts, _ := m["accounts"].([]any)
	if len(accounts) != 3 {
		t.Fatalf("accounts = %d, want 3 (cash/online/bank)", len(accounts))
	}
	for _, a := range accounts {
		acc := a.(map[string]any)
		if int64(acc["balance_cents"].(float64)) != 0 {
			t.Fatalf("account %v balance should be 0 on fresh tenant", acc["method"])
		}
	}
}

// Payments flow into the correct bucket.
func TestGetAccountBalances_CashPaymentBucket(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.seedPayment(order, "cash", 5000, nil)

	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	cashAcc := accountByMethod(m, "cash")
	if int64(cashAcc["payments_cents"].(float64)) != 5000 {
		t.Fatalf("cash payments_cents = %v, want 5000", cashAcc["payments_cents"])
	}
	if int64(cashAcc["balance_cents"].(float64)) != 5000 {
		t.Fatalf("cash balance_cents = %v, want 5000", cashAcc["balance_cents"])
	}
}

// Historical enum values (esewa, khalti, card, other) all roll up into
// the "online" bucket.
func TestGetAccountBalances_OnlineBucketRollsUpHistorical(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.seedPayment(order, "other", 1000, nil)
	fx.seedPayment(order, "esewa", 2000, nil)
	fx.seedPayment(order, "khalti", 3000, nil)
	fx.seedPayment(order, "card", 4000, nil)

	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	onlineAcc := accountByMethod(m, "online")
	if int64(onlineAcc["payments_cents"].(float64)) != 10000 {
		t.Fatalf("online payments_cents = %v, want 10000", onlineAcc["payments_cents"])
	}
}

// house_tab payments must NOT appear in any balance bucket.
func TestGetAccountBalances_HouseTabExcluded(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("T", true)
	htSeedCharge(fx, tabID, 9000)

	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	accounts, _ := m["accounts"].([]any)
	for _, a := range accounts {
		acc := a.(map[string]any)
		if int64(acc["payments_cents"].(float64)) != 0 {
			t.Fatalf("house_tab leaked into bucket %v: payments_cents = %v",
				acc["method"], acc["payments_cents"])
		}
	}
}

// Transfer from cash to bank moves money between buckets.
func TestGetAccountBalances_TransferAffectsBothBuckets(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(0)
	acctSeedTransfer(fx, "cash", "bank", 3000, ptrUUID(shift))

	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	cashAcc := accountByMethod(m, "cash")
	bankAcc := accountByMethod(m, "bank")

	// cash: transfers_out = 3000, balance = -3000
	if int64(cashAcc["transfers_out_cents"].(float64)) != 3000 {
		t.Fatalf("cash transfers_out = %v, want 3000", cashAcc["transfers_out_cents"])
	}
	// bank: transfers_in = 3000, balance = +3000
	if int64(bankAcc["transfers_in_cents"].(float64)) != 3000 {
		t.Fatalf("bank transfers_in = %v, want 3000", bankAcc["transfers_in_cents"])
	}
}

// Fees on outgoing transfers are counted as part of the outflow.
func TestGetAccountBalances_FeeIncludedInTransfersOut(t *testing.T) {
	fx := newTenant(t)
	// online → bank, 1000 amount + 50 fee; no cash side, no shift needed
	acctSeedTransfer(fx, "online", "bank", 1000, nil)
	// seed a second transfer with explicit fee via admin (no handler path for online→bank fee yet)
	fx.adminExec(`
		UPDATE account_transfers SET fee_cents = 50
		WHERE tenant_id = $1 AND from_method = 'online'`, fx.Tenant)

	m := callHandler(t, fx, GetAccountBalances, "GET", "/", nil).
		expectStatus(200).json()
	onlineAcc := accountByMethod(m, "online")
	// transfers_out = amount_cents + fee_cents = 1000 + 50 = 1050
	if int64(onlineAcc["transfers_out_cents"].(float64)) != 1050 {
		t.Fatalf("online transfers_out = %v, want 1050", onlineAcc["transfers_out_cents"])
	}
}

// accountByMethod is a small helper for balance assertion tests.
func accountByMethod(m map[string]any, method string) map[string]any {
	accounts, _ := m["accounts"].([]any)
	for _, a := range accounts {
		acc, _ := a.(map[string]any)
		if acc["method"] == method {
			return acc
		}
	}
	panic("account not found: " + method)
}

// =========================================================================
// ListTransfers
// =========================================================================

func TestListTransfers_Empty(t *testing.T) {
	fx := newTenant(t)
	m := callHandler(t, fx, ListTransfers, "GET", "/", nil).
		expectStatus(200).json()
	transfers, _ := m["transfers"].([]any)
	if len(transfers) != 0 {
		t.Fatalf("transfers = %d, want 0", len(transfers))
	}
}

func TestListTransfers_WithRows(t *testing.T) {
	fx := newTenant(t)
	acctSeedTransfer(fx, "online", "bank", 2000, nil)
	acctSeedTransfer(fx, "bank", "online", 1000, nil)
	m := callHandler(t, fx, ListTransfers, "GET", "/", nil).
		expectStatus(200).json()
	transfers, _ := m["transfers"].([]any)
	if len(transfers) != 2 {
		t.Fatalf("transfers = %d, want 2", len(transfers))
	}
}

// List is ordered by transferred_at DESC (newest first).
func TestListTransfers_OrderedNewestFirst(t *testing.T) {
	fx := newTenant(t)
	// Insert with explicit timestamps so order is deterministic.
	fx.adminExec(`
		INSERT INTO account_transfers
		  (tenant_id, from_method, to_method, amount_cents, transferred_at, recorded_by_user_id)
		VALUES ($1, 'online', 'bank', 100, now() - interval '2 hours', $2),
		       ($1, 'bank', 'online', 200, now() - interval '1 hour',  $2)`,
		fx.Tenant, fx.User)
	m := callHandler(t, fx, ListTransfers, "GET", "/", nil).
		expectStatus(200).json()
	transfers, _ := m["transfers"].([]any)
	if len(transfers) != 2 {
		t.Fatalf("transfers = %d, want 2", len(transfers))
	}
	// Newest (bank→online, 200) should be first.
	first := transfers[0].(map[string]any)
	if int64(first["amount_cents"].(float64)) != 200 {
		t.Fatalf("first transfer amount = %v, want 200 (newest)", first["amount_cents"])
	}
}

// Must not see rows from another tenant.
func TestListTransfers_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	acctSeedTransfer(fx1, "online", "bank", 9999, nil)
	m := callHandler(t, fx2, ListTransfers, "GET", "/", nil).
		expectStatus(200).json()
	transfers, _ := m["transfers"].([]any)
	if len(transfers) != 0 {
		t.Fatalf("cross-tenant leak: fx2 sees %d transfers", len(transfers))
	}
}

// =========================================================================
// CreateTransfer
// =========================================================================

func TestCreateTransfer_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/", "{bad").
		expectErr(400, "bad_request")
}

func TestCreateTransfer_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "online", "to_method": "bank", "amount_cents": 0}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "online", "to_method": "bank", "amount_cents": -100}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_NegativeFee(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "online", "to_method": "bank",
			"amount_cents": 100, "fee_cents": -1}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_MissingFromMethod(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"to_method": "bank", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_MissingToMethod(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "cash", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

// Same source and destination must be rejected.
func TestCreateTransfer_SameAccountRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "cash", "to_method": "cash", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_SameAccountOnline(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "online", "to_method": "online", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

// house_tab is not a valid transfer endpoint.
func TestCreateTransfer_HouseTabFromRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "house_tab", "to_method": "bank", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_HouseTabToRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "bank", "to_method": "house_tab", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

// Historical enum values (esewa, khalti, etc.) must not be accepted as endpoints.
func TestCreateTransfer_LegacyMethodRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "esewa", "to_method": "bank", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

func TestCreateTransfer_UnknownMethodRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "bitcoin", "to_method": "bank", "amount_cents": 100}).
		expectErr(400, "bad_request")
}

// Cash side requires an open shift.
func TestCreateTransfer_CashFromRequiresShift(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "cash", "to_method": "bank", "amount_cents": 500}).
		expectErr(409, "shift_required")
}

func TestCreateTransfer_CashToRequiresShift(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "bank", "to_method": "cash", "amount_cents": 500}).
		expectErr(409, "shift_required")
}

// online → bank does not touch cash, so no shift is needed.
func TestCreateTransfer_OnlineToBankNoShiftNeeded(t *testing.T) {
	fx := newTenant(t)
	var out AccountTransfer
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "online", "to_method": "bank", "amount_cents": 1000}).
		expectStatus(201).decode(&out)
	if out.ID == uuid.Nil {
		t.Fatal("transfer id is nil")
	}
	if out.FromMethod != "online" || out.ToMethod != "bank" {
		t.Fatalf("methods = %q/%q, want online/bank", out.FromMethod, out.ToMethod)
	}
}

// Cash side with open shift must succeed and link a cash_drop row.
func TestCreateTransfer_CashToOnlineCreatesDropAndTransfer(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(0)
	var out AccountTransfer
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "cash", "to_method": "online", "amount_cents": 2000}).
		expectStatus(201).decode(&out)
	if out.CashDropID == nil {
		t.Fatal("cash_drop_id must be set when cash side is involved")
	}
	if out.ShiftID == nil {
		t.Fatal("shift_id must be set when cash side is involved")
	}
	// Verify cash_drop row was actually written.
	var cnt int
	fx.adminScan([]any{&cnt},
		`SELECT count(*) FROM cash_drops WHERE id = $1`, *out.CashDropID)
	if cnt != 1 {
		t.Fatalf("cash_drops row not found for id %v", *out.CashDropID)
	}
}

// Fee is persisted correctly.
func TestCreateTransfer_FeePersistedCorrectly(t *testing.T) {
	fx := newTenant(t)
	var out AccountTransfer
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{
			"from_method":  "online",
			"to_method":    "bank",
			"amount_cents": 5000,
			"fee_cents":    50,
			"reference_no": "TRF-001",
			"notes":        "weekly sweep",
		}).
		expectStatus(201).decode(&out)
	if out.AmountCents != 5000 {
		t.Fatalf("amount_cents = %d, want 5000", out.AmountCents)
	}
	if out.FeeCents != 50 {
		t.Fatalf("fee_cents = %d, want 50", out.FeeCents)
	}
	if out.ReferenceNo != "TRF-001" {
		t.Fatalf("reference_no = %q, want TRF-001", out.ReferenceNo)
	}
}

// Zero fee is valid.
func TestCreateTransfer_ZeroFeeIsValid(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "online", "to_method": "bank",
			"amount_cents": 100, "fee_cents": 0}).
		expectStatus(201)
}

// DB row count confirms persistence.
func TestCreateTransfer_DbRowCreated(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "bank", "to_method": "online", "amount_cents": 300}).
		expectStatus(201)
	if n := fx.countRows("account_transfers"); n != 1 {
		t.Fatalf("account_transfers count = %d, want 1", n)
	}
}

// =========================================================================
// DeleteTransfer
// =========================================================================

func TestDeleteTransfer_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteTransfer, "DELETE", "/", nil, withParam("id", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteTransfer_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteTransfer, "DELETE", "/", nil, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

// Cannot delete a transfer whose cash side's shift is already closed.
func TestDeleteTransfer_ShiftClosed(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(0)
	id := acctSeedTransfer(fx, "cash", "bank", 1000, ptrUUID(shift))
	fx.closeShift(shift)
	callHandler(t, fx, DeleteTransfer, "DELETE", "/", nil, withParam("id", id.String())).
		expectErr(409, "shift_closed")
}

// Non-cash transfer (no shift) can always be deleted.
func TestDeleteTransfer_NoCashDeleteSucceeds(t *testing.T) {
	fx := newTenant(t)
	id := acctSeedTransfer(fx, "online", "bank", 2000, nil)
	callHandler(t, fx, DeleteTransfer, "DELETE", "/", nil, withParam("id", id.String())).
		expectStatus(204)
	if n := fx.countRows("account_transfers"); n != 0 {
		t.Fatalf("account_transfers = %d after delete, want 0", n)
	}
}

// Cash transfer with open shift can be deleted; paired cash_drop is also deleted.
func TestDeleteTransfer_CashOpenShiftDeletesDropToo(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(0)
	// Create the transfer via the handler so cash_drop is auto-created.
	var out AccountTransfer
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "cash", "to_method": "online", "amount_cents": 1500}).
		expectStatus(201).decode(&out)
	dropID := out.CashDropID
	if dropID == nil {
		t.Fatal("setup: expected cash_drop_id")
	}
	// Now delete.
	callHandler(t, fx, DeleteTransfer, "DELETE", "/", nil, withParam("id", out.ID.String())).
		expectStatus(204)
	// Transfer row gone.
	if n := fx.countRows("account_transfers"); n != 0 {
		t.Fatalf("account_transfers = %d after delete, want 0", n)
	}
	// cash_drop row must also be gone.
	var cnt int
	fx.adminScan([]any{&cnt}, `SELECT count(*) FROM cash_drops WHERE id = $1`, *dropID)
	if cnt != 0 {
		t.Fatalf("cash_drops row still present after transfer delete")
	}
}

// Cross-tenant: cannot delete another tenant's transfer (404, not 403,
// because RLS makes foreign rows invisible).
func TestDeleteTransfer_CrossTenantBlocked(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := acctSeedTransfer(fx1, "online", "bank", 500, nil)
	callHandler(t, fx2, DeleteTransfer, "DELETE", "/", nil, withParam("id", id.String())).
		expectErr(404, "not_found")
}
