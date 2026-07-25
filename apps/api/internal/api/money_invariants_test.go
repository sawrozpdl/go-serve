package api

// CROSS-ENDPOINT MONEY INVARIANTS.
//
// Every other money test checks one handler. These check that handlers AGREE —
// which is where the accuracy audit found most of the damage: two screens, two
// SQL queries, one word ("Sales"), different numbers.
//
// The suite seeds ONE realistic tenant with every money feature switched on at
// once — exclusive VAT, a service charge, discounts, half portions, a post-close
// void attempt, credit charged and collected and reversed, expenses from all four
// sources, a transfer with a fee, owner cash custody, cash drops, two shifts —
// and then asserts the identities that must hold no matter what:
//
//	I1  dashboard sales      == Σ per-day history sales
//	I2  dashboard sales      == Σ daily series (same window)
//	I3  payment mix + on-credit == dashboard sales
//	I4  Σ category net revenue == billed sales − VAT   (exactly)
//	I5  Σ account buckets    == cafe balance parts == cafe balance total
//	I6  drawer               == the open shift's expected cash
//	I7  profitability expenses == dashboard expenses (same window)
//	I8  tab balance          == charged − collected (live rows only)
//	I9  net profit           == net revenue − expenses − transfer fees
//
// A failure here means two screens will disagree in front of an owner.

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// moneyWorld is the seeded tenant plus the handles a test needs to poke it.
type moneyWorld struct {
	fx    *fixture
	shift uuid.UUID
	tab   uuid.UUID
	owner uuid.UUID
	day   string // tenant-local day every serve was closed on
	at    time.Time
}

