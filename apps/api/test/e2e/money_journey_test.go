package e2e

// A day's trading, over HTTP, with the arithmetic asserted at every step.
//
// The handler tests prove each endpoint computes what it claims. These prove the
// endpoints AGREE — that the figure an owner reads on the Dashboard is the same
// money the History page lists, the Accounts page holds and the shift close
// signs off on. That agreement is the thing the accuracy audit was about, and it
// can only be checked by walking the whole flow the way the app does.
//
// Every journey ends with f.assertClean(): the live invariant checker
// (platform_accuracy_check) must find nothing wrong with the rows the API just
// wrote. A handler that leaves the books inconsistent fails here even if its own
// unit test passes.

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

// cafe is a fixture plus the catalogue a money test needs.
type cafe struct {
	*fixture
	Table  string // service table id
	Coffee string // 25000, cost 8000
	Cake   string // 6000, cost 2500
	Half   string // 30000, cost 11000, allow_half
}

func newCafe(t *testing.T) *cafe {
	f := newFixture(t)
	drinks := f.category("Drinks")
	food := f.category("Food")
	return &cafe{
		fixture: f,
		Table:   f.table("T1").String(),
		Coffee:  f.item(drinks, "Latte", 25000, 8000, false).String(),
		Cake:    f.item(food, "Carrot Cake", 6000, 2500, false).String(),
		Half:    f.item(food, "Thali", 30000, 11000, true).String(),
	}
}

// openShift opens a shift as the manager and returns its id.
func (c *cafe) openShift(floatCents int64) string {
	c.t.Helper()
	var out struct{ ID string }
	c.Manager.post("/v1/shifts/open", map[string]any{"opening_float_cents": floatCents}).
		expect(http.StatusCreated).decode(&out)
	return out.ID
}

// openOrder opens a tab on the table as the waiter.
func (c *cafe) openOrder() string {
	c.t.Helper()
	var out struct{ ID string }
	c.Waiter.post("/v1/orders", map[string]any{"service_table_id": c.Table}).
		expect(http.StatusCreated).decode(&out)
	return out.ID
}

func (c *cafe) addItem(orderID, itemID string, qty float64) {
	c.t.Helper()
	c.Waiter.post("/v1/orders/"+orderID+"/items", map[string]any{
		"items": []map[string]any{{"menu_item_id": itemID, "qty": qty}},
	}).expect(http.StatusCreated)
}

// quote reads the settle quote — the arithmetic the FE shows before taking money.
func (c *cafe) quote(orderID string) closeQuote {
	c.t.Helper()
	var q closeQuote
	c.Waiter.get("/v1/orders/" + orderID + "/quote").expect(http.StatusOK).decode(&q)
	return q
}

type closeQuote struct {
	SubtotalCents      int64  `json:"subtotal_cents"`
	DiscountCents      int64  `json:"discount_cents"`
	ServiceChargeCents int64  `json:"service_charge_cents"`
	TaxCents           int64  `json:"tax_cents"`
	TotalCents         int64  `json:"total_cents"`
	PaidCents          int64  `json:"paid_cents"`
	BalanceCents       int64  `json:"balance_cents"`
	VatMode            string `json:"vat_mode"`
}

func (c *cafe) pay(orderID, method string, amount int64, tabID string) {
	c.t.Helper()
	body := map[string]any{"method": method, "amount_cents": amount}
	if tabID != "" {
		body["house_tab_id"] = tabID
	}
	// The manager takes the money: the default waiter role deliberately has no
	// payment:record (see internal/rbac/permissions.json).
	c.Manager.post("/v1/orders/"+orderID+"/payments", body).expect(http.StatusCreated)
}

func (c *cafe) closeOrder(orderID string) {
	c.t.Helper()
	c.Manager.post("/v1/orders/"+orderID+"/close", nil).expect(http.StatusOK)
}

func (c *cafe) creditAccount(name string) string {
	c.t.Helper()
	var out struct{ ID string }
	c.Manager.post("/v1/house-tabs", map[string]any{"name": name}).
		expect(http.StatusCreated).decode(&out)
	return out.ID
}

// =========================================================================
// The journey
// =========================================================================

