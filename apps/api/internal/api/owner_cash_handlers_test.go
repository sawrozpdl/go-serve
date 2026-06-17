package api

// Integration tests for owner cash custody (0034):
//   ListOwnerCash, CreateOwnerCashWithdrawal, CreateOwnerCashReturn,
//   CreateOwnerCashDeposit, DeleteOwnerCashEntry, and the owner_cash branch of
//   CreateExpense.
//
// Runs against the real local `cafe` Postgres under the app_user RLS pool, so
// the new GRANT on owner_cash_entries is exercised here (not just superuser).
//
// Core invariant under test: a withdrawal moves cash drawer → owner-hand and
// leaves total cafe assets unchanged; a bank deposit moves owner-hand → bank
// (also unchanged); a cafe expense paid from held cash reduces the total by
// exactly the expense amount.

import (
	"testing"

	"github.com/google/uuid"
)

type ownerCashListResp struct {
	Holdings []OwnerCashHolding `json:"holdings"`
	Entries  []OwnerCashEntry   `json:"entries"`
}

func (fx *fixture) ownerCashList(t *testing.T) ownerCashListResp {
	t.Helper()
	var out ownerCashListResp
	callHandler(t, fx, ListOwnerCash, "GET", "/", nil).expectStatus(200).decode(&out)
	return out
}

func (fx *fixture) holdingFor(t *testing.T, ownerID uuid.UUID) int64 {
	t.Helper()
	for _, h := range fx.ownerCashList(t).Holdings {
		if h.OwnerID == ownerID {
			return h.HoldingCents
		}
	}
	t.Fatalf("owner %s missing from holdings", ownerID)
	return 0
}

func (fx *fixture) cafeBalance(t *testing.T) CafeBalance {
	t.Helper()
	var b CafeBalance
	callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200).decode(&b)
	return b
}

func (fx *fixture) hasCafeExpenseEntry(t *testing.T) bool {
	t.Helper()
	for _, e := range fx.ownerCashList(t).Entries {
		if e.Kind == "cafe_expense" {
			return true
		}
	}
	return false
}

func TestOwnerCash_WithdrawalRequiresOpenShift(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Alice", 100)
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).
		expectErr(409, "shift_required")
}

func TestOwnerCash_WithdrawalMovesDrawerToHolding(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	before := fx.cafeBalance(t)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).
		expectStatus(201)

	after := fx.cafeBalance(t)
	if after.DrawerCents != before.DrawerCents-3000 {
		t.Fatalf("drawer = %d, want %d", after.DrawerCents, before.DrawerCents-3000)
	}
	if after.OwnerCashCents != 3000 {
		t.Fatalf("owner_cash = %d, want 3000", after.OwnerCashCents)
	}
	if after.TotalCents != before.TotalCents {
		t.Fatalf("total = %d, want unchanged %d", after.TotalCents, before.TotalCents)
	}
	if got := fx.holdingFor(t, owner); got != 3000 {
		t.Fatalf("holding = %d, want 3000", got)
	}
}

func TestOwnerCash_BankDepositMovesHoldingToBank(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).expectStatus(201)

	before := fx.cafeBalance(t)
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 2000, "reference_no": "slip-1"}).
		expectStatus(201)
	after := fx.cafeBalance(t)

	if after.BankCents != before.BankCents+2000 {
		t.Fatalf("bank = %d, want %d", after.BankCents, before.BankCents+2000)
	}
	if after.OwnerCashCents != 1000 {
		t.Fatalf("owner_cash = %d, want 1000", after.OwnerCashCents)
	}
	if after.TotalCents != before.TotalCents {
		t.Fatalf("total = %d, want unchanged %d", after.TotalCents, before.TotalCents)
	}
}

func TestOwnerCash_SpendOnCafeReducesHoldingAndTotal(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).expectStatus(201)

	before := fx.cafeBalance(t)
	// Spend held cash on the cafe — a real expense, paid_from='owner_cash'.
	callHandler(t, fx, CreateExpense, "POST", "/", map[string]any{
		"paid_from":    "owner_cash",
		"owner_id":     owner,
		"amount_cents": 1000,
		"vendor":       "Local Mill",
	}).expectStatus(201)
	after := fx.cafeBalance(t)

	if after.OwnerCashCents != 2000 {
		t.Fatalf("owner_cash = %d, want 2000", after.OwnerCashCents)
	}
	if after.TotalCents != before.TotalCents-1000 {
		t.Fatalf("total = %d, want %d (down by expense)", after.TotalCents, before.TotalCents-1000)
	}
	// Bank/drawer must NOT absorb an owner-cash expense.
	if after.BankCents != before.BankCents {
		t.Fatalf("bank moved on owner_cash expense: %d → %d", before.BankCents, after.BankCents)
	}
	if after.DrawerCents != before.DrawerCents {
		t.Fatalf("drawer moved on owner_cash expense: %d → %d", before.DrawerCents, after.DrawerCents)
	}
}

func TestOwnerCash_ReturnToDrawer(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).expectStatus(201)

	before := fx.cafeBalance(t)
	callHandler(t, fx, CreateOwnerCashReturn(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 1000}).expectStatus(201)
	after := fx.cafeBalance(t)

	if after.DrawerCents != before.DrawerCents+1000 {
		t.Fatalf("drawer = %d, want %d", after.DrawerCents, before.DrawerCents+1000)
	}
	if after.OwnerCashCents != 2000 {
		t.Fatalf("owner_cash = %d, want 2000", after.OwnerCashCents)
	}
	if after.TotalCents != before.TotalCents {
		t.Fatalf("total = %d, want unchanged %d", after.TotalCents, before.TotalCents)
	}
}