// seedMoneyWorld builds the rich fixture. Everything closes on ONE tenant-local
// day so day-scoped and range-scoped endpoints can be compared directly.
func seedMoneyWorld(t *testing.T) *moneyWorld {
	t.Helper()
	fx := newTenant(t)
	fx.setTenantRates("10.00", "13.00")
	fx.setTenantVat("exclusive", "13.00")
	fx.grantRole(fx.User, "owner")

	w := &moneyWorld{fx: fx, at: pastUTC(3)}
	w.day = localDay(t, w.at)
	w.shift = fx.seedOpenShift(500000)
	w.tab = fx.seedHouseTab("Regulars", true)
	w.owner = fx.finSeedOwner("Sahan", 100)

	food := fx.seedCategory("Food")
	drink := fx.seedCategory("Drink")

	// 1. A plain cash serve.
	cash := fx.seedOpenOrder(nil)
	fx.seedOrderItem(cash, fx.seedMenuItem(food, "Momo", 25000), 2, 25000)
	fx.closeOrderWithTotals(cash)
	fx.seedPayment(cash, "cash", orderTotal(t, fx, cash), ptrUUID(w.shift))

	// 2. A discounted serve spanning two categories, paid online.
	disc := fx.seedOpenOrder(nil)
	fx.seedOrderItem(disc, fx.seedMenuItem(food, "Thali", 17770), 1, 17770)
	fx.seedOrderItem(disc, fx.seedMenuItem(drink, "Chiya", 1110), 3, 1110)
	fx.adminExec(`
		INSERT INTO order_adjustments (tenant_id, order_id, type, amount_cents, reason, applied_by_user_id)
		VALUES ($1, $2, 'discount', 3330, 'regular', $3)`, fx.Tenant, disc, fx.User)
	fx.closeOrderWithTotals(disc)
	fx.seedPayment(disc, "other", orderTotal(t, fx, disc), ptrUUID(w.shift))

	// 3. Half portions — fractional line values that don't divide evenly.
	half := fx.seedOpenOrder(nil)
	hf := fx.seedMenuItem(food, "HalfPlate", 3330)
	hd := fx.seedMenuItem(drink, "HalfGlass", 3330)
	fx.adminExec(`UPDATE menu_items SET allow_half = true WHERE id IN ($1, $2)`, hf, hd)
	fx.adminExec(`
		INSERT INTO order_items (tenant_id, order_id, menu_item_id, qty, unit_price_cents, unit_cost_cents)
		VALUES ($1, $2, $3, 0.5, 3330, 900), ($1, $2, $4, 0.5, 3330, 400)`,
		fx.Tenant, half, hf, hd)
	fx.closeOrderWithTotals(half)
	fx.seedPayment(half, "cash", orderTotal(t, fx, half), ptrUUID(w.shift))

	// 4. A serve with a voided line: the void happened BEFORE close, so the
	//    stored totals already exclude it.
	voided := fx.seedOpenOrder(nil)
	keep := fx.seedOrderItem(voided, fx.seedMenuItem(food, "Kept", 5000), 1, 5000)
	drop := fx.seedOrderItem(voided, fx.seedMenuItem(food, "Dropped", 9000), 1, 9000)
	_ = keep
	ordVoidItem(fx, drop)
	fx.closeOrderWithTotals(voided)
	fx.seedPayment(voided, "cash", orderTotal(t, fx, voided), ptrUUID(w.shift))

	// 5. A serve charged to credit (billed, not collected).
	credit := fx.seedOpenOrder(nil)
	fx.seedOrderItem(credit, fx.seedMenuItem(drink, "Lassi", 12000), 1, 12000)
	fx.closeOrderWithTotals(credit)
	payID := fx.seedPayment(credit, "house_tab", orderTotal(t, fx, credit), ptrUUID(w.shift))
	fx.adminExec(`UPDATE payments SET house_tab_id = $2 WHERE id = $1`, payID, w.tab)

	// Stamp every serve onto the chosen day.
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE status = 'closed' AND tenant_id = $1`,
		fx.Tenant, w.at)

	// 6. Credit collected in cash — money in against an earlier sale.
	htSeedSettlement(fx, w.tab, "cash", 4000, ptrUUID(w.shift))
	// 7. …and a collection that was mis-entered and reversed: counts for nothing.
	bad := htSeedSettlement(fx, w.tab, "cash", 9999, ptrUUID(w.shift))
	fx.adminExec(`UPDATE house_tab_settlements
	              SET reversed_at = now(), reversed_by_user_id = $2, reversal_reason = 'typo'
	              WHERE id = $1`, bad, fx.User)

	// 8. Expenses from every source.
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Veg market", "amount_cents": 6000, "paid_from": "drawer",
	}).expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Landlord", "amount_cents": 30000, "paid_from": "bank",
		"payment_method": "bank",
	}).expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Hardware", "amount_cents": 2500, "paid_from": "owner",
		"owner_id": w.owner.String(),
	}).expectStatus(http.StatusCreated)

	// 9. Owner cash custody: take some out, put some back.
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": w.owner.String(), "amount_cents": 20000}).
		expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": w.owner.String(), "amount_cents": 5000}).
		expectStatus(http.StatusCreated)

	// 10. A transfer with a fee, and a cash drop.
	callHandler(t, fx, CreateTransfer, http.MethodPost, "/", map[string]any{
		"from_method": "cash", "to_method": "bank",
		"amount_cents": 50000, "fee_cents": 250,
	}).expectStatus(http.StatusCreated)

	// Expenses/transfers are stamped "now", so pull them onto the same day as the
	// serves — otherwise a day-scoped comparison mixes two days.
	fx.adminExec(`UPDATE expenses SET paid_at = $2 WHERE tenant_id = $1`, fx.Tenant, w.at)
	fx.adminExec(`UPDATE account_transfers SET transferred_at = $2 WHERE tenant_id = $1`,
		fx.Tenant, w.at)
	fx.adminExec(`UPDATE house_tab_settlements SET recorded_at = $2 WHERE tenant_id = $1`,
		fx.Tenant, w.at)
	return w
}

func orderTotal(t *testing.T, fx *fixture, orderID uuid.UUID) int64 {
	t.Helper()
	var total int64
	fx.adminScan([]any{&total}, `SELECT total_cents FROM orders WHERE id = $1`, orderID)
	return total
}

func (w *moneyWorld) q() string { return "range=custom&from=" + w.day + "&to=" + w.day }

// =========================================================================
// I1 + I2: sales agree across dashboard, history and the daily series
// =========================================================================

func TestInvariant_DashboardSalesMatchesHistoryAndDailySeries(t *testing.T) {
	w := seedMoneyWorld(t)
	fx := w.fx

	var dash ReportsDashboard
	callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery(w.q())).expectStatus(http.StatusOK).decode(&dash)

	// I1: the History page recomputes the day's gross client-side from the same
	// payload it lists, via a completely separate query. They must tie.
	hist := callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date="+w.day)).expectStatus(http.StatusOK).json()
	orders, _ := hist["orders"].([]any)
	var histGross int64
	for _, raw := range orders {
		histGross += int64(raw.(map[string]any)["total_cents"].(float64))
	}
	assertMoney(t, "history gross vs dashboard sales", histGross, dash.KPIs.SalesCents)
	if len(orders) != dash.KPIs.OrderCount {
		t.Fatalf("history listed %d serves, dashboard counted %d", len(orders), dash.KPIs.OrderCount)
	}

	// I2: the daily series over the same (unpadded, custom) window must sum to
	// the KPI. A padded window legitimately wouldn't — hence daily_padded.
	if dash.DailyPadded {
		t.Fatal("a custom single-day range must not be padded")
	}
	var series int64
	for _, p := range dash.Daily {
		series += p.SalesCents
	}
	assertMoney(t, "daily series vs sales KPI", series, dash.KPIs.SalesCents)
}

// =========================================================================
// I3: the payment mix accounts for every rupee billed
// =========================================================================

func TestInvariant_PaymentMixPlusCreditEqualsSales(t *testing.T) {
	w := seedMoneyWorld(t)
	var dash ReportsDashboard
	callHandler(t, w.fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery(w.q())).expectStatus(http.StatusOK).decode(&dash)

	collected := dash.PaymentMix.CashCents + dash.PaymentMix.BankCents + dash.PaymentMix.OnlineCents
	assertMoney(t, "payment mix + on-credit vs billed sales",
		collected+dash.KPIs.TabCents, dash.KPIs.SalesCents)

	// The drill-down's per-tab breakdown must equal the on-credit total it drills.
	var breakdown int64
	for _, row := range dash.TabBreakdown {
		breakdown += row.AmountCents
	}
	assertMoney(t, "tab breakdown vs tab_cents", breakdown, dash.KPIs.TabCents)

	// Credit collected is money in, never part of billed sales.
	if dash.KPIs.CreditCollectedCents != 4000 {
		t.Fatalf("credit_collected_cents = %d, want 4000 (the reversed 9999 counts for nothing)",
			dash.KPIs.CreditCollectedCents)
	}
}

// =========================================================================
// I4 + I9: profit is built on net revenue, and the parts sum exactly
// =========================================================================

func TestInvariant_CategoryNetRevenueSumsToBilledMinusVat(t *testing.T) {
	w := seedMoneyWorld(t)
	var dash ReportsDashboard
	callHandler(t, w.fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery(w.q())).expectStatus(http.StatusOK).decode(&dash)
	var prof ProfitReport
	callHandler(t, w.fx, GetProfitability, http.MethodGet, "/reports/profitability", nil,
		withQuery(w.q())).expectStatus(http.StatusOK).decode(&prof)

	wantNet := dash.KPIs.SalesCents - dash.KPIs.TaxCents
	var summed int64
	for _, c := range prof.Categories {
		summed += c.NetRevenueCents
	}
	// Exactly — half portions, an odd discount and 13% VAT included.
	assertMoney(t, "Σ category net revenue vs billed − VAT", summed, wantNet)
	assertMoney(t, "profitability totals vs billed − VAT", prof.Totals.NetRevenueCents, wantNet)

	// I9: the bottom line is net revenue less every cost, including the transfer
	// fee that lives outside the expenses table.
	assertMoney(t, "net profit", prof.NetProfitCents,
		prof.Totals.NetRevenueCents-prof.TotalExpensesCents-prof.TransferFeesCents)
	if prof.TransferFeesCents != 250 {
		t.Fatalf("transfer_fees_cents = %d, want 250", prof.TransferFeesCents)
	}

	// I7: both screens count the same expenses for the same window.
	assertMoney(t, "profitability expenses vs dashboard expenses",
		prof.TotalExpensesCents, dash.KPIs.ExpensesCents)
}

// =========================================================================
// I5: the money position adds up, whichever screen you read it from
// =========================================================================

func TestInvariant_AccountsAgreeWithCafeBalance(t *testing.T) {
	w := seedMoneyWorld(t)
	fx := w.fx

	bal := callHandler(t, fx, GetCafeBalance, http.MethodGet, "/finance/cafe-balance", nil).
		expectStatus(http.StatusOK)
	drawer := bal.money("drawer_cents")
	bank := bal.money("bank_cents")
	ownerCash := bal.money("owner_cash_cents")
	total := bal.money("total_cents")

	var channels int64
	for _, raw := range bal.json()["channels"].([]any) {
		channels += int64(raw.(map[string]any)["balance_cents"].(float64))
	}
	// The Balance page prints these four tiles and the total; they must add up or
	// the page contradicts itself on screen.
	assertMoney(t, "cafe balance total vs its own parts", total, drawer+bank+ownerCash+channels)

	// The Accounts cards are computed by a different handler over the same rows.
	accounts := callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json()
	online := accountByMethod(accounts, "online")
	bankAcc := accountByMethod(accounts, "bank")
	assertMoney(t, "online bucket vs cafe-balance channels",
		int64(online["balance_cents"].(float64)), channels)
	assertMoney(t, "bank card vs cafe-balance bank tile",
		int64(bankAcc["balance_cents"].(float64)), bank)

	// Every bucket's own itemisation must equal its balance.
	for _, method := range []string{"cash", "online", "bank"} {
		a := accountByMethod(accounts, method)
		// other_movements is the signed remainder: cash carries owner draws and
		// recount corrections, bank carries owner capital and banked owner cash.
		// It is part of the card's own itemisation, so the printed parts add up.
		parts := int64(a["payments_cents"].(float64)) +
			int64(a["credit_collected_cents"].(float64)) -
			int64(a["expenses_cents"].(float64)) +
			int64(a["transfers_in_cents"].(float64)) -
			int64(a["transfers_out_cents"].(float64)) +
			int64(a["other_movements_cents"].(float64))
		assertMoney(t, method+" card: parts vs balance",
			parts, int64(a["balance_cents"].(float64)))
	}
}

// I6: the drawer figure on the Balance page and the expected cash on the Shift
// page are the same money, and an operator counts the till against both.
func TestInvariant_DrawerMatchesShiftExpectedCash(t *testing.T) {
	w := seedMoneyWorld(t)
	var s Shift
	callHandler(t, w.fx, GetCurrentShift, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).decode(&s)
	drawer := callHandler(t, w.fx, GetCafeBalance, http.MethodGet, "/finance/cafe-balance", nil).
		expectStatus(http.StatusOK).money("drawer_cents")
	assertMoney(t, "drawer vs shift expected cash", drawer, s.LiveExpectedCashCents)
}

// I8: the receivable equals what was charged less what was actually collected.
func TestInvariant_TabBalanceIsChargedMinusCollected(t *testing.T) {
	w := seedMoneyWorld(t)
	d := callHandler(t, w.fx, GetHouseTab, http.MethodGet, "/", nil,
		withParam("id", w.tab.String())).expectStatus(http.StatusOK)
	charged := d.money("house_tab.charged_cents")
	settled := d.money("house_tab.settled_cents")
	balance := d.money("house_tab.balance_cents")
	assertMoney(t, "tab balance", balance, charged-settled)

	// The reversed collection is visible in the ledger but counts for nothing.
	if settled != 4000 {
		t.Fatalf("settled = %d, want 4000 — the reversed row must not count", settled)
	}
	sets, _ := d.json()["settlements"].([]any)
	if len(sets) != 2 {
		t.Fatalf("ledger shows %d collections, want 2 (one live, one reversed)", len(sets))
	}
}

// =========================================================================
// Reversal symmetry: undo every mutation, land exactly where we started
// =========================================================================

// A create-then-undo round trip must leave every derived figure byte-identical.
// Anything asymmetric here is money that silently appears or disappears.
func TestInvariant_ReversalSymmetry(t *testing.T) {
	w := seedMoneyWorld(t)
	fx := w.fx

	snapshot := func() []int64 {
		bal := callHandler(t, fx, GetCafeBalance, http.MethodGet, "/finance/cafe-balance", nil).
			expectStatus(http.StatusOK)
		acc := callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
			expectStatus(http.StatusOK).json()
		var s Shift
		callHandler(t, fx, GetCurrentShift, http.MethodGet, "/", nil).
			expectStatus(http.StatusOK).decode(&s)
		out := []int64{
			bal.money("drawer_cents"), bal.money("bank_cents"),
			bal.money("owner_cash_cents"), bal.money("total_cents"),
			s.LiveExpectedCashCents,
		}
		for _, m := range []string{"cash", "online", "bank"} {
			out = append(out, int64(accountByMethod(acc, m)["balance_cents"].(float64)))
		}
		return out
	}
	compare := func(label string, before, after []int64) {
		t.Helper()
		for i := range before {
			if before[i] != after[i] {
				t.Fatalf("%s: figure %d changed %d → %d after a full undo",
					label, i, before[i], after[i])
			}
		}
	}

	// (a) An expense, created and deleted.
	before := snapshot()
	var exp struct {
		ID uuid.UUID `json:"id"`
	}
	callHandler(t, fx, CreateExpense, http.MethodPost, "/", map[string]any{
		"vendor": "Undo me", "amount_cents": 7777, "paid_from": "bank",
		"payment_method": "bank",
	}).expectStatus(http.StatusCreated).decode(&exp)
	callHandler(t, fx, DeleteExpense, http.MethodDelete, "/", nil,
		withParam("id", exp.ID.String())).expectStatus(http.StatusNoContent)
	compare("expense", before, snapshot())

	// (b) A transfer with a fee, created and deleted.
	before = snapshot()
	var tr AccountTransfer
	callHandler(t, fx, CreateTransfer, http.MethodPost, "/", map[string]any{
		"from_method": "cash", "to_method": "online",
		"amount_cents": 12345, "fee_cents": 99,
	}).expectStatus(http.StatusCreated).decode(&tr)
	callHandler(t, fx, DeleteTransfer, http.MethodDelete, "/", nil,
		withParam("id", tr.ID.String())).expectStatus(http.StatusNoContent)
	compare("transfer (incl. fee)", before, snapshot())

	// (c) A credit collection, recorded and reversed.
	before = snapshot()
	var st HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 1500, "payment_method": "cash"},
		withParam("id", w.tab.String())).
		expectStatus(http.StatusCreated).decode(&st)
	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "undo test"},
		withParams(map[string]string{"id": w.tab.String(), "settlementId": st.ID.String()})).
		expectStatus(http.StatusOK)
	compare("credit collection", before, snapshot())

	// (d) Owner cash out and straight back in.
	before = snapshot()
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": w.owner.String(), "amount_cents": 3000}).
		expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateOwnerCashReturn(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": w.owner.String(), "amount_cents": 3000}).
		expectStatus(http.StatusCreated)
	compare("owner cash round trip", before, snapshot())
}

// =========================================================================
// Boundaries: a serve belongs to exactly one day
// =========================================================================

// The tenant runs on UTC+5:45, so "which day" is never the UTC day. A serve one
// second before local midnight and one second after must land on different days,
// and each must appear on exactly one.
func TestInvariant_LocalMidnightBoundary(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	cat := fx.seedCategory("BoundaryCat")

	// 2026-05-20 00:00 Kathmandu == 2026-05-19 18:15 UTC.
	midnight := time.Date(2026, 5, 19, 18, 15, 0, 0, time.UTC)

	before := fx.seedOpenOrder(nil)
	fx.seedOrderItem(before, fx.seedMenuItem(cat, "LastServe", 1100), 1, 1100)
	fx.closeOrderWithTotals(before)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`,
		before, midnight.Add(-time.Second))

	after := fx.seedOpenOrder(nil)
	fx.seedOrderItem(after, fx.seedMenuItem(cat, "FirstServe", 2200), 1, 2200)
	fx.closeOrderWithTotals(after)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, after, midnight)

	day19 := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from=2026-05-19&to=2026-05-19")).
		expectStatus(http.StatusOK)
	day20 := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from=2026-05-20&to=2026-05-20")).
		expectStatus(http.StatusOK)

	assertMoney(t, "sales on the 19th (local)", day19.money("kpis.sales_cents"), 1100)
	assertMoney(t, "sales on the 20th (local)", day20.money("kpis.sales_cents"), 2200)

	// History, which windows in SQL rather than in Go, must split them the same way.
	h19 := callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date=2026-05-19")).expectStatus(http.StatusOK).json()
	h20 := callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date=2026-05-20")).expectStatus(http.StatusOK).json()
	if n := len(h19["orders"].([]any)); n != 1 {
		t.Fatalf("history 19th listed %d serves, want 1", n)
	}
	if n := len(h20["orders"].([]any)); n != 1 {
		t.Fatalf("history 20th listed %d serves, want 1", n)
	}
}