// One order, part cash and part on credit, settled a "week later" — the exact
// scenario reported as double-counted sales. Sales must be recognised once, at
// the close, and the collection must move money without touching sales.
func TestJourney_CreditSaleIsRecognisedOnceAndCollectedLater(t *testing.T) {
	c := newCafe(t)
	day := localDay(t, time.Now())
	shift := c.openShift(500000) // Rs 5,000 float

	// --- Sell -------------------------------------------------------------
	order := c.openOrder()
	c.addItem(order, c.Coffee, 2) // 50,000
	c.addItem(order, c.Cake, 1)   //  6,000
	c.Manager.post("/v1/orders/"+order+"/adjustments", map[string]any{
		"type": "discount", "amount_cents": 5000, "reason": "regular",
	}).expect(http.StatusCreated)

	// The quote is what the cashier is shown, so assert it explicitly rather than
	// deriving expectations from it. exclusive VAT 13%, service 10%:
	//   subtotal                          = 56,000
	//   service  10% of the SUBTOTAL       =  5,600  (buildQuote charges service
	//                                                 before the discount)
	//   base     56,000 − 5,000 + 5,600    = 56,600
	//   VAT      13% of 56,600             =  7,358
	//   total                              = 63,958
	q := c.quote(order)
	assertMoney(t, "subtotal", q.SubtotalCents, 56000)
	assertMoney(t, "discount", q.DiscountCents, 5000)
	assertMoney(t, "service charge", q.ServiceChargeCents, 5600)
	assertMoney(t, "VAT", q.TaxCents, 7358)
	assertMoney(t, "total", q.TotalCents, 63958)
	if q.VatMode != "exclusive" {
		t.Fatalf("vat_mode = %q, want exclusive", q.VatMode)
	}

	// Half cash, the rest on credit.
	tab := c.creditAccount("Ram (staff)")
	const cash = int64(30000)
	credit := q.TotalCents - cash
	c.pay(order, "cash", cash, "")
	c.pay(order, "house_tab", credit, tab)
	c.closeOrder(order)

	netRevenue := q.TotalCents - q.TaxCents // the one true basis

	// --- What the owner sees on the day ----------------------------------
	dash := c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK)
	assertMoney(t, "dashboard sales", dash.money("kpis.sales_cents"), q.TotalCents)
	assertMoney(t, "dashboard on credit", dash.money("kpis.tab_cents"), credit)
	assertMoney(t, "dashboard credit collected", dash.money("kpis.credit_collected_cents"), 0)
	assertMoney(t, "dashboard VAT", dash.money("kpis.tax_cents"), q.TaxCents)
	assertMoney(t, "dashboard discount", dash.money("kpis.discount_cents"), 5000)
	assertMoney(t, "payment mix cash", dash.money("payment_mix.cash_cents"), cash)
	assertMoney(t, "payment mix online", dash.money("payment_mix.online_cents"), 0)

	// The payment mix plus what went on credit must account for every rupee of
	// sales — no channel may go missing.
	mix := dash.money("payment_mix.cash_cents") + dash.money("payment_mix.bank_cents") +
		dash.money("payment_mix.online_cents") + dash.money("kpis.tab_cents")
	assertMoney(t, "payment mix + credit vs sales", mix, q.TotalCents)

	// History for the same day must list the same money.
	hist := c.Owner.get("/v1/orders/history?date=" + day).expect(http.StatusOK)
	var histBody struct {
		Orders []struct {
			TotalCents int64 `json:"total_cents"`
			TaxCents   int64 `json:"tax_cents"`
			Payments   []struct {
				Method      string `json:"method"`
				AmountCents int64  `json:"amount_cents"`
			} `json:"payments"`
		} `json:"orders"`
		CreditCollections []struct {
			AmountCents int64 `json:"amount_cents"`
		} `json:"credit_collections"`
	}
	hist.decode(&histBody)
	var histSales, histPaid int64
	for _, o := range histBody.Orders {
		histSales += o.TotalCents
		for _, p := range o.Payments {
			histPaid += p.AmountCents
		}
	}
	assertMoney(t, "history sales vs dashboard", histSales, q.TotalCents)
	assertMoney(t, "history payments vs total", histPaid, q.TotalCents)
	if len(histBody.CreditCollections) != 0 {
		t.Fatalf("history shows %d credit collections before any were taken",
			len(histBody.CreditCollections))
	}

	// The credit account carries the receivable.
	assertMoney(t, "credit outstanding",
		c.Owner.get("/v1/house-tabs/"+tab).expect(http.StatusOK).money("house_tab.balance_cents"), credit)

	// Cash position: float + the cash actually taken.
	bal := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
	assertMoney(t, "drawer", bal.money("drawer_cents"), 500000+cash)

	// Net revenue is what profitability reports — sales minus the VAT the cafe
	// is only holding.
	prof := c.Owner.get("/v1/reports/profitability?range=today").expect(http.StatusOK)
	assertMoney(t, "profitability net revenue", prof.money("totals.net_revenue_cents"), netRevenue)
	assertMoney(t, "profitability billed sales", prof.money("billed_sales_cents"), q.TotalCents)
	assertMoney(t, "profitability VAT", prof.money("vat_cents"), q.TaxCents)

	// --- A week later: the customer pays -------------------------------
	// This is the reported bug. Collecting credit must not create sales.
	var settlement struct{ ID string }
	c.Manager.post("/v1/house-tabs/"+tab+"/settlements", map[string]any{
		"amount_cents": credit, "payment_method": "cash", "notes": "settled in full",
	}).expect(http.StatusCreated).decode(&settlement)

	dash2 := c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK)
	assertMoney(t, "sales after collecting credit (must not change)",
		dash2.money("kpis.sales_cents"), q.TotalCents)
	assertMoney(t, "credit collected", dash2.money("kpis.credit_collected_cents"), credit)
	assertMoney(t, "on credit (unchanged: it records the day's charges)",
		dash2.money("kpis.tab_cents"), credit)
	assertMoney(t, "credit outstanding after collection",
		c.Owner.get("/v1/house-tabs/"+tab).expect(http.StatusOK).money("house_tab.balance_cents"), 0)

	// The money did arrive, though: the drawer grew by exactly the collection.
	bal2 := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
	assertMoney(t, "drawer after collection", bal2.money("drawer_cents"), 500000+cash+credit)

	// And the cash account reports it as a collection, not as sales.
	cashAcct := c.accountByMethod("cash")
	assertMoney(t, "cash account payments (sales share)", cashAcct.PaymentsCents, cash)
	assertMoney(t, "cash account credit collected", cashAcct.CreditCollectedCents, credit)

	// --- The manager entered it on the wrong day: reverse it -------------
	c.Manager.post("/v1/house-tabs/"+tab+"/settlements/"+settlement.ID+"/reverse",
		map[string]any{"reason": "entered against the wrong tab"}).expect(http.StatusOK)

	dash3 := c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK)
	assertMoney(t, "sales after reversal", dash3.money("kpis.sales_cents"), q.TotalCents)
	assertMoney(t, "credit collected after reversal", dash3.money("kpis.credit_collected_cents"), 0)
	assertMoney(t, "credit outstanding after reversal",
		c.Owner.get("/v1/house-tabs/"+tab).expect(http.StatusOK).money("house_tab.balance_cents"), credit)
	assertMoney(t, "drawer after reversal",
		c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK).money("drawer_cents"),
		500000+cash)

	// --- Close the shift -------------------------------------------------
	// Expected cash = float + cash taken. Count it exactly: variance 0.
	live := c.Manager.get("/v1/shifts/current").expect(http.StatusOK)
	assertMoney(t, "live expected cash", live.money("live_expected_cash_cents"), 500000+cash)

	var closed struct {
		ExpectedCashCents int64 `json:"expected_cash_cents"`
		VarianceCents     int64 `json:"variance_cents"`
	}
	c.Manager.post("/v1/shifts/"+shift+"/close", map[string]any{
		"closing_count_cents": 500000 + cash,
	}).expect(http.StatusOK).decode(&closed)
	assertMoney(t, "stamped expected cash", closed.ExpectedCashCents, 500000+cash)
	assertMoney(t, "variance", closed.VarianceCents, 0)

	c.assertClean()
}

