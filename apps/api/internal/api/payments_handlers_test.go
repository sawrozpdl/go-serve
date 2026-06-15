package api

import (
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// pure helpers — pctOf / parsePctHundredths / formatPaisa
// =========================================================================

func TestParsePctHundredths(t *testing.T) {
	cases := map[string]int64{
		"":       0,
		"0":      0,
		"13":     1300,
		"13.00":  1300,
		"13.5":   1350,
		"13.50":  1350,
		"10.99":  1099,
		"  10  ": 1000, // trimmed
		"13.999": 1399, // truncated to 2 dp, not rounded
		"0.01":   1,
		"100":    10000,
		"abc":    0, // non-digit whole → 0
		"13.x":   0, // non-digit frac → 0
		"1.2.3":  0, // second dot lands in frac, non-digit → 0
		"-5":     0, // '-' is non-digit → 0
	}
	for in, want := range cases {
		if got := parsePctHundredths(in); got != want {
			t.Errorf("parsePctHundredths(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestPctOf(t *testing.T) {
	cases := []struct {
		amount int64
		pct    string
		want   int64
	}{
		{10000, "13", 1300},
		{10000, "0", 0},
		{0, "13", 0},
		{10000, "13.00", 1300},
		{100, "13", 13},
		{1, "13", 0}, // 13 paisa of 1 → rounds to 0
		{50, "1", 1}, // 0.5 → round half up → 1
		{10000, "10.5", 1050},
	}
	for _, c := range cases {
		if got := pctOf(c.amount, c.pct); got != c.want {
			t.Errorf("pctOf(%d, %q) = %d, want %d", c.amount, c.pct, got, c.want)
		}
	}
}

func TestPctInclusive(t *testing.T) {
	cases := []struct {
		gross int64
		pct   string
		want  int64
	}{
		{11300, "13", 1300},   // 13% baked into 11300 → 1300 VAT, 10000 net
		{10000, "13", 1150},   // 10000 * 13/113 = 1150.44 → 1150
		{10000, "0", 0},       // no rate → no VAT
		{0, "13", 0},          // no money → no VAT
		{10500, "5", 500},     // 10500 * 5/105 = 500 exactly
		{11000, "10", 1000},   // 11000 * 10/110 = 1000 exactly
	}
	for _, c := range cases {
		if got := pctInclusive(c.gross, c.pct); got != c.want {
			t.Errorf("pctInclusive(%d, %q) = %d, want %d", c.gross, c.pct, got, c.want)
		}
	}
}

func TestFormatPaisa(t *testing.T) {
	cases := map[int64]string{
		0:      "Rs 0.00",
		100:    "Rs 1.00",
		150:    "Rs 1.50",
		105:    "Rs 1.05",
		99:     "Rs 0.99",
		-150:   "-Rs 1.50",
		-5:     "-Rs 0.05",
		123456: "Rs 1234.56",
	}
	for in, want := range cases {
		if got := formatPaisa(in); got != want {
			t.Errorf("formatPaisa(%d) = %q, want %q", in, got, want)
		}
	}
}

// =========================================================================
// RecordPayment
// =========================================================================

// recordOrder sets up an open order with a single item (subtotal = priceCents)
// and returns its id. vat defaults to 13%, service 0% (tenant defaults).
func recordOrder(fx *fixture, priceCents int64) uuid.UUID {
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", priceCents)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, priceCents)
	return order
}

func TestRecordPayment_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 100},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestRecordPayment_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/", "{not json",
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestRecordPayment_BankRejected(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "bank", "amount_cents": 100},
		withParam("id", order.String())).
		expectErr(400, "bad_method")
}

func TestRecordPayment_UnknownMethod(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "bitcoin", "amount_cents": 100},
		withParam("id", order.String())).
		expectErr(400, "bad_method")
}

func TestRecordPayment_NonPositiveAmount(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	for _, amt := range []int64{0, -100} {
		callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
			map[string]any{"method": "cash", "amount_cents": amt},
			withParam("id", order.String())).
			expectErr(400, "bad_amount")
	}
}

func TestRecordPayment_HouseTabMissingID(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "house_tab", "amount_cents": 100},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestRecordPayment_OrderNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 100},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestRecordPayment_OrderNotOpen(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	fx.setOrderStatus(order, "closed")
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 100},
		withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

