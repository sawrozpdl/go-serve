package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// loadShiftCashFlowTx runs loadShiftCashFlow as the app role.
func loadShiftCashFlowTx(t *testing.T, fx *fixture, shift uuid.UUID) (shiftCashFlow, error) {
	t.Helper()
	var f shiftCashFlow
	err := fx.appTx(func(tx pgx.Tx) error {
		var e error
		f, e = loadShiftCashFlow(appctx.WithTx(context.Background(), tx), shift)
		return e
	})
	return f, err
}

// settleTwoLines settles a VAT bill of two Rs 565 lines (Rs 1,130) paid in
// cash inside an open shift, returning the order, the invoice and the shift.
func settleTwoLines(t *testing.T, fx *fixture) (uuid.UUID, *fiscal.Invoice, uuid.UUID) {
	t.Helper()
	var shift uuid.UUID
	var open int
	fx.adminScan([]any{&open}, `SELECT count(*) FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL`, fx.Tenant)
	if open == 0 {
		shift = fx.seedOpenShift(0)
	} else {
		fx.adminScan([]any{&shift}, `SELECT id FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL`, fx.Tenant)
	}
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("Food " + uuid.NewString()[:6])
	fx.seedOrderItem(order, fx.seedMenuItem(cat, "Momo", 56500), 1, 56500)
	fx.seedOrderItem(order, fx.seedMenuItem(cat, "Thukpa", 56500), 1, 56500)
	fx.seedPayment(order, "cash", 113000, &shift)
	var out closeResponse
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).
		expectStatus(200).decode(&out)
	return order, out.Invoice, shift
}

func creditNote(t *testing.T, fx *fixture, invID uuid.UUID, body map[string]any) *apiResp {
	t.Helper()
	return callHandler(t, fx, CreateCreditNote(testHub()), "POST", "/", body, withParam("id", invID.String()))
}

func invoiceView(t *testing.T, fx *fixture, invID uuid.UUID) InvoiceView {
	t.Helper()
	var v InvoiceView
	callHandler(t, fx, GetInvoice, "GET", "/", nil, withParam("id", invID.String())).expectStatus(200).decode(&v)
	return v
}

func cashBucket(t *testing.T, fx *fixture, method string) AccountBalance {
	t.Helper()
	var out struct {
		Accounts []AccountBalance `json:"accounts"`
	}
	callHandler(t, fx, GetAccountBalances, "GET", "/", nil).expectStatus(200).decode(&out)
	for _, a := range out.Accounts {
		if a.Method == method {
			return a
		}
	}
	t.Fatalf("no %s bucket", method)
	return AccountBalance{}
}