// Cash short at close must be recorded as a variance, not absorbed — and the
// stamped figures must survive the invariant checker.
func TestJourney_ShortDrawerRecordsAVariance(t *testing.T) {
	c := newCafe(t)
	shift := c.openShift(200000)

	order := c.openOrder()
	c.addItem(order, c.Cake, 2)
	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")
	c.closeOrder(order)

	expected := 200000 + q.TotalCents
	var closed struct {
		ExpectedCashCents int64 `json:"expected_cash_cents"`
		VarianceCents     int64 `json:"variance_cents"`
	}
	c.Manager.post("/v1/shifts/"+shift+"/close", map[string]any{
		"closing_count_cents": expected - 2500, // Rs 25 short
	}).expect(http.StatusOK).decode(&closed)

	assertMoney(t, "expected cash", closed.ExpectedCashCents, expected)
	assertMoney(t, "variance", closed.VarianceCents, -2500)
	c.assertClean()
}

// The same identities must hold in every VAT mode. Inclusive VAT is where the
// old item-basis revenue diverged most, so this is the regression that matters.
func TestJourney_NetRevenueIdentityHoldsInEveryVatMode(t *testing.T) {
	for _, tc := range []struct {
		mode       string
		vatPct     float64
		servicePct float64
	}{
		{"none", 0, 0},
		{"none", 0, 10},
		{"inclusive", 13, 10},
		{"exclusive", 13, 0},
		{"exclusive", 13, 10},
	} {
		name := fmt.Sprintf("%s_vat%.0f_service%.0f", tc.mode, tc.vatPct, tc.servicePct)
		t.Run(name, func(t *testing.T) {
			c := newCafe(t)
			c.vatMode(tc.mode, tc.vatPct, tc.servicePct)
			c.openShift(100000)

			order := c.openOrder()
			c.addItem(order, c.Coffee, 3)
			c.addItem(order, c.Half, 0.5) // half portion: fractional paisa
			c.addItem(order, c.Cake, 1)
			c.Manager.post("/v1/orders/"+order+"/adjustments", map[string]any{
				"type": "discount", "amount_cents": 3333, "reason": "odd amount, on purpose",
			}).expect(http.StatusCreated)

			q := c.quote(order)
			c.pay(order, "cash", q.TotalCents, "")
			c.closeOrder(order)

			// Mode contract: total always contains the VAT, in every mode.
			if tc.mode == "none" && q.TaxCents != 0 {
				t.Fatalf("vat_mode none charged %d VAT", q.TaxCents)
			}
			net := q.TotalCents - q.TaxCents

			prof := c.Owner.get("/v1/reports/profitability?range=today").expect(http.StatusOK)
			assertMoney(t, "net revenue", prof.money("totals.net_revenue_cents"), net)
			assertMoney(t, "billed sales", prof.money("billed_sales_cents"), q.TotalCents)

			// The category breakdown must sum EXACTLY to the total — this is
			// what largest-remainder allocation buys, and half portions are
			// where naive per-line rounding drifts.
			var body struct {
				Categories []struct {
					NetRevenueCents int64 `json:"net_revenue_cents"`
					CogsCents       int64 `json:"cogs_cents"`
				} `json:"categories"`
				Totals struct {
					NetRevenueCents int64 `json:"net_revenue_cents"`
					CogsCents       int64 `json:"cogs_cents"`
				} `json:"totals"`
			}
			prof.decode(&body)
			var sumNet, sumCogs int64
			for _, row := range body.Categories {
				sumNet += row.NetRevenueCents
				sumCogs += row.CogsCents
			}
			assertMoney(t, "Σ category net revenue vs total", sumNet, body.Totals.NetRevenueCents)
			assertMoney(t, "Σ category COGS vs total", sumCogs, body.Totals.CogsCents)

			// Dashboard still reports billed sales (what the customer paid).
			assertMoney(t, "dashboard sales",
				c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK).
					money("kpis.sales_cents"), q.TotalCents)

			c.assertClean()
		})
	}
}

