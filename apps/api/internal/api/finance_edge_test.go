package api

// finance_edge_test.go — money-custody invariants and the owner-cash / house-tab
// guards that only fire in messy real bookkeeping: a full take→spend→return→
// deposit cycle, returning/deleting cash around a closed shift, and settling a
// house tab so the cash lands exactly once.

import (
	"testing"

	"github.com/google/uuid"
)

// The cardinal invariant: moving cafe cash between buckets (drawer ↔ owner-hand
// ↔ bank) never changes the TOTAL — only a real expense does. Walk one owner
// through take → spend → return → deposit and check the books at every step.
func TestOwnerCash_MultiStepHoldingInvariant(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(5000)
	alice := fx.finSeedOwner("Alice", 100)

	start := fx.cafeBalance(t)
	if start.TotalCents != 5000 || start.DrawerCents != 5000 {
		t.Fatalf("start drawer=%d total=%d, want 5000/5000", start.DrawerCents, start.TotalCents)
	}

	// 1) Take 3000 from the drawer → moves to Alice's hand, total unchanged.
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 3000}).expectStatus(201)
	s1 := fx.cafeBalance(t)
	if s1.DrawerCents != 2000 || s1.OwnerCashCents != 3000 || s1.TotalCents != 5000 {
		t.Fatalf("after take: drawer=%d owner=%d total=%d, want 2000/3000/5000",
			s1.DrawerCents, s1.OwnerCashCents, s1.TotalCents)
	}
	if h := fx.holdingFor(t, alice); h != 3000 {
		t.Fatalf("holding=%d, want 3000", h)
	}

	// 2) Spend 1000 of it on the cafe → real outflow, total drops by exactly 1000.
	callHandler(t, fx, CreateExpense, "POST", "/", map[string]any{
		"paid_from": "owner_cash", "owner_id": alice, "amount_cents": 1000, "vendor": "Mill",
	}).expectStatus(201)
	s2 := fx.cafeBalance(t)
	if s2.OwnerCashCents != 2000 || s2.TotalCents != 4000 {
		t.Fatalf("after spend: owner=%d total=%d, want 2000/4000", s2.OwnerCashCents, s2.TotalCents)
	}

	// 3) Return 500 to the drawer → total unchanged.
	callHandler(t, fx, CreateOwnerCashReturn(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 500}).expectStatus(201)
	s3 := fx.cafeBalance(t)
	if s3.DrawerCents != 2500 || s3.OwnerCashCents != 1500 || s3.TotalCents != 4000 {
		t.Fatalf("after return: drawer=%d owner=%d total=%d, want 2500/1500/4000",
			s3.DrawerCents, s3.OwnerCashCents, s3.TotalCents)
	}

	// 4) Deposit the remaining 1500 to the bank → owner clears, total unchanged.
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 1500, "reference_no": "SLIP-1"}).
		expectStatus(201)
	s4 := fx.cafeBalance(t)
	if s4.OwnerCashCents != 0 || s4.BankCents != 1500 || s4.TotalCents != 4000 {
		t.Fatalf("after deposit: owner=%d bank=%d total=%d, want 0/1500/4000",
			s4.OwnerCashCents, s4.BankCents, s4.TotalCents)
	}
	if h := fx.holdingFor(t, alice); h != 0 {
		t.Fatalf("final holding=%d, want 0", h)
	}
}

// Returning cash for an owner who doesn't exist is a 400, before any shift/holding
// work — a fat-fingered owner id shouldn't 500.
func TestOwnerCashReturn_UnknownOwner(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(5000)
	callHandler(t, fx, CreateOwnerCashReturn(testHub()), "POST", "/",
		map[string]any{"owner_id": uuid.New(), "amount_cents": 1000}).
		expectErr(400, "bad_request")
}