func TestCreditNote_PartialThenCompletingReturn(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, inv, shift := settleTwoLines(t, fx)
	cashBefore := cashBucket(t, fx, "cash").BalanceCents
	flowBefore, _ := loadShiftCashFlowTx(t, fx, shift)

	var cn1 fiscal.CreditNote
	creditNote(t, fx, inv.ID, map[string]any{
		"kind": "sales_return", "reason": "cold dish", "refund_method": "cash",
		"lines": []map[string]any{{"line_no": 1, "qty": "1"}},
	}).expectStatus(201).decode(&cn1)
	if cn1.Number != "CN-1" || cn1.TotalCents != 56500 || cn1.VATCents+cn1.TaxableCents != 56500 || len(cn1.Lines) != 1 {
		t.Fatalf("first return = %+v", cn1)
	}
	// The refund left the drawer: cash account and the shift's expected cash.
	if got := cashBucket(t, fx, "cash").BalanceCents; got != cashBefore-56500 {
		t.Fatalf("cash bucket %d → %d, want −56500", cashBefore, got)
	}
	flowAfter, _ := loadShiftCashFlowTx(t, fx, shift)
	if flowAfter.expected(0) != flowBefore.expected(0)-56500 {
		t.Fatalf("shift expected cash %d → %d", flowBefore.expected(0), flowAfter.expected(0))
	}
	if v := invoiceView(t, fx, inv.ID); !v.Active || len(v.CreditNotes) != 1 {
		t.Fatalf("after partial return active=%v notes=%d", v.Active, len(v.CreditNotes))
	}

	// Returning line 1 again is refused, with no number spent.
	creditNote(t, fx, inv.ID, map[string]any{
		"kind": "sales_return", "reason": "again", "refund_method": "cash",
		"lines": []map[string]any{{"line_no": 1, "qty": "1"}},
	}).expectErr(409, "over_return")

	var cn2 fiscal.CreditNote
	creditNote(t, fx, inv.ID, map[string]any{"kind": "sales_return", "reason": "guest left", "refund_method": "cash"}).
		expectStatus(201).decode(&cn2)
	if cn2.Number != "CN-2" {
		t.Fatalf("second note number = %s (a refused request must not consume one)", cn2.Number)
	}
	if cn1.TotalCents+cn2.TotalCents != inv.TotalCents || cn1.VATCents+cn2.VATCents != inv.VATCents {
		t.Fatalf("notes %d+%d ≠ invoice %d", cn1.TotalCents, cn2.TotalCents, inv.TotalCents)
	}
	if v := invoiceView(t, fx, inv.ID); v.Active {
		t.Fatal("fully returned bill still active")
	}
	creditNote(t, fx, inv.ID, map[string]any{"kind": "sales_return", "reason": "x", "refund_method": "cash"}).
		expectErr(409, "fully_credited")

	// Queued for CBMS /billreturn, referencing the bill.
	var ep, ref string
	fx.adminScan([]any{&ep, &ref}, `SELECT endpoint, payload->>'ref_invoice_number' FROM cbms_submissions WHERE doc_id = $1`, cn1.ID)
	if ep != "billreturn" || ref != inv.Number {
		t.Fatalf("cbms row = %s %s", ep, ref)
	}

	// Immutable.
	for _, sql := range []string{
		`UPDATE credit_notes SET reason = 'x' WHERE id = '` + cn1.ID.String() + `'`,
		`DELETE FROM credit_notes WHERE id = '` + cn1.ID.String() + `'`,
		`DELETE FROM refunds WHERE credit_note_id = '` + cn1.ID.String() + `'`,
	} {
		if err := fx.appExecErr(sql); err == nil {
			t.Errorf("allowed: %s", sql)
		}
	}
}

func TestCreditNote_ReversalWholeBillSameDay(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, inv, _ := settleTwoLines(t, fx)
	var re fiscal.CreditNote
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "wrong table", "refund_method": "cash"}).
		expectStatus(201).decode(&re)
	if re.Number != "RE-1" || re.TotalCents != inv.TotalCents || re.VATCents != inv.VATCents || re.GrossCents != inv.GrossCents {
		t.Fatalf("reversal = %+v", re)
	}
	if v := invoiceView(t, fx, inv.ID); v.Active {
		t.Fatal("reversed bill still active")
	}
}

func TestCreditNote_ReversalRules(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, inv, _ := settleTwoLines(t, fx)
	creditNote(t, fx, inv.ID, map[string]any{
		"kind": "sales_return", "reason": "one back", "refund_method": "cash",
		"lines": []map[string]any{{"line_no": 2, "qty": "1"}},
	}).expectStatus(201)
	// A bill already partly returned cannot be reversed.
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "x", "refund_method": "cash"}).
		expectStatus(409)

	// A bill from an earlier day must use a sales return.
	_, inv2, _ := settleTwoLines(t, fx)
	ctx := context.Background()
	tx, _ := adminPool.Begin(ctx)
	_, _ = tx.Exec(ctx, `SET LOCAL session_replication_role = replica`)
	_, _ = tx.Exec(ctx, `UPDATE invoices SET bs_date = '2083-01-01' WHERE id = $1`, inv2.ID)
	_ = tx.Commit(ctx)
	creditNote(t, fx, inv2.ID, map[string]any{"kind": "reversal", "reason": "x", "refund_method": "cash"}).
		expectErr(409, "reversal_window")
	creditNote(t, fx, inv2.ID, map[string]any{"kind": "sales_return", "refund_method": "cash"}).
		expectErr(400, "reason_required")
}