func TestRecordPayment_Overpayment(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000) // total = 11300 (13% vat)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 99999},
		withParam("id", order.String())).
		expectErr(409, "overpayment")
}

func TestRecordPayment_CashRequiresShift(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	// no open shift seeded
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 100},
		withParam("id", order.String())).
		expectErr(409, "shift_required")
}

func TestRecordPayment_CashSuccess(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000) // total 11300
	fx.seedOpenShift(0)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 11300},
		withParam("id", order.String())).
		expectStatus(201)
	if n := fx.countRows("payments"); n != 1 {
		t.Fatalf("payments = %d, want 1", n)
	}
}

func TestRecordPayment_OnlineNoShiftNeeded(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	// "online" normalizes to "other"; no shift required.
	r := callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "online", "amount_cents": 100},
		withParam("id", order.String())).
		expectStatus(201)
	var p Payment
	r.decode(&p)
	if p.Method != "other" {
		t.Fatalf("stored method = %q, want other", p.Method)
	}
}

func TestRecordPayment_NonHouseTabIgnoresTabID(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	tab := fx.seedHouseTab("Staff", true)
	r := callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "online", "amount_cents": 100, "house_tab_id": tab.String()},
		withParam("id", order.String())).
		expectStatus(201)
	var p Payment
	r.decode(&p)
	if p.HouseTabID != nil {
		t.Fatalf("house_tab_id should be cleared for non-house_tab method, got %v", *p.HouseTabID)
	}
}

func TestRecordPayment_HouseTabNotFound(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "house_tab", "amount_cents": 100, "house_tab_id": uuid.NewString()},
		withParam("id", order.String())).
		expectErr(400, "bad_request")
}

func TestRecordPayment_HouseTabInactive(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	tab := fx.seedHouseTab("Archived", false)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "house_tab", "amount_cents": 100, "house_tab_id": tab.String()},
		withParam("id", order.String())).
		expectErr(409, "house_tab_inactive")
}

func TestRecordPayment_HouseTabSuccess(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000)
	tab := fx.seedHouseTab("Staff", true)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "house_tab", "amount_cents": 100, "house_tab_id": tab.String()},
		withParam("id", order.String())).
		expectStatus(201)
}

// =========================================================================
// ListOrderPayments
// =========================================================================

func TestListOrderPayments_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListOrderPayments, "GET", "/", nil, withParam("id", "nope")).
		expectErr(400, "bad_request")
}

func TestListOrderPayments_Empty(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	r := callHandler(t, fx, ListOrderPayments, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).json()
	ps, _ := r["payments"].([]any)
	if len(ps) != 0 {
		t.Fatalf("payments = %d, want 0", len(ps))
	}
}

func TestListOrderPayments_WithRows(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.seedPayment(order, "cash", 100, nil)
	fx.seedPayment(order, "other", 200, nil)
	r := callHandler(t, fx, ListOrderPayments, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).json()
	ps, _ := r["payments"].([]any)
	if len(ps) != 2 {
		t.Fatalf("payments = %d, want 2", len(ps))
	}
}

// =========================================================================
// DeletePayment
// =========================================================================

func TestDeletePayment_BadOrderID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": "nope", "paymentId": uuid.NewString()})).
		expectErr(400, "bad_request")
}

func TestDeletePayment_BadPaymentID(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": "nope"})).
		expectErr(400, "bad_request")
}

func TestDeletePayment_OrderNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "paymentId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestDeletePayment_OrderNotOpen(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	pay := fx.seedPayment(order, "cash", 100, nil)
	fx.setOrderStatus(order, "closed")
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": pay.String()})).
		expectErr(409, "order_not_open")
}

func TestDeletePayment_PaymentNotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestDeletePayment_Success(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	pay := fx.seedPayment(order, "cash", 100, nil)
	callHandler(t, fx, DeletePayment(testHub()), "DELETE", "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": pay.String()})).
		expectStatus(204)
	if n := fx.countRows("payments"); n != 0 {
		t.Fatalf("payments = %d, want 0", n)
	}
}

// =========================================================================
// ReclassifyPayment
// =========================================================================

func reclassifyParams(order, pay uuid.UUID) func(*reqOpts) {
	return withParams(map[string]string{"id": order.String(), "paymentId": pay.String()})
}

