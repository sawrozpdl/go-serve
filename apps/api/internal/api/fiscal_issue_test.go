package api

import (
	"context"
	"sort"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
)

// newFiscalTenant returns a tenant in fiscal mode under reg ("vat" or "pan").
func newFiscalTenant(t *testing.T, reg string) *fixture {
	t.Helper()
	fx := newTenant(t)
	pan := setupFiscalProfile(t, fx, reg)
	enableFiscal(t, fx, pan).expectStatus(200)
	return fx
}

// settle builds an open order with the given lines, pays it in full in cash
// and closes it through the real handler, returning the decoded response.
func settle(t *testing.T, fx *fixture, prices []int64, body any) (uuid.UUID, closeResponse) {
	t.Helper()
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("Food-" + uuid.NewString()[:6])
	for i, p := range prices {
		mi := fx.seedMenuItem(cat, "Dish "+string(rune('A'+i)), p)
		fx.seedOrderItem(order, mi, 1, p)
	}
	var q CloseQuote
	callHandler(t, fx, GetSettleQuote, "GET", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&q)
	if q.TotalCents > 0 {
		fx.seedPayment(order, "cash", q.TotalCents, nil)
	}
	var out closeResponse
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", body, withParam("id", order.String())).
		expectStatus(200).decode(&out)
	return order, out
}

func TestIssue_VATInvoiceOnSettle(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, out := settle(t, fx, []int64{56500, 56500}, map[string]any{
		"buyer": map[string]any{"name": "Acme Traders", "pan": "601-234-567"},
	})
	inv := out.Invoice
	if inv == nil {
		t.Fatal("fiscal café settle returned no invoice")
	}
	fy, _ := bsdate.FiscalYearOfTime(inv.IssuedAt)
	if inv.Kind != "tax_invoice" || inv.Seq != 1 || inv.Number != "1" || inv.FiscalYear != fy.String() {
		t.Fatalf("header = %+v", inv)
	}
	// Rs 1,130 VAT-inclusive → taxable 1,000 + VAT 130.
	if inv.TotalCents != 113000 || inv.VATCents != 13000 || inv.TaxableCents != 100000 || inv.GrossCents != 100000 {
		t.Fatalf("totals = %+v", inv.Totals())
	}
	if inv.TotalCents != out.TotalCents || inv.VATCents != out.TaxCents {
		t.Fatal("invoice does not repeat the order totals")
	}
	if inv.BuyerPAN != "601234567" || inv.BuyerName != "Acme Traders" || inv.PaymentMethod != "Cash" {
		t.Fatalf("buyer/payment = %q %q %q", inv.BuyerName, inv.BuyerPAN, inv.PaymentMethod)
	}
	if len(inv.Lines) != 2 || inv.Lines[0].AmountCents != 56500 {
		t.Fatalf("lines = %+v", inv.Lines)
	}
	if inv.QRPayload == "" || inv.SoftwareVersion == "" || inv.IssuedByName == "" {
		t.Fatalf("missing print fields: %+v", inv)
	}

	// The stored row hashes to its recorded content hash.
	var stored *fiscal.Invoice
	if err := fx.appTx(func(tx pgx.Tx) error {
		var err error
		stored, err = fiscal.LoadInvoice(context.Background(), tx, &inv.ID, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if !stored.VerifyHash(fx.Tenant) {
		t.Fatal("stored invoice fails its content hash")
	}

	// Next bill takes the next number.
	_, out2 := settle(t, fx, []int64{11300}, nil)
	if out2.Invoice == nil || out2.Invoice.Seq != 2 {
		t.Fatalf("second invoice = %+v", out2.Invoice)
	}
}

func TestIssue_PANInvoice(t *testing.T) {
	fx := newFiscalTenant(t, "pan")
	_, out := settle(t, fx, []int64{50000}, nil)
	inv := out.Invoice
	if inv == nil || inv.Kind != "invoice" || inv.VATCents != 0 || inv.NonTaxableCents != 50000 || inv.TaxableCents != 0 {
		t.Fatalf("PAN invoice = %+v", inv)
	}
}

func TestIssue_NonFiscalCafeUnchanged(t *testing.T) {
	fx := newTenant(t)
	_, out := settle(t, fx, []int64{10000}, nil)
	if out.Invoice != nil {
		t.Fatal("a café without fiscal mode got an invoice")
	}
	if n := fx.countRows("invoices"); n != 0 {
		t.Fatalf("invoices rows = %d", n)
	}
}

func TestIssue_BadBuyerConsumesNoNumber(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	order := fx.seedOpenOrder(nil)
	mi := fx.seedMenuItem(fx.seedCategory("Food"), "Tea", 5000)
	fx.seedOrderItem(order, mi, 1, 5000)
	fx.seedPayment(order, "cash", 5000, nil)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/",
		map[string]any{"buyer": map[string]any{"pan": "12"}},
		withParam("id", order.String())).
		expectErr(400, "invalid_buyer")
	if fx.orderStatus(order) != "open" {
		t.Fatal("order closed despite a 400")
	}
	var out closeResponse
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&out)
	if out.Invoice == nil || out.Invoice.Seq != 1 {
		t.Fatalf("after a refused settle the next number must still be 1: %+v", out.Invoice)
	}
}

func TestIssue_StaffMealGetsNoInvoice(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	order := fx.seedOpenOrder(nil)
	fx.adminExec(`UPDATE orders SET is_staff_meal = true WHERE id = $1`, order)
	mi := fx.seedMenuItem(fx.seedCategory("Food"), "Dal Bhat", 30000)
	fx.seedOrderItem(order, mi, 1, 30000)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200)
	if n := fx.countRows("invoices"); n != 0 {
		t.Fatalf("staff meal issued %d invoice(s)", n)
	}
}

