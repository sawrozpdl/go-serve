package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func seedBankExpense(fx *fixture, vendor string, cents int64) uuid.UUID {
	var id uuid.UUID
	fx.adminScan([]any{&id}, `INSERT INTO expenses (tenant_id, vendor, amount_cents, paid_at, recorded_by_user_id, paid_from, payment_method)
		VALUES ($1, $2, $3, now(), $4, 'bank', 'bank') RETURNING id`, fx.Tenant, vendor, cents, fx.User)
	return id
}

func purchaseBill(t *testing.T, fx *fixture, expenseID uuid.UUID, body map[string]any) *apiResp {
	t.Helper()
	return callHandler(t, fx, CreatePurchaseBill, "POST", "/", body, withParam("id", expenseID.String()))
}

func TestPurchaseBill_RecordAndGuards(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	exp := seedBankExpense(fx, "Bhatbhateni", 113000)
	base := map[string]any{
		"supplier_name": "Bhatbhateni Supermarket", "supplier_pan": "302222333", "supplier_bill_no": "BB-1001",
		"supplier_bill_date_bs": "2083-07-20", "taxable_cents": 100000, "vat_cents": 13000,
	}

	// Totals must match the expense.
	bad := cloneMap(base)
	bad["taxable_cents"], bad["vat_cents"] = 90000, 11700
	purchaseBill(t, fx, exp, bad).expectErr(409, "total_mismatch")
	// VAT that is not 13% must be confirmed, never silently fixed.
	off := cloneMap(base)
	off["taxable_cents"], off["vat_cents"] = 103000, 10000
	purchaseBill(t, fx, exp, off).expectErr(409, "vat_mismatch")
	// VAT without a supplier PAN is refused.
	nopan := cloneMap(base)
	nopan["supplier_pan"] = ""
	purchaseBill(t, fx, exp, nopan).expectErr(400, "vat_needs_pan")

	var b map[string]any
	purchaseBill(t, fx, exp, base).expectStatus(201).decode(&b)
	if b["fiscal_year"] != "2083/84" || b["supplier_bill_date"] != "2026-11-06" {
		t.Fatalf("bill = %v", b)
	}
	purchaseBill(t, fx, exp, base).expectErr(409, "already_recorded")

	// The same supplier bill cannot be booked again on another expense.
	exp2 := seedBankExpense(fx, "Bhatbhateni", 113000)
	purchaseBill(t, fx, exp2, base).expectErr(409, "duplicate_bill")

	// The expense is now part of the register.
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil, withParam("id", exp.String())).
		expectErr(409, "in_purchase_register")
	if err := fx.appExecErr(`UPDATE expenses SET amount_cents = 1 WHERE id = $1`, exp); err == nil {
		t.Error("register expense amount changed")
	}
	if _, err := adminPool.Exec(context.Background(), `UPDATE purchase_bills SET vat_cents = 0 WHERE expense_id = $1`, exp); err == nil {
		t.Error("purchase bill edited by superuser")
	}
}

func TestPurchaseReturn(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	exp := seedBankExpense(fx, "Dairy", 56500)
	var b struct {
		ID string `json:"id"`
	}
	purchaseBill(t, fx, exp, map[string]any{
		"supplier_name": "Dairy Co", "supplier_pan": "303333444", "supplier_bill_no": "D-9",
		"supplier_bill_date_bs": "2083-07-21", "taxable_cents": 50000, "vat_cents": 6500,
	}).expectStatus(201).decode(&b)

	ret := func(body map[string]any) *apiResp {
		return callHandler(t, fx, CreatePurchaseReturn, "POST", "/", body, withParam("id", b.ID))
	}
	var pr map[string]any
	ret(map[string]any{"reason": "sour milk", "taxable_cents": 20000, "vat_cents": 2600, "supplier_note_no": "DN-4"}).
		expectStatus(201).decode(&pr)
	if pr["number"] != "PR-1" || pr["total_cents"].(float64) != 22600 {
		t.Fatalf("return = %v", pr)
	}
	ret(map[string]any{"reason": "too much", "taxable_cents": 40000, "vat_cents": 5200}).expectErr(409, "over_return")
	ret(map[string]any{"taxable_cents": 100}).expectErr(400, "reason_required")
}

func TestPurchaseBill_OnlyForVATFiscalCafes(t *testing.T) {
	fx := newFiscalTenant(t, "pan")
	exp := seedBankExpense(fx, "X", 1000)
	purchaseBill(t, fx, exp, map[string]any{"supplier_name": "X", "supplier_bill_no": "1",
		"supplier_bill_date_bs": "2083-07-21", "exempt_cents": 1000}).expectErr(409, "not_vat_fiscal")
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
