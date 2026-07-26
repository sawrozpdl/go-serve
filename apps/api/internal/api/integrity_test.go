package api

// Regression tests for the data-integrity holes found in the accuracy audit.
// Each one pins a way the app could previously strand money: a figure that could
// never be corrected, a write that could never be reversed, or a frozen total
// that could silently stop matching the rows behind it.

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Post-close voids (orders.go VoidOrderItem)
// =========================================================================

// orders.total_cents is a frozen snapshot taken at close, and the close guard
// proves payments == total at that instant. Voiding a line afterwards would keep
// the frozen total while every line-level aggregate dropped the line — the two
// bases would disagree forever and the order would read as overpaid.
func TestVoidOrderItem_ClosedOrder_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("VoidCat")
	item := fx.seedMenuItem(cat, "VoidItem", 5000)
	line := fx.seedOrderItem(order, item, 1, 5000)
	fx.setOrderStatus(order, "closed")

	callHandler(t, fx, VoidOrderItem(testHub()), http.MethodPost, "/",
		map[string]any{"reason": "after the fact"},
		withParams(map[string]string{"id": order.String(), "itemId": line.String()})).
		expectErr(http.StatusConflict, "order_not_open")

	if ordItemVoidedAt(fx, line) != nil {
		t.Fatal("the line must not be voided on a closed order")
	}
}

func TestVoidOrderItem_CancelledOrder_Conflict(t *testing.T) {
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("VoidCat2")
	item := fx.seedMenuItem(cat, "VoidItem2", 2500)
	line := fx.seedOrderItem(order, item, 1, 2500)
	fx.setOrderStatus(order, "cancelled")

	callHandler(t, fx, VoidOrderItem(testHub()), http.MethodPost, "/",
		map[string]any{"reason": "nope"},
		withParams(map[string]string{"id": order.String(), "itemId": line.String()})).
		expectErr(http.StatusConflict, "order_not_open")
}

// The route is /orders/{id}/items/{itemId}/void, but the handler used to key its
// UPDATE on itemId alone — so a line could be voided through a different order's
// URL. RLS still confined it to the tenant, but the audit trail pointed at the
// wrong order.
func TestVoidOrderItem_WrongOrderInPath_NotFound(t *testing.T) {
	fx := newTenant(t)
	orderA := fx.seedOpenOrder(nil)
	orderB := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("VoidCat3")
	item := fx.seedMenuItem(cat, "VoidItem3", 1000)
	line := fx.seedOrderItem(orderA, item, 1, 1000)

	callHandler(t, fx, VoidOrderItem(testHub()), http.MethodPost, "/",
		map[string]any{"reason": ""},
		withParams(map[string]string{"id": orderB.String(), "itemId": line.String()})).
		expectErr(http.StatusNotFound, "not_found")

	if ordItemVoidedAt(fx, line) != nil {
		t.Fatal("the line must not be voided through another order's URL")
	}
}

// =========================================================================
// Deleting a payment out of a closed shift (payments.go DeletePayment)
// =========================================================================

// An order can stay open across a shift close. Removing one of its payments
// afterwards would invalidate the closing count the owner already reconciled
// and signed off — expected_cash_cents and variance_cents are stamped snapshots.
func TestDeletePayment_ClosedShift_Conflict(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(1000)
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("PayCat")
	item := fx.seedMenuItem(cat, "PayItem", 3000)
	fx.seedOrderItem(order, item, 1, 3000)
	payID := fx.seedPayment(order, "cash", 3000, ptrUUID(shift))
	fx.closeShift(shift)

	callHandler(t, fx, DeletePayment(testHub()), http.MethodDelete, "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": payID.String()})).
		expectErr(http.StatusConflict, "shift_closed")

	var still int
	fx.adminScan([]any{&still}, `SELECT count(*) FROM payments WHERE id = $1`, payID)
	if still != 1 {
		t.Fatal("the payment must survive — the closed shift's reconciliation is final")
	}
}