func TestOwnerCash_DeleteWithdrawalUndoesDrawerAndHolding(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	var created struct {
		ID string `json:"id"`
	}
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).
		expectStatus(201).decode(&created)

	callHandler(t, fx, DeleteOwnerCashEntry(testHub()), "DELETE", "/", nil,
		withParam("id", created.ID)).expectStatus(204)

	b := fx.cafeBalance(t)
	if b.OwnerCashCents != 0 {
		t.Fatalf("owner_cash = %d, want 0 after undo", b.OwnerCashCents)
	}
	if b.DrawerCents != 10000 {
		t.Fatalf("drawer = %d, want 10000 restored", b.DrawerCents)
	}
	// The paired cash_drop must be gone too.
	if n := fx.countRows("cash_drops"); n != 0 {
		t.Fatalf("cash_drops = %d, want 0 after undo", n)
	}
}

func TestOwnerCash_DeleteRefusesCafeExpenseEntry(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).expectStatus(201)
	callHandler(t, fx, CreateExpense, "POST", "/", map[string]any{
		"paid_from": "owner_cash", "owner_id": owner, "amount_cents": 1000, "vendor": "Mill",
	}).expectStatus(201)

	// Find the cafe_expense entry id from the ledger.
	var entryID string
	for _, e := range fx.ownerCashList(t).Entries {
		if e.Kind == "cafe_expense" {
			entryID = e.ID.String()
		}
	}
	if entryID == "" {
		t.Fatal("no cafe_expense entry found")
	}
	callHandler(t, fx, DeleteOwnerCashEntry(testHub()), "DELETE", "/", nil,
		withParam("id", entryID)).expectErr(409, "linked_to_expense")
}

// Deleting the underlying expense is the supported way to undo an owner cafe
// spend: it must cascade-remove the linked cafe_expense movement and restore
// both the owner's holding and the total balance. This locks in the fix for the
// "removed the expense but it stayed in Recent movements" report — the cascade
// was always correct server-side; the stale view was a frontend cache miss.
func TestOwnerCash_DeleteExpenseUndoesSpend(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).expectStatus(201)

	before := fx.cafeBalance(t)

	var exp struct {
		ID string `json:"id"`
	}
	callHandler(t, fx, CreateExpense, "POST", "/", map[string]any{
		"paid_from": "owner_cash", "owner_id": owner, "amount_cents": 1000, "vendor": "Mill",
	}).expectStatus(201).decode(&exp)
	if exp.ID == "" {
		t.Fatal("expense id missing from CreateExpense response")
	}

	// Spend recorded: holding dropped and a cafe_expense movement now exists.
	if got := fx.holdingFor(t, owner); got != 2000 {
		t.Fatalf("holding after spend = %d, want 2000", got)
	}
	if !fx.hasCafeExpenseEntry(t) {
		t.Fatal("expected a cafe_expense entry after owner_cash spend")
	}

	// Delete the expense — the movement must disappear and balances rewind.
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", exp.ID)).expectStatus(204)

	if fx.hasCafeExpenseEntry(t) {
		t.Fatal("cafe_expense entry survived expense delete — cascade missing")
	}
	if got := fx.holdingFor(t, owner); got != 3000 {
		t.Fatalf("holding after undo = %d, want 3000 restored", got)
	}
	after := fx.cafeBalance(t)
	if after.OwnerCashCents != 3000 {
		t.Fatalf("owner_cash = %d, want 3000 restored", after.OwnerCashCents)
	}
	if after.TotalCents != before.TotalCents {
		t.Fatalf("total = %d, want %d restored", after.TotalCents, before.TotalCents)
	}
}

func TestOwnerCash_DepositCannotExceedHolding(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 2000}).expectStatus(201)

	// Holding is 2000 — a 3000 deposit must be refused, and nothing should move.
	callHandler(t, fx, CreateOwnerCashDeposit(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).
		expectErr(409, "insufficient_holding")

	b := fx.cafeBalance(t)
	if b.OwnerCashCents != 2000 {
		t.Fatalf("owner_cash = %d, want 2000 (deposit rejected)", b.OwnerCashCents)
	}
	if b.BankCents != 0 {
		t.Fatalf("bank = %d, want 0 (deposit rejected)", b.BankCents)
	}
}

func TestOwnerCash_ReturnCannotExceedHolding(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 2000}).expectStatus(201)
	callHandler(t, fx, CreateOwnerCashReturn(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 5000}).
		expectErr(409, "insufficient_holding")
}

func TestOwnerCash_SpendCannotExceedHolding(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 2000}).expectStatus(201)
	// Spend more than held → refused; no expense row created.
	callHandler(t, fx, CreateExpense, "POST", "/", map[string]any{
		"paid_from": "owner_cash", "owner_id": owner, "amount_cents": 2500, "vendor": "Mill",
	}).expectErr(409, "insufficient_holding")

	if n := fx.countRows("expenses"); n != 0 {
		t.Fatalf("expenses = %d, want 0 (spend rejected)", n)
	}
	b := fx.cafeBalance(t)
	if b.OwnerCashCents != 2000 {
		t.Fatalf("owner_cash = %d, want 2000 unchanged", b.OwnerCashCents)
	}
}

func TestOwnerCash_WithdrawalUnknownOwner(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": uuid.New(), "amount_cents": 1000}).
		expectErr(400, "bad_request")
}