// Money out: an expense per source, each landing in the right bucket and none of
// them touching sales. paid_from='owner' is the one that used to debit an account
// that never moved.
func TestJourney_ExpensesLandInTheRightBucket(t *testing.T) {
	c := newCafe(t)
	c.openShift(400000)

	order := c.openOrder()
	c.addItem(order, c.Coffee, 4)
	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")
	c.closeOrder(order)

	var cat struct{ ID string }
	c.Manager.post("/v1/expense-categories", map[string]any{"name": "Supplies"}).
		expect(http.StatusCreated).decode(&cat)

	before := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
	drawerBefore := before.money("drawer_cents")
	totalBefore := before.money("total_cents")

	// Paid out of the till: the drawer drops.
	c.Manager.post("/v1/expenses", map[string]any{
		"expense_category_id": cat.ID, "amount_cents": 12000, "vendor": "Dairy",
		"payment_method": "cash", "paid_from": "drawer",
	}).expect(http.StatusCreated)

	after := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
	assertMoney(t, "drawer after a till expense", after.money("drawer_cents"), drawerBefore-12000)
	assertMoney(t, "cafe total after a till expense", after.money("total_cents"), totalBefore-12000)

	// The P&L sees it either way.
	assertMoney(t, "dashboard expenses",
		c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK).
			money("kpis.expenses_cents"), 12000)
	assertMoney(t, "profitability expenses",
		c.Owner.get("/v1/reports/profitability?range=today").expect(http.StatusOK).
			money("total_expenses_cents"), 12000)

	// Sales are untouched by spending.
	assertMoney(t, "sales after expenses",
		c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK).
			money("kpis.sales_cents"), q.TotalCents)

	c.assertClean()
}