func TestDeletePayment_OpenShift_Succeeds(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(1000)
	order := fx.seedOpenOrder(nil)
	cat := fx.seedCategory("PayCat2")
	item := fx.seedMenuItem(cat, "PayItem2", 3000)
	fx.seedOrderItem(order, item, 1, 3000)
	payID := fx.seedPayment(order, "cash", 3000, ptrUUID(shift))

	callHandler(t, fx, DeletePayment(testHub()), http.MethodDelete, "/", nil,
		withParams(map[string]string{"id": order.String(), "paymentId": payID.String()})).
		expectStatus(http.StatusNoContent)
}

// =========================================================================
// Reversing a credit collection (house_tabs.go ReverseHouseTabSettlement)
// =========================================================================

// The settlement table was INSERT-only for the app role and CHECKs amount > 0,
// so a mis-entered collection could never be corrected: it permanently
// overstated the account it credited and understated the receivable.
func TestReverseSettlement_RestoresTabAndAccount(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Reversible", true)
	htSeedCharge(fx, tabID, 10000)

	var s HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 10000, "payment_method": "cash"},
		withParam("id", tabID.String())).
		expectStatus(http.StatusCreated).decode(&s)

	// Collected: tab square, cash holds the money.
	if got := htBalance(t, fx, tabID); got != 0 {
		t.Fatalf("tab balance after collecting = %d, want 0", got)
	}
	cash := accountByMethod(callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json(), "cash")
	if got := int64(cash["credit_collected_cents"].(float64)); got != 10000 {
		t.Fatalf("cash credit_collected = %d, want 10000", got)
	}

	// Reverse it: the customer owes it again and the cash goes back out.
	var rev HouseTabSettlement
	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "entered on the wrong tab"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": s.ID.String()})).
		expectStatus(http.StatusOK).decode(&rev)
	if rev.ReversedAt == nil {
		t.Fatal("reversed_at must be stamped on the returned row")
	}

	if got := htBalance(t, fx, tabID); got != 10000 {
		t.Fatalf("tab balance after reversing = %d, want 10000 (owed again)", got)
	}
	cash = accountByMethod(callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json(), "cash")
	if got := int64(cash["credit_collected_cents"].(float64)); got != 0 {
		t.Fatalf("cash credit_collected after reversing = %d, want 0", got)
	}
	if got := int64(cash["balance_cents"].(float64)); got != 0 {
		t.Fatalf("cash balance after reversing = %d, want 0", got)
	}

	// Both rows stay on file: the ledger shows what was entered and what undid it.
	var total int
	fx.adminScan([]any{&total},
		`SELECT count(*) FROM house_tab_settlements WHERE house_tab_id = $1`, tabID)
	if total != 1 {
		t.Fatalf("settlement rows = %d, want 1 (marked reversed, not deleted)", total)
	}
	d := callHandler(t, fx, GetHouseTab, http.MethodGet, "/", nil,
		withParam("id", tabID.String())).expectStatus(http.StatusOK).json()
	sets, _ := d["settlements"].([]any)
	if len(sets) != 1 {
		t.Fatalf("ledger settlements = %d, want 1 (the reversed row stays visible)", len(sets))
	}
	if row := sets[0].(map[string]any); row["reversed_at"] == nil {
		t.Fatal("the ledger row must expose reversed_at so the UI can mark it")
	}
}

// Reversing frees the balance up to be collected again — the whole point of the
// correction path.
func TestReverseSettlement_AllowsRecollecting(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Recollect", true)
	htSeedCharge(fx, tabID, 4000)

	var s HouseTabSettlement
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 4000, "payment_method": "cash"},
		withParam("id", tabID.String())).
		expectStatus(http.StatusCreated).decode(&s)
	// A second collection is refused while the first stands.
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 4000, "payment_method": "online"},
		withParam("id", tabID.String())).
		expectErr(http.StatusConflict, "overpayment")

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "wrong method"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": s.ID.String()})).
		expectStatus(http.StatusOK)

	// Now it can be re-entered correctly.
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 4000, "payment_method": "online"},
		withParam("id", tabID.String())).
		expectStatus(http.StatusCreated)
	if got := htBalance(t, fx, tabID); got != 0 {
		t.Fatalf("tab balance after re-collecting = %d, want 0", got)
	}
}