// Returning cash touches the drawer, so it needs an open shift. An owner can be
// holding cash from an earlier shift; once that shift closes, the return is
// blocked until a new shift opens.
func TestOwnerCashReturn_RequiresOpenShift(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	alice := fx.finSeedOwner("Alice", 100)
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 3000}).expectStatus(201)
	fx.closeShift(shiftID)

	callHandler(t, fx, CreateOwnerCashReturn(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 1000}).
		expectErr(409, "shift_required")
}

// A withdrawal is paired with a cash_drop. Once its shift closes, the drawer
// variance is stamped — deleting the withdrawal would corrupt it, so it's refused.
func TestOwnerCashDelete_WithdrawalAfterShiftClosed_Refused(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	alice := fx.finSeedOwner("Alice", 100)
	var created struct {
		ID string `json:"id"`
	}
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 3000}).
		expectStatus(201).decode(&created)
	fx.closeShift(shiftID)

	callHandler(t, fx, DeleteOwnerCashEntry(testHub()), "DELETE", "/", nil,
		withParam("id", created.ID)).expectErr(409, "shift_closed")
	// The withdrawal survives — holding unchanged.
	if h := fx.holdingFor(t, alice); h != 3000 {
		t.Fatalf("holding=%d, want 3000 (delete refused)", h)
	}
}

// A bank deposit never touches the drawer (no paired cash_drop, no shift), so it
// can be deleted to undo a mistaken deposit — returning the cash to the owner.
func TestOwnerCashDelete_DepositSucceeds(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	alice := fx.finSeedOwner("Alice", 100)
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 3000}).expectStatus(201)
	var dep struct {
		ID string `json:"id"`
	}
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), "POST", "/",
		map[string]any{"owner_id": alice, "amount_cents": 1000}).expectStatus(201).decode(&dep)
	if h := fx.holdingFor(t, alice); h != 2000 {
		t.Fatalf("holding after deposit=%d, want 2000", h)
	}

	callHandler(t, fx, DeleteOwnerCashEntry(testHub()), "DELETE", "/", nil,
		withParam("id", dep.ID)).expectStatus(204)
	if h := fx.holdingFor(t, alice); h != 3000 {
		t.Fatalf("holding after undo deposit=%d, want 3000 restored", h)
	}
	b := fx.cafeBalance(t)
	if b.BankCents != 0 {
		t.Fatalf("bank=%d, want 0 after deposit undone", b.BankCents)
	}
}

// Charging an order to a house tab is a receivable, not cash in hand — the
// drawer must not move until the tab is settled, and then it moves exactly once.
func TestHouseTab_ChargeThenSettle_MoneyMovesOnce(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(1000) // opening float = 1000
	tab := fx.seedHouseTab("StaffTab", true)

	htSeedCharge(fx, tab, 2000) // order charged to the tab

	// The charge is a receivable, NOT cash in hand: the drawer still shows only
	// the opening float.
	if d := fx.cafeBalance(t).DrawerCents; d != 1000 {
		t.Fatalf("drawer=%d, want 1000 (a house-tab charge is a receivable, not cash)", d)
	}

	// Settle the tab with cash — now (and only now) the drawer goes up by 2000.
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 2000, "payment_method": "cash"},
		withParam("id", tab.String())).expectStatus(201)
	if d := fx.cafeBalance(t).DrawerCents; d != 3000 {
		t.Fatalf("drawer=%d, want 3000 (1000 float + one 2000 settlement)", d)
	}

	// The tab is now fully paid: any further settlement is rejected as
	// overpayment. This proves the charge totalled exactly 2000 and the cash
	// moved once — without depending on the GetHouseTab read.
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 1, "payment_method": "cash"},
		withParam("id", tab.String())).expectErr(409, "overpayment")
}