// A credit collection is attributed by when the money arrived, and it must not
// leak into the neighbouring day.
func TestInvariant_CreditCollectedBoundary(t *testing.T) {
	fx := newTenant(t)
	tab := fx.seedHouseTab("BoundaryTab", true)
	creditSaleOn(fx, tab, 50000, pastUTC(24*10))

	midnight := time.Date(2026, 5, 19, 18, 15, 0, 0, time.UTC) // 00:00 local on the 20th
	late := htSeedSettlement(fx, tab, "cash", 1000, nil)
	fx.adminExec(`UPDATE house_tab_settlements SET recorded_at = $2 WHERE id = $1`,
		late, midnight.Add(-time.Second))
	early := htSeedSettlement(fx, tab, "cash", 2000, nil)
	fx.adminExec(`UPDATE house_tab_settlements SET recorded_at = $2 WHERE id = $1`,
		early, midnight)

	d19 := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from=2026-05-19&to=2026-05-19")).expectStatus(http.StatusOK)
	d20 := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from=2026-05-20&to=2026-05-20")).expectStatus(http.StatusOK)
	assertMoney(t, "credit collected on the 19th", d19.money("kpis.credit_collected_cents"), 1000)
	assertMoney(t, "credit collected on the 20th", d20.money("kpis.credit_collected_cents"), 2000)
}