func TestReverseSettlement_RequiresReason(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("NeedsReason", true)
	htSeedCharge(fx, tabID, 2000)
	setID := htSeedSettlement(fx, tabID, "cash", 2000, nil)

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "   "},
		withParams(map[string]string{"id": tabID.String(), "settlementId": setID.String()})).
		expectErr(http.StatusBadRequest, "reason_required")
}

func TestReverseSettlement_TwiceIsConflict(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("DoubleReverse", true)
	htSeedCharge(fx, tabID, 2000)
	setID := htSeedSettlement(fx, tabID, "cash", 2000, nil)

	body := map[string]any{"reason": "duplicate entry"}
	params := map[string]string{"id": tabID.String(), "settlementId": setID.String()}
	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/", body,
		withParams(params)).expectStatus(http.StatusOK)
	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/", body,
		withParams(params)).expectErr(http.StatusConflict, "already_reversed")
}

// A reversed cash collection also leaves the shift's expected cash, so the
// drawer count the operator is about to make stays right.
func TestReverseSettlement_LeavesShiftExpectedCash(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(1000)
	tabID := fx.seedHouseTab("ShiftReverse", true)
	htSeedCharge(fx, tabID, 5000)
	setID := htSeedSettlement(fx, tabID, "cash", 5000, ptrUUID(shift))

	var s Shift
	callHandler(t, fx, GetCurrentShift, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).decode(&s)
	if s.LiveExpectedCashCents != 6000 {
		t.Fatalf("expected cash with the collection = %d, want 6000", s.LiveExpectedCashCents)
	}

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "mis-keyed"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": setID.String()})).
		expectStatus(http.StatusOK)

	callHandler(t, fx, GetCurrentShift, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).decode(&s)
	if s.LiveExpectedCashCents != 1000 {
		t.Fatalf("expected cash after reversing = %d, want 1000 (float only)", s.LiveExpectedCashCents)
	}
	if s.LiveTabSettlementsCashCents != 0 {
		t.Fatalf("credit-collected-in-cash after reversing = %d, want 0",
			s.LiveTabSettlementsCashCents)
	}
}

// A reversed collection is not credit collected on the day either.
func TestReverseSettlement_DropsOutOfDashboardCreditCollected(t *testing.T) {
	fx := newTenant(t)
	tabID := fx.seedHouseTab("DashReverse", true)
	creditSaleOn(fx, tabID, 7000, pastUTC(24*3))
	setID := htSeedSettlement(fx, tabID, "cash", 7000, nil)

	kpis := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).json()["kpis"].(map[string]any)
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 7000 {
		t.Fatalf("credit_collected before reversing = %d, want 7000", got)
	}

	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "customer disputed"},
		withParams(map[string]string{"id": tabID.String(), "settlementId": setID.String()})).
		expectStatus(http.StatusOK)

	kpis = callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=today")).expectStatus(http.StatusOK).json()["kpis"].(map[string]any)
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 0 {
		t.Fatalf("credit_collected after reversing = %d, want 0", got)
	}
	// And the sale it was collected against is untouched.
	if got := int64(kpis["sales_cents"].(float64)); got != 0 {
		t.Fatalf("today's sales = %d, want 0 — the serve closed three days ago", got)
	}
}

// =========================================================================
// Owner cash custody (finance.go DeleteOwnerCashEntry)
// =========================================================================

// Deleting a withdrawal after part of it was banked used to drive the holding
// negative while the drawer and the bank both kept their money — overstating the
// cafe total by the deposited amount.
func TestDeleteOwnerCashWithdrawal_AfterDeposit_Conflict(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("CustodyGuard", 100)

	var withdrawal struct {
		ID uuid.UUID `json:"id"`
	}
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 5000}).
		expectStatus(http.StatusCreated).decode(&withdrawal)
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 4000}).
		expectStatus(http.StatusCreated)

	callHandler(t, fx, DeleteOwnerCashEntry(testHub()), http.MethodDelete, "/", nil,
		withParam("id", withdrawal.ID.String())).
		expectErr(http.StatusConflict, "holding_would_go_negative")

	if held := fx.holdingFor(t, owner); held != 1000 {
		t.Fatalf("holding = %d, want 1000 — the delete must not have landed", held)
	}
}