// Concurrent settles never share or skip a number.
func TestIssue_ConcurrentNumbersAreGapFree(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	const n = 20
	orders := make([]uuid.UUID, n)
	mi := fx.seedMenuItem(fx.seedCategory("Food"), "Coffee", 22600)
	for i := range orders {
		orders[i] = fx.seedOpenOrder(nil)
		fx.seedOrderItem(orders[i], mi, 1, 22600)
		fx.seedPayment(orders[i], "cash", 22600, nil)
	}
	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := range orders {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil,
				withParam("id", orders[i].String())).Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != 200 {
			t.Fatalf("close %d = %d", i, c)
		}
	}
	rows, err := adminPool.Query(context.Background(),
		`SELECT seq FROM invoices WHERE tenant_id = $1`, fx.Tenant)
	if err != nil {
		t.Fatal(err)
	}
	var seqs []int
	for rows.Next() {
		var s int
		_ = rows.Scan(&s)
		seqs = append(seqs, s)
	}
	rows.Close()
	sort.Ints(seqs)
	if len(seqs) != n {
		t.Fatalf("issued %d invoices, want %d", len(seqs), n)
	}
	for i, s := range seqs {
		if s != i+1 {
			t.Fatalf("numbers not contiguous 1..%d: %v", n, seqs)
		}
	}
}