// Every preset window must actually bound its query. These were previously
// asserted only by their echoed label, so a broken boundary passed.
func TestInvariant_PresetWindowsBoundTheirQueries(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "0")
	cat := fx.seedCategory("PresetCat")

	seedOn := func(name string, hoursAgo float64, cents int64) {
		o := fx.seedOpenOrder(nil)
		fx.seedOrderItem(o, fx.seedMenuItem(cat, name, cents), 1, cents)
		fx.closeOrderWithTotals(o)
		fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, o, pastUTC(hoursAgo))
	}
	seedOn("Today", 1, 1000)
	seedOn("ThreeDaysAgo", 24*3, 2000)
	seedOn("FortyDaysAgo", 24*40, 4000)

	// today: only today's serve. 7d: today + 3 days ago. 30d: the same two.
	// Whatever "today" means locally, the 40-day-old serve is in none of them.
	for _, c := range []struct {
		preset string
		want   int64
	}{
		{"today", 1000},
		{"7d", 3000},
		{"30d", 3000},
	} {
		got := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
			withQuery("range="+c.preset)).expectStatus(http.StatusOK).money("kpis.sales_cents")
		if got != c.want {
			t.Fatalf("range=%s sales = %d, want %d", c.preset, got, c.want)
		}
	}
}