// The clean case still works: nothing has been drawn against the withdrawal.
func TestDeleteOwnerCashWithdrawal_Untouched_Succeeds(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("CustodyClean", 100)

	var withdrawal struct {
		ID uuid.UUID `json:"id"`
	}
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), http.MethodPost, "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 5000}).
		expectStatus(http.StatusCreated).decode(&withdrawal)

	callHandler(t, fx, DeleteOwnerCashEntry(testHub()), http.MethodDelete, "/", nil,
		withParam("id", withdrawal.ID.String())).
		expectStatus(http.StatusNoContent)
	if held := fx.holdingFor(t, owner); held != 0 {
		t.Fatalf("holding = %d, want 0", held)
	}
}

// =========================================================================
// Owner-paid expenses (accounts.go / finance.go bucket terms)
// =========================================================================

// An expense the owner paid from their own pocket books a loan the cafe owes
// them. No cafe account moved, so debiting one would count the same rupee twice:
// once against the drawer, once as a liability.
func TestOwnerPaidExpense_DoesNotDebitCashBucket(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("PocketPayer", 100)

	before := accountByMethod(callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json(), "cash")
	beforeCash := int64(before["balance_cents"].(float64))

	callHandler(t, fx, CreateExpense, http.MethodPost, "/",
		map[string]any{
			"vendor": "Hardware shop", "amount_cents": 2500,
			"paid_from": "owner", "owner_id": owner.String(),
		}).expectStatus(http.StatusCreated)

	after := accountByMethod(callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json(), "cash")
	if got := int64(after["balance_cents"].(float64)); got != beforeCash {
		t.Fatalf("cash balance moved by %d — an owner-paid expense must not touch a cafe account",
			got-beforeCash)
	}
	if got := int64(after["expenses_cents"].(float64)); got != 0 {
		t.Fatalf("cash bucket expenses = %d, want 0", got)
	}
	// It is still a real cost, and still owed to the owner.
	if got := fx.finOwnerOutstandingLoans(owner); got != 2500 {
		t.Fatalf("outstanding loan to the owner = %d, want 2500", got)
	}
	var s CafeSummary
	callHandler(t, fx, GetCafeSummary, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).decode(&s)
	if s.LifetimeExpensesCents != 2500 {
		t.Fatalf("lifetime expenses = %d, want 2500 — it belongs in P&L", s.LifetimeExpensesCents)
	}
}

// =========================================================================
// Transfer fees (accounts.go CreateTransfer)
// =========================================================================

// The fee is charged to the source account, so when cash is the source the till
// gives up amount + fee. The paired cash_drop used to record only the amount, so
// the drawer and the cash bucket disagreed by the fee and the shift closed with
// a phantom overage.
func TestTransferFee_DrawerAndBucketAgree(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(10000)

	callHandler(t, fx, CreateTransfer, http.MethodPost, "/",
		map[string]any{
			"from_method": "cash", "to_method": "bank",
			"amount_cents": 2000, "fee_cents": 50,
		}).expectStatus(http.StatusCreated)

	// Bucket: cash out = amount + fee.
	cash := accountByMethod(callHandler(t, fx, GetAccountBalances, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).json(), "cash")
	if got := int64(cash["transfers_out_cents"].(float64)); got != 2050 {
		t.Fatalf("cash transfers_out = %d, want 2050", got)
	}

	// Drawer: the paired drop must match, so expected cash agrees.
	var dropAmount int64
	fx.adminScan([]any{&dropAmount}, `
		SELECT amount_cents FROM cash_drops
		WHERE shift_id = $1 AND kind = 'transfer'`, shift)
	if dropAmount != 2050 {
		t.Fatalf("paired cash drop = %d, want 2050 — the drawer must lose the fee too", dropAmount)
	}

	var s Shift
	callHandler(t, fx, GetCurrentShift, http.MethodGet, "/", nil).
		expectStatus(http.StatusOK).decode(&s)
	if s.LiveExpectedCashCents != 10000-2050 {
		t.Fatalf("expected cash = %d, want %d", s.LiveExpectedCashCents, 10000-2050)
	}
}