func TestIssue_InvoicedOrderIsFrozen(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	// Paid inside an open shift, so ReclassifyPayment gets past its shift
	// checks and reaches the invoice check.
	shift := fx.seedOpenShift(0)
	order := fx.seedOpenOrder(nil)
	mi := fx.seedMenuItem(fx.seedCategory("Food"), "Lassi", 11300)
	fx.seedOrderItem(order, mi, 1, 11300)
	fx.seedPayment(order, "cash", 11300, &shift)
	var out closeResponse
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&out)
	invID := out.Invoice.ID

	var itemID, payID uuid.UUID
	fx.adminScan([]any{&itemID}, `SELECT id FROM order_items WHERE order_id = $1`, order)
	fx.adminScan([]any{&payID}, `SELECT id FROM payments WHERE order_id = $1`, order)

	refused := []string{
		`UPDATE invoices SET buyer_name = 'X' WHERE id = '` + invID.String() + `'`,
		`DELETE FROM invoices WHERE id = '` + invID.String() + `'`,
		`UPDATE invoice_lines SET amount_cents = 1 WHERE invoice_id = '` + invID.String() + `'`,
		`UPDATE orders SET total_cents = 1 WHERE id = '` + order.String() + `'`,
		`UPDATE orders SET status = 'cancelled' WHERE id = '` + order.String() + `'`,
		`UPDATE order_items SET qty = 2 WHERE id = '` + itemID.String() + `'`,
		`DELETE FROM payments WHERE id = '` + payID.String() + `'`,
		`UPDATE payments SET method = 'other' WHERE id = '` + payID.String() + `'`,
		`UPDATE fiscal_sequences SET next_value = 1 WHERE tenant_id = current_tenant_id()`,
		`DELETE FROM fiscal_sequences WHERE tenant_id = current_tenant_id()`,
	}
	for _, sql := range refused {
		if err := fx.appExecErr(sql); err == nil {
			t.Errorf("app role allowed: %s", sql)
		}
	}
	// Even the superuser is refused (triggers apply to every role).
	if _, err := adminPool.Exec(context.Background(), `DELETE FROM invoices WHERE id = $1`, invID); err == nil {
		t.Error("superuser deleted an invoice")
	}
	if _, err := adminPool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, order); err == nil {
		t.Error("superuser deleted an invoiced order")
	}

	// The kitchen can still mark the paid dish served.
	if err := fx.appExecErr(`UPDATE order_items SET kitchen_status = 'served', served_at = now() WHERE id = $1`, itemID); err != nil {
		t.Errorf("kitchen progress refused on an invoiced order: %v", err)
	}

	// Reclassify explains itself instead of failing in the trigger.
	callHandler(t, fx, ReclassifyPayment(testHub()), "POST", "/",
		map[string]any{"method": "online"},
		withParams(map[string]string{"id": order.String(), "paymentId": payID.String()})).
		expectErr(409, "invoiced")
}

func TestIssue_InvoiceRequiresFiscalModeAndMatchingTotals(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	mi := fx.seedMenuItem(fx.seedCategory("Food"), "Tea", 5000)
	fx.seedOrderItem(order, mi, 1, 5000)
	fx.closeOrderPaidInFull(order)
	err := fx.appExecErr(`
		INSERT INTO invoices (tenant_id, order_id, kind, fiscal_year, seq, number, issued_at, bs_date, ad_date,
		  seller_pan, seller_name, seller_address, gross_cents, discount_cents, taxable_cents, non_taxable_cents,
		  vat_cents, total_cents, vat_rate, payment_method, issued_by_name, software_version, qr_payload, content_hash)
		VALUES (current_tenant_id(), $1, 'invoice', '2083/84', 1, '1', now(), '2083-07-21', current_date,
		  '601234567', 'X', 'Y', 5000, 0, 0, 5000, 0, 5000, 0, 'Cash', 'X', 'v', 'q', repeat('a', 64))`, order)
	if err == nil {
		t.Fatal("a non-fiscal café inserted an invoice")
	}
}

func TestOrderSlips_NumberedPerSend(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("Food")
	mi := fx.seedMenuItem(cat, "Momo", 30000)
	fx.seedOrderItem(order, mi, 1, 30000)

	r1 := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).expectStatus(200).json()
	slip1, _ := r1["slip"].(map[string]any)
	if slip1 == nil || slip1["number"] != "KOT-1" {
		t.Fatalf("first send slip = %v", r1["slip"])
	}

	fx.seedOrderItem(order, mi, 2, 30000)
	r2 := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).expectStatus(200).json()
	slip2, _ := r2["slip"].(map[string]any)
	if slip2 == nil || slip2["number"] != "KOT-2" {
		t.Fatalf("second send slip = %v", r2["slip"])
	}
	if lines, _ := slip2["lines"].([]any); len(lines) != 1 {
		t.Fatalf("second slip should carry only the new line: %v", slip2["lines"])
	}

	// Nothing new to send → no slip, no number spent.
	r3 := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).expectStatus(200).json()
	if r3["slip"] != nil {
		t.Fatalf("empty send produced a slip: %v", r3["slip"])
	}
	if err := fx.appExecErr(`DELETE FROM order_slips WHERE order_id = $1`, order); err == nil {
		t.Fatal("order slips are deletable")
	}
}

func TestOrderSlips_NonFiscalCafeHasNone(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	mi := fx.seedMenuItem(fx.seedCategory("Food"), "Momo", 30000)
	fx.seedOrderItem(order, mi, 1, 30000)
	r := callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", order.String())).expectStatus(200).json()
	if r["slip"] != nil {
		t.Fatal("non-fiscal café got an order slip")
	}
}