// Deleting money must restore the books exactly. Anything that doesn't reverse
// cleanly is a slow leak that no single-endpoint test would notice.
func TestJourney_EveryMutationReversesExactly(t *testing.T) {
	c := newCafe(t)
	c.openShift(300000)

	order := c.openOrder()
	c.addItem(order, c.Coffee, 2)
	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")
	c.closeOrder(order)

	snapshot := func() (drawer, total, sales int64) {
		bal := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
		dash := c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK)
		return bal.money("drawer_cents"), bal.money("total_cents"), dash.money("kpis.sales_cents")
	}
	d0, t0, s0 := snapshot()

	var cat struct{ ID string }
	c.Manager.post("/v1/expense-categories", map[string]any{"name": "Reversible"}).
		expect(http.StatusCreated).decode(&cat)

	// An owner, so paid_from='owner' can be exercised too: an owner paying a cafe
	// bill from their own pocket must NOT move any cafe account (it becomes a loan
	// to the cafe), while still hitting the P&L.
	var owner struct{ ID string }
	c.Owner.post("/v1/finance/owners", map[string]any{
		"display_name": "Sita", "share_units": 100,
	}).expect(http.StatusCreated).decode(&owner)

	for _, src := range []struct {
		paidFrom, method string
		movesAccounts    bool
	}{
		{"drawer", "cash", true},
		{"bank", "bank", true},
		{"owner", "cash", false},
	} {
		t.Run("expense_from_"+src.paidFrom, func(t *testing.T) {
			body := map[string]any{
				"expense_category_id": cat.ID, "amount_cents": 9900, "vendor": "V",
				"payment_method": src.method, "paid_from": src.paidFrom,
			}
			if src.paidFrom == "owner" {
				body["owner_id"] = owner.ID
			}
			var exp struct{ ID string }
			c.Manager.post("/v1/expenses", body).expect(http.StatusCreated).decode(&exp)

			// While it exists, only cafe-funded expenses may move a cafe account.
			held := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
			if src.movesAccounts {
				if held.money("total_cents") == t0 {
					t.Fatalf("a %s-funded expense left the cafe balance unchanged", src.paidFrom)
				}
			} else {
				assertMoney(t, "cafe balance while an owner-funded expense stands",
					held.money("total_cents"), t0)
			}
			c.Manager.del("/v1/expenses/" + exp.ID).expect(http.StatusNoContent)

			d, tot, s := snapshot()
			assertMoney(t, "drawer after create+delete", d, d0)
			assertMoney(t, "cafe total after create+delete", tot, t0)
			assertMoney(t, "sales after create+delete", s, s0)
		})
	}

	// A transfer with a fee, then deleted.
	t.Run("transfer_with_fee", func(t *testing.T) {
		var tr struct{ ID string }
		c.Manager.post("/v1/transfers", map[string]any{
			"from_method": "cash", "to_method": "bank",
			"amount_cents": 50000, "fee_cents": 500, "notes": "deposit",
		}).expect(http.StatusCreated).decode(&tr)

		mid := c.Owner.get("/v1/finance/cafe-balance").expect(http.StatusOK)
		assertMoney(t, "drawer after transfer", mid.money("drawer_cents"), d0-50500)
		assertMoney(t, "bank after transfer", mid.money("bank_cents"), 50000)
		assertMoney(t, "cafe total after transfer (fee is a real cost)",
			mid.money("total_cents"), t0-500)

		c.Manager.del("/v1/transfers/" + tr.ID).expect(http.StatusNoContent)
		d, tot, s := snapshot()
		assertMoney(t, "drawer after transfer delete", d, d0)
		assertMoney(t, "cafe total after transfer delete", tot, t0)
		assertMoney(t, "sales after transfer delete", s, s0)
	})

	c.assertClean()
}

// accountByMethod reads one bucket off /v1/accounts/balances.
func (c *cafe) accountByMethod(method string) accountRow {
	c.t.Helper()
	var body struct{ Accounts []accountRow }
	c.Owner.get("/v1/accounts/balances").expect(http.StatusOK).decode(&body)
	for _, a := range body.Accounts {
		if a.Method == method {
			return a
		}
	}
	c.t.Fatalf("no %q account in /v1/accounts/balances", method)
	return accountRow{}
}

type accountRow struct {
	Method               string `json:"method"`
	BalanceCents         int64  `json:"balance_cents"`
	PaymentsCents        int64  `json:"payments_cents"`
	CreditCollectedCents int64  `json:"credit_collected_cents"`
	ExpensesCents        int64  `json:"expenses_cents"`
}