func TestTransferFee_CannotExceedAmount(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	callHandler(t, fx, CreateTransfer, http.MethodPost, "/",
		map[string]any{
			"from_method": "cash", "to_method": "bank",
			"amount_cents": 1000, "fee_cents": 1000,
		}).expectErr(http.StatusBadRequest, "bad_request")
}

// =========================================================================
// Payroll ↔ expense symmetry (staff.go / expenses.go)
// =========================================================================

// reverseExpense can legitimately refuse (closed shift for a drawer-paid
// salary). The tx policy commits on 4xx, so the refusal used to leave payroll
// deleted with the salary expense still standing — money out of the drawer with
// no payroll record.
func TestDeleteStaffPay_RefusedReversal_LeavesBothRows(t *testing.T) {
	fx := newTenant(t)
	shift := fx.seedOpenShift(50000)
	staffID := fx.staffSeedMember("Ramesh", "active")

	var pay StaffPay
	callHandler(t, fx, CreateStaffPay, http.MethodPost, "/",
		map[string]any{
			"paid_on": "2026-05-31", "amount": 200,
			"paid_from": "drawer", "period_label": "Shrawan",
		}, withParam("id", staffID.String())).
		expectStatus(http.StatusCreated).decode(&pay)

	// Close the shift the salary was paid from: reversal is now refused.
	fx.closeShift(shift)

	callHandler(t, fx, DeleteStaffPay, http.MethodDelete, "/", nil,
		withParams(map[string]string{"id": staffID.String(), "payId": pay.ID.String()})).
		expectErr(http.StatusConflict, "shift_closed")

	// Neither side may have moved.
	var payAlive, expenseAlive int
	fx.adminScan([]any{&payAlive},
		`SELECT count(*) FROM staff_pay WHERE id = $1 AND deleted_at IS NULL`, pay.ID)
	// Reach the expense through the payroll row, not by matching an amount:
	// adminScan runs as the superuser and so sees EVERY tenant, and a Rs 200
	// expense in some other cafe in the dev database made this count 2.
	fx.adminScan([]any{&expenseAlive}, `
		SELECT count(*) FROM expenses e
		JOIN staff_pay sp ON sp.expense_id = e.id
		WHERE sp.id = $1 AND e.deleted_at IS NULL
	`, pay.ID)
	if payAlive != 1 {
		t.Fatal("the payroll row must survive a refused reversal")
	}
	if expenseAlive != 1 {
		t.Fatal("the salary expense must survive a refused reversal")
	}
}

// Deleting the salary expense retires its payroll row, so payroll never reports
// a payment with no expense behind it.
func TestDeleteExpense_RetiresLinkedStaffPay(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(50000)
	staffID := fx.staffSeedMember("Sita", "active")

	var pay StaffPay
	callHandler(t, fx, CreateStaffPay, http.MethodPost, "/",
		map[string]any{
			"paid_on": "2026-05-31", "amount": 150,
			"paid_from": "bank", "period_label": "Bhadra",
		}, withParam("id", staffID.String())).
		expectStatus(http.StatusCreated).decode(&pay)

	var expenseID uuid.UUID
	fx.adminScan([]any{&expenseID}, `SELECT expense_id FROM staff_pay WHERE id = $1`, pay.ID)

	callHandler(t, fx, DeleteExpense, http.MethodDelete, "/", nil,
		withParam("id", expenseID.String())).
		expectStatus(http.StatusNoContent)

	var payAlive int
	fx.adminScan([]any{&payAlive},
		`SELECT count(*) FROM staff_pay WHERE id = $1 AND deleted_at IS NULL`, pay.ID)
	if payAlive != 0 {
		t.Fatal("the payroll row must be retired with its expense")
	}
}

// htBalance reads a tab's outstanding balance through the handler, so the test
// exercises the same roll-up the UI sees.
func htBalance(t *testing.T, fx *fixture, tabID uuid.UUID) int64 {
	t.Helper()
	d := callHandler(t, fx, GetHouseTab, http.MethodGet, "/", nil,
		withParam("id", tabID.String())).expectStatus(http.StatusOK).json()
	return int64(d["house_tab"].(map[string]any)["balance_cents"].(float64))
}