func TestReclassifyPayment_BadIDs(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash"},
		withParams(map[string]string{"id": "x", "paymentId": uuid.NewString()})).
		expectErr(400, "bad_request")
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash"},
		withParams(map[string]string{"id": order.String(), "paymentId": "x"})).
		expectErr(400, "bad_request")
}

func TestReclassifyPayment_BadJSON(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	pay := fx.seedPayment(order, "cash", 100, nil)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/", "{bad",
		reclassifyParams(order, pay)).
		expectErr(400, "bad_request")
}

func TestReclassifyPayment_BadMethod(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	pay := fx.seedPayment(order, "cash", 100, nil)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "house_tab"}, reclassifyParams(order, pay)).
		expectErr(400, "bad_method")
}

func TestReclassifyPayment_NotFound(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash"},
		reclassifyParams(order, uuid.New())).
		expectErr(404, "not_found")
}

func TestReclassifyPayment_HouseTabExcluded(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	tab := fx.seedHouseTab("Staff", true)
	var pay uuid.UUID
	fx.adminScan([]any{&pay},
		`INSERT INTO payments (tenant_id, order_id, method, amount_cents, recorded_by_user_id, house_tab_id)
		 VALUES ($1,$2,'house_tab',100,$3,$4) RETURNING id`,
		fx.Tenant, order, fx.User, tab)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash"}, reclassifyParams(order, pay)).
		expectErr(409, "house_tab_excluded")
}

func TestReclassifyPayment_SameMethod(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	shift := fx.seedOpenShift(0)
	pay := fx.seedPayment(order, "cash", 100, ptrUUID(shift))
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash"}, reclassifyParams(order, pay)).
		expectErr(409, "same_method")
}

func TestReclassifyPayment_NoShift(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	pay := fx.seedPayment(order, "cash", 100, nil) // no shift
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "online"}, reclassifyParams(order, pay)).
		expectErr(409, "no_shift")
}

func TestReclassifyPayment_ShiftClosed(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	shift := fx.seedOpenShift(0)
	pay := fx.seedPayment(order, "cash", 100, ptrUUID(shift))
	fx.closeShift(shift)
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "online"}, reclassifyParams(order, pay)).
		expectErr(409, "shift_closed")
}

func TestReclassifyPayment_Success(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	shift := fx.seedOpenShift(0)
	pay := fx.seedPayment(order, "cash", 100, ptrUUID(shift))
	r := callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "online"}, reclassifyParams(order, pay)).
		expectStatus(200)
	var p Payment
	r.decode(&p)
	if p.Method != "other" { // online persists as other
		t.Fatalf("method = %q, want other", p.Method)
	}
	// And back to cash.
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash"}, reclassifyParams(order, pay)).
		expectStatus(200)
}

// =========================================================================
// GetSettleQuote
// =========================================================================

func TestGetSettleQuote_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", "nope")).
		expectErr(400, "bad_request")
}

func TestGetSettleQuote_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestGetSettleQuote_WithServiceAndDiscount(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantRates("10", "13")
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	// discount adjustment of 1000
	fx.adminExec(`INSERT INTO order_adjustments (tenant_id, order_id, type, amount_cents, applied_by_user_id)
	              VALUES ($1,$2,'discount',1000,$3)`, fx.Tenant, order, fx.User)
	q := callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).json()
	// subtotal 10000, service 10% = 1000, taxbase = 10000-1000+1000 = 10000, tax 13% = 1300
	// total = 10000 - 1000 + 1000 + 1300 = 11300
	if got := int64(q["total_cents"].(float64)); got != 11300 {
		t.Fatalf("total = %d, want 11300", got)
	}
	if got := int64(q["discount_cents"].(float64)); got != 1000 {
		t.Fatalf("discount = %d, want 1000", got)
	}
	if got := int64(q["service_charge_cents"].(float64)); got != 1000 {
		t.Fatalf("service = %d, want 1000", got)
	}
}

// =========================================================================
// CloseOrder
// =========================================================================

func TestCloseOrder_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", "nope")).
		expectErr(400, "bad_request")
}

func TestCloseOrder_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestCloseOrder_AlreadyClosed(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	fx.setOrderStatus(order, "cancelled")
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectErr(409, "already_cancelled")
}