// You must be able to pay down an archived (inactive) tab — settlement only
// gates on the tab existing, not on it being active.
func TestHouseTab_SettleInactiveTabSucceeds(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(1000)
	tab := fx.seedHouseTab("OldTab", true)
	htSeedCharge(fx, tab, 1000)
	fx.adminExec(`UPDATE house_tabs SET is_active = false WHERE id = $1`, tab)

	// Settling an archived (inactive) tab is allowed — it only gates on the tab
	// existing, not on it being active.
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 1000, "payment_method": "cash"},
		withParam("id", tab.String())).expectStatus(201)
	// Fully settled now: a further settlement overpays, confirming balance is 0.
	callHandler(t, fx, CreateHouseTabSettlement, "POST", "/",
		map[string]any{"amount_cents": 1, "payment_method": "cash"},
		withParam("id", tab.String())).expectErr(409, "overpayment")
}

// Depositing for a non-existent owner is a clean 400, not a 500.
func TestOwnerCashDeposit_UnknownOwner(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), "POST", "/",
		map[string]any{"owner_id": uuid.New(), "amount_cents": 1000}).
		expectErr(400, "bad_request")
}

// GetCafeSummary rolls up owner capital, outstanding loans, lifetime sales and
// expenses, and the cash-basis net profit. Seed one of each and check the math.
func TestCafeSummary_RollsUpLedgerRevenueAndProfit(t *testing.T) {
	fx := newTenant(t)
	alice := fx.finSeedOwner("Alice", 100)
	fx.finSeedInvestment(alice, 50000)
	fx.finSeedPayout(alice, 10000)
	loan := fx.finSeedLoanAdvance(alice, 5000, "advance")
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 2000}, withParam("id", loan.String())).expectStatus(201)

	rptSeedClosedOrder(fx, "Momo", 1, 4000, pastUTC(2)) // revenue 4000, no per-unit cost
	fx.rptSeedExpense("Rent", 1000, pastUTC(2))

	var s CafeSummary
	callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200).decode(&s)

	if s.LifetimeInvestedCents != 50000 {
		t.Fatalf("invested=%d, want 50000", s.LifetimeInvestedCents)
	}
	if s.LifetimePayoutsCents != 10000 {
		t.Fatalf("payouts=%d, want 10000", s.LifetimePayoutsCents)
	}
	if s.OutstandingLoansCents != 3000 {
		t.Fatalf("outstanding loans=%d, want 3000 (5000 advance − 2000 repaid)", s.OutstandingLoansCents)
	}
	if s.LifetimeRevenueCents != 4000 {
		t.Fatalf("revenue=%d, want 4000", s.LifetimeRevenueCents)
	}
	// Expenses include the 1000 rent AND the 5000 loan advance — a loan to an
	// owner is booked as an owner-paid expense (the loan_advance ledger row
	// requires an expense_id), so it flows into the lifetime expense bucket.
	if s.LifetimeExpensesCents != 6000 {
		t.Fatalf("expenses=%d, want 6000 (1000 rent + 5000 loan advance)", s.LifetimeExpensesCents)
	}
	// Net profit = revenue − direct COGS − all expenses = 4000 − 0 − 6000.
	if s.CafeNetProfitCents != -2000 {
		t.Fatalf("net profit=%d, want -2000", s.CafeNetProfitCents)
	}
}

// An account transfer just relabels money — the cafe total must be identical
// before and after, with the two channels shifted by the transfer amount.
func TestTransfer_KeepsTotalBalanceUnchanged(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(5000)

	before := fx.cafeBalance(t)
	callHandler(t, fx, CreateTransfer, "POST", "/",
		map[string]any{"from_method": "cash", "to_method": "bank", "amount_cents": 2000}).
		expectStatus(201)
	after := fx.cafeBalance(t)

	if after.TotalCents != before.TotalCents {
		t.Fatalf("total changed on transfer: %d → %d (must be conserved)",
			before.TotalCents, after.TotalCents)
	}
	if after.DrawerCents != before.DrawerCents-2000 {
		t.Fatalf("drawer=%d, want %d", after.DrawerCents, before.DrawerCents-2000)
	}
	if after.BankCents != before.BankCents+2000 {
		t.Fatalf("bank=%d, want %d", after.BankCents, before.BankCents+2000)
	}
}
