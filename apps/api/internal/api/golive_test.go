package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// seedOwner inserts a cafe_owners row and returns its id.
func (fx *fixture) seedOwner(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO cafe_owners (tenant_id, display_name, share_units) VALUES ($1, $2, 1) RETURNING id`,
		fx.Tenant, name)
	return id
}

// runGoLive POSTs a spec through the GoLive handler (app pool, RLS, grants —
// exactly like prod) and returns the response.
func runGoLive(t *testing.T, fx *fixture, spec GoLiveSpec) *apiResp {
	return callHandler(t, fx, GoLive(testHub()), "POST", "/v1/finance/go-live", spec)
}

func TestGoLive_SeedsOpeningBalances(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Latte", 50000) // Rs 500
	table := fx.seedTable("T5")
	tab := fx.seedHouseTab("Supplier X", true)
	owner := fx.seedOwner("Owner A")

	spec := GoLiveSpec{
		DrawerCents: 150000, // Rs 1,500
		BankCents:   800000, // Rs 8,000
		OnlineCents: 120000, // Rs 1,200
		Owners: []GoLiveOwnerSpec{
			{OwnerID: owner, InvestmentCents: 500000, CashHeldCents: 30000},
		},
		HouseTabs: []GoLiveHouseTabSpec{
			{HouseTabID: tab, OutstandingCents: 45000},
		},
		CustomerTabs: []GoLiveCustomerTabSpec{
			{ServiceTableID: &table, Items: []GoLiveTabItem{{MenuItemID: item, Qty: 2}}},
		},
	}
	runGoLive(t, fx, spec).expectStatus(http.StatusOK)

	// --- Cafe balance: drawer + bank (NOT +investment) + owner cash + online ---
	var cb struct {
		DrawerCents    int64 `json:"drawer_cents"`
		BankCents      int64 `json:"bank_cents"`
		OwnerCashCents int64 `json:"owner_cash_cents"`
		TotalCents     int64 `json:"total_cents"`
		Channels       []struct {
			Method       string `json:"method"`
			BalanceCents int64  `json:"balance_cents"`
		} `json:"channels"`
	}
	res := callHandler(t, fx, GetCafeBalance, "GET", "/v1/finance/cafe-balance", nil).expectStatus(http.StatusOK)
	mustJSON(t, res.Body, &cb)
	if cb.DrawerCents != 150000 {
		t.Errorf("drawer = %d, want 150000", cb.DrawerCents)
	}
	if cb.BankCents != 800000 {
		t.Errorf("bank = %d, want 800000 (opening investment must NOT double-count)", cb.BankCents)
	}
	if cb.OwnerCashCents != 30000 {
		t.Errorf("owner cash = %d, want 30000", cb.OwnerCashCents)
	}
	var online int64
	for _, c := range cb.Channels {
		online += c.BalanceCents
	}
	if online != 120000 {
		t.Errorf("online channels = %d, want 120000", online)
	}
	// House tab + customer tab are receivables — NOT in the cash position.
	if want := int64(150000 + 800000 + 30000 + 120000); cb.TotalCents != want {
		t.Errorf("total = %d, want %d", cb.TotalCents, want)
	}

	// --- Cafe summary: opening investment counts for ROI; revenue is 0 ---
	var cs struct {
		LifetimeInvestedCents int64 `json:"lifetime_invested_cents"`
		LifetimeRevenueCents  int64 `json:"lifetime_revenue_cents"`
		CafeBalanceCents      int64 `json:"cafe_balance_cents"`
	}
	res = callHandler(t, fx, GetCafeSummary, "GET", "/v1/finance/cafe-summary", nil).expectStatus(http.StatusOK)
	mustJSON(t, res.Body, &cs)
	if cs.LifetimeInvestedCents != 500000 {
		t.Errorf("lifetime invested = %d, want 500000 (opening flag still counts for ROI)", cs.LifetimeInvestedCents)
	}
	if cs.LifetimeRevenueCents != 0 {
		t.Errorf("lifetime revenue = %d, want 0 (no closed orders)", cs.LifetimeRevenueCents)
	}

	// --- Accounts page: bank + online consistent; cash tile is 0 (known quirk) ---
	var ab struct {
		Accounts []struct {
			Method       string `json:"method"`
			BalanceCents int64  `json:"balance_cents"`
		} `json:"accounts"`
	}
	res = callHandler(t, fx, GetAccountBalances, "GET", "/v1/accounts/balances", nil).expectStatus(http.StatusOK)
	mustJSON(t, res.Body, &ab)
	byMethod := map[string]int64{}
	for _, a := range ab.Accounts {
		byMethod[a.Method] = a.BalanceCents
	}
	if byMethod["bank"] != 800000 {
		t.Errorf("accounts bank = %d, want 800000", byMethod["bank"])
	}
	if byMethod["online"] != 120000 {
		t.Errorf("accounts online = %d, want 120000", byMethod["online"])
	}
	if byMethod["cash"] != 0 {
		t.Errorf("accounts cash tile = %d, want 0 (drawer float shows on cafe-balance, not here)", byMethod["cash"])
	}

	// --- House tab: opening charge = outstanding ---
	var ht struct {
		HouseTabs []struct {
			ID           uuid.UUID `json:"id"`
			BalanceCents int64     `json:"balance_cents"`
		} `json:"house_tabs"`
	}
	res = callHandler(t, fx, ListHouseTabs, "GET", "/v1/house-tabs", nil).expectStatus(http.StatusOK)
	mustJSON(t, res.Body, &ht)
	var tabBal int64 = -1
	for _, h := range ht.HouseTabs {
		if h.ID == tab {
			tabBal = h.BalanceCents
		}
	}
	if tabBal != 45000 {
		t.Errorf("house tab balance = %d, want 45000", tabBal)
	}

	// --- Orders: customer tab is open with the right live subtotal; the
	//     synthetic opening-balance order never shows. ---
	var ord struct {
		Orders []struct {
			ID                uuid.UUID `json:"id"`
			Status            string    `json:"status"`
			Notes             string    `json:"notes"`
			LiveSubtotalCents int64     `json:"live_subtotal_cents"`
		} `json:"orders"`
	}
	res = callHandler(t, fx, ListOrders, "GET", "/v1/orders", nil).expectStatus(http.StatusOK)
	mustJSON(t, res.Body, &ord)
	if len(ord.Orders) != 1 {
		t.Fatalf("orders count = %d, want 1 (only the customer tab; opening anchor hidden)", len(ord.Orders))
	}
	if ord.Orders[0].Status != "open" {
		t.Errorf("tab status = %q, want open", ord.Orders[0].Status)
	}
	if ord.Orders[0].LiveSubtotalCents != 100000 {
		t.Errorf("tab subtotal = %d, want 100000 (2 x Rs 500)", ord.Orders[0].LiveSubtotalCents)
	}

	// --- Idempotency: a second run is rejected; wentLiveAt is set exactly once. ---
	res = runGoLive(t, fx, spec).expectStatus(http.StatusConflict)
	if res.errKind() != "already_live" {
		t.Errorf("second run errKind = %q, want already_live", res.errKind())
	}

	var liveCount int
	fx.adminScan([]any{&liveCount},
		`SELECT count(*) FROM tenants WHERE id = $1 AND preferences ? 'wentLiveAt'`, fx.Tenant)
	if liveCount != 1 {
		t.Errorf("wentLiveAt present on %d rows, want 1", liveCount)
	}
}

func TestGoLive_RejectsUnknownOwner(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	spec := GoLiveSpec{
		Owners: []GoLiveOwnerSpec{{OwnerID: uuid.New(), InvestmentCents: 1000}},
	}
	res := runGoLive(t, fx, spec).expectStatus(http.StatusBadRequest)
	if res.errKind() != "bad_request" {
		t.Errorf("errKind = %q, want bad_request", res.errKind())
	}
	// Nothing should have been written (the seed rolled back).
	if n := fx.countRows("owner_ledger"); n != 0 {
		t.Errorf("owner_ledger rows = %d, want 0 after rollback", n)
	}
}

func TestDeleteTenantCascade_RemovesEverythingButUsers(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	// Seed a spread of child rows across cascade depths.
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Latte", 50000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 50000)
	fx.seedPayment(order, "cash", 50000, nil)
	owner := fx.seedOwner("Owner A")
	fx.adminExec(`INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, created_by_user_id)
	              VALUES ($1, $2, 'investment'::owner_ledger_kind, 1000, $3)`, fx.Tenant, owner, fx.User)

	ctx := context.Background()
	var deleted int64
	if err := adminPool.QueryRow(ctx, `SELECT delete_tenant_cascade($1)`, fx.Tenant).Scan(&deleted); err != nil {
		t.Fatalf("delete_tenant_cascade: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}

	// Tenant + every child gone.
	for _, q := range []struct {
		table string
		sql   string
	}{
		{"tenants", `SELECT count(*) FROM tenants WHERE id = $1`},
		{"orders", `SELECT count(*) FROM orders WHERE tenant_id = $1`},
		{"order_items", `SELECT count(*) FROM order_items WHERE tenant_id = $1`},
		{"payments", `SELECT count(*) FROM payments WHERE tenant_id = $1`},
		{"owner_ledger", `SELECT count(*) FROM owner_ledger WHERE tenant_id = $1`},
		{"cafe_owners", `SELECT count(*) FROM cafe_owners WHERE tenant_id = $1`},
		{"menu_items", `SELECT count(*) FROM menu_items WHERE tenant_id = $1`},
		{"tenant_members", `SELECT count(*) FROM tenant_members WHERE tenant_id = $1`},
	} {
		var n int
		if err := adminPool.QueryRow(ctx, q.sql, fx.Tenant).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", q.table, err)
		}
		if n != 0 {
			t.Errorf("%s still has %d rows after deep delete", q.table, n)
		}
	}

	// Shared user survives (only the membership cascaded away).
	var users int
	if err := adminPool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, fx.User).Scan(&users); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if users != 1 {
		t.Errorf("owner user count = %d, want 1 (users are shared, not deleted)", users)
	}
}

// mustJSON unmarshals a response body or fails the test.
func mustJSON(t *testing.T, body []byte, dst any) {
	t.Helper()
	if err := json.Unmarshal(body, dst); err != nil {
		t.Fatalf("unmarshal: %v; body: %s", err, string(body))
	}
}