func TestCreditNote_ReverseAndRebill(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, inv, _ := settleTwoLines(t, fx)
	var re fiscal.CreditNote
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "paid online, not cash", "refund_method": "cash", "reopen": true}).
		expectStatus(201).decode(&re)
	if re.ReopenedOrderID == nil {
		t.Fatal("no re-bill order")
	}
	var status string
	var lines int
	var sum int64
	fx.adminScan([]any{&status}, `SELECT status::text FROM orders WHERE id = $1`, *re.ReopenedOrderID)
	fx.adminScan([]any{&lines, &sum}, `SELECT count(*), COALESCE(sum(qty*unit_price_cents),0)::bigint FROM order_items WHERE order_id = $1`, *re.ReopenedOrderID)
	if status != "open" || lines != 2 || sum != 113000 {
		t.Fatalf("re-bill order: status=%s lines=%d sum=%d", status, lines, sum)
	}
}

func TestCreditNote_OnlineAndCreditRefunds(t *testing.T) {
	fx := newFiscalTenant(t, "vat")

	// Online refund: the online account falls by it.
	_, inv, _ := settleTwoLines(t, fx)
	before := cashBucket(t, fx, "online").BalanceCents
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "x", "refund_method": "online", "refund_reference": "ESW-1"}).
		expectStatus(201)
	after := cashBucket(t, fx, "online")
	if after.BalanceCents != before-113000 || after.RefundsCents != 113000 {
		t.Fatalf("online bucket %d → %+v", before, after)
	}

	// Credit refund: only for a bill charged to a credit account.
	_, inv2, _ := settleTwoLines(t, fx)
	creditNote(t, fx, inv2.ID, map[string]any{"kind": "reversal", "reason": "x", "refund_method": "credit"}).
		expectErr(409, "not_on_credit")

	tab := fx.seedHouseTab("Ramesh", true)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, fx.seedMenuItem(fx.seedCategory("Drinks"), "Tea", 11300), 1, 11300)
	fx.adminExec(`INSERT INTO payments (tenant_id, order_id, method, amount_cents, recorded_by_user_id, house_tab_id)
		VALUES ($1, $2, 'house_tab', 11300, $3, $4)`, fx.Tenant, order, fx.User, tab)
	var out closeResponse
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil, withParam("id", order.String())).expectStatus(200).decode(&out)
	creditNote(t, fx, out.Invoice.ID, map[string]any{"kind": "reversal", "reason": "wrong guest", "refund_method": "credit"}).
		expectStatus(201)
	if err := fx.appTx(func(tx pgx.Tx) error {
		bal, err := houseTabBalance(context.Background(), tx, tab)
		if err == nil && bal != 0 {
			t.Fatalf("tab still owes %d after the bill was reversed", bal)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCreditNote_PrintLabels(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, inv, _ := settleTwoLines(t, fx)
	var re fiscal.CreditNote
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "x", "refund_method": "cash"}).
		expectStatus(201).decode(&re)
	for i, want := range []string{"ORIGINAL", "Copy of Original (1)"} {
		got := callHandler(t, fx, PrintCreditNote, "POST", "/", nil, withParam("id", re.ID.String())).expectStatus(200).json()
		if got["title"] != "REVERSE ENTRY" || got["copy_label"] != want {
			t.Fatalf("print %d = %v", i+1, got)
		}
	}
}

func TestDashboard_ReturnsAreNetted(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, inv, _ := settleTwoLines(t, fx)
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "x", "refund_method": "cash"}).expectStatus(201)
	var d ReportsDashboard
	callHandler(t, fx, GetDashboard, "GET", "/", nil, withQuery("range=today")).expectStatus(200).decode(&d)
	if d.KPIs.ReturnsCents != 113000 || d.KPIs.NetCents != d.KPIs.SalesCents-113000-d.KPIs.ExpensesCents {
		t.Fatalf("kpis = %+v", d.KPIs)
	}
}