func TestCloseOrder_Empty(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil) // no items
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectErr(409, "empty_order")
}

func TestCloseOrder_BalanceOutstanding(t *testing.T) {
	fx := newTenant(t)
	order := recordOrder(fx, 10000) // total 11300, no payments
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectErr(409, "balance_outstanding")
}

func TestCloseOrder_SuccessDirtiesTable(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("T1")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, table)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 10000)
	order := fx.seedOpenOrder(ptrUUID(table))
	fx.seedOrderItem(order, item, 1, 10000)
	fx.seedPayment(order, "cash", 11300, nil)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200)
	if fx.orderStatus(order) != "closed" {
		t.Fatalf("order not closed")
	}
	if got := fx.tableStatus(table); got != "dirty" {
		t.Fatalf("table status = %q, want dirty", got)
	}
}

func TestCloseOrder_AutoCleanFreesTable(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantPref("autoCleanTables", true)
	table := fx.seedTable("T1")
	fx.adminExec(`UPDATE service_tables SET status = 'occupied' WHERE id = $1`, table)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 10000)
	order := fx.seedOpenOrder(ptrUUID(table))
	fx.seedOrderItem(order, item, 1, 10000)
	fx.seedPayment(order, "cash", 11300, nil)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200)
	if got := fx.tableStatus(table); got != "free" {
		t.Fatalf("table status = %q, want free (autoclean)", got)
	}
}

// =========================================================================
// buildQuote — VAT modes (none / inclusive / exclusive)
// =========================================================================

// quoteFor seeds a single-item open order at priceCents and returns the
// computed settle quote via the GetSettleQuote handler.
func quoteFor(t *testing.T, fx *fixture, priceCents int64) CloseQuote {
	t.Helper()
	order := recordOrder(fx, priceCents)
	r := callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200)
	var q CloseQuote
	r.decode(&q)
	return q
}

func TestSettleQuote_VatModeNone(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("none", "13")
	q := quoteFor(t, fx, 10000)
	if q.TaxCents != 0 {
		t.Errorf("tax = %d, want 0 (no VAT)", q.TaxCents)
	}
	if q.TotalCents != 10000 {
		t.Errorf("total = %d, want 10000", q.TotalCents)
	}
	if q.VatMode != "none" {
		t.Errorf("vat_mode = %q, want none", q.VatMode)
	}
}

func TestSettleQuote_VatModeExclusive(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("exclusive", "13")
	q := quoteFor(t, fx, 10000)
	if q.TaxCents != 1300 {
		t.Errorf("tax = %d, want 1300 (13%% on top)", q.TaxCents)
	}
	if q.TotalCents != 11300 {
		t.Errorf("total = %d, want 11300", q.TotalCents)
	}
	if q.TotalCents-q.TaxCents != 10000 {
		t.Errorf("net = %d, want 10000", q.TotalCents-q.TaxCents)
	}
}

func TestSettleQuote_VatModeInclusive(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantVat("inclusive", "13")
	q := quoteFor(t, fx, 11300)
	if q.TotalCents != 11300 {
		t.Errorf("total = %d, want 11300 (prices already include VAT)", q.TotalCents)
	}
	if q.TaxCents != 1300 {
		t.Errorf("tax = %d, want 1300 (extracted from 11300)", q.TaxCents)
	}
	if q.TotalCents-q.TaxCents != 10000 {
		t.Errorf("net = %d, want 10000", q.TotalCents-q.TaxCents)
	}
}

// The net + tax == total invariant must hold in every mode, including when a
// service charge widens the base.
func TestSettleQuote_NetPlusTaxEqualsTotal(t *testing.T) {
	for _, mode := range []string{"none", "inclusive", "exclusive"} {
		fx := newTenant(t)
		fx.setTenantVat(mode, "13")
		fx.setTenantRates("10", "13") // 10% service charge
		q := quoteFor(t, fx, 10000)
		if got := (q.TotalCents - q.TaxCents) + q.TaxCents; got != q.TotalCents {
			t.Errorf("[%s] net+tax = %d, want total %d", mode, got, q.TotalCents)
		}
		if q.ServiceChargeCents != 1000 {
			t.Errorf("[%s] service = %d, want 1000", mode, q.ServiceChargeCents)
		}
	}
}
