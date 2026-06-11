package api

// Integration tests for finance.go handlers:
//   GetCafeBalance, GetCafeSummary,
//   ListCafeOwners, CreateCafeOwner, UpdateCafeOwner, DeactivateCafeOwner,
//   ListOwnerLedger, CorrectOwnerLedger,
//   CreateInvestment, CreatePayouts, RepayLoan
//
// Runs against the real local `cafe` Postgres database under the app_user RLS
// pool — missing GRANTs therefore surface here, not just in superuser tests.

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Finance-scoped seed helpers (prefix: finSeed*)
// =========================================================================

// finSeedOwner inserts a bare cafe_owner row (no linked user).
func (fx *fixture) finSeedOwner(displayName string, shareUnits int) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO cafe_owners (tenant_id, display_name, share_units)
		 VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, displayName, shareUnits)
	return id
}

// finSeedOwnerLinked inserts a cafe_owner row linked to an existing user.
func (fx *fixture) finSeedOwnerLinked(displayName string, shareUnits int, userID uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO cafe_owners (tenant_id, display_name, share_units, user_id)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		fx.Tenant, displayName, shareUnits, userID)
	return id
}

// finSeedInvestment inserts an owner_ledger investment row directly (admin pool).
func (fx *fixture) finSeedInvestment(ownerID uuid.UUID, amountCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO owner_ledger
		   (tenant_id, owner_id, kind, amount_cents, notes, created_by_user_id)
		 VALUES ($1, $2, 'investment'::owner_ledger_kind, $3, '', $4)
		 RETURNING id`,
		fx.Tenant, ownerID, amountCents, fx.User)
	return id
}

// finSeedPayout inserts an owner_ledger payout row directly (admin pool).
func (fx *fixture) finSeedPayout(ownerID uuid.UUID, amountCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO owner_ledger
		   (tenant_id, owner_id, kind, amount_cents, notes, created_by_user_id)
		 VALUES ($1, $2, 'payout'::owner_ledger_kind, $3, '', $4)
		 RETURNING id`,
		fx.Tenant, ownerID, amountCents, fx.User)
	return id
}

// finSeedLoanAdvance inserts an owner expense and its linked loan_advance ledger
// row. Returns the loan_advance ledger id (not the expense id) since RepayLoan
// takes the ledger row id.
func (fx *fixture) finSeedLoanAdvance(ownerID uuid.UUID, amountCents int64, notes string) uuid.UUID {
	fx.t.Helper()
	// An expense row is required because of the CHECK constraint:
	//   kind='loan_advance' requires expense_id IS NOT NULL.
	// We reuse the same pattern as expSeedOwnerExpense.
	var expID uuid.UUID
	fx.adminScan([]any{&expID}, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, payment_method, paid_from, owner_id, recorded_by_user_id)
		VALUES ($1, 'loan-vendor', $2, 'cash'::payment_method, 'owner'::expense_source, $3, $4)
		RETURNING id`,
		fx.Tenant, amountCents, ownerID, fx.User)

	var loanID uuid.UUID
	fx.adminScan([]any{&loanID}, `
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, expense_id, notes, created_by_user_id)
		VALUES ($1, $2, 'loan_advance'::owner_ledger_kind, $3, $4, $5, $6)
		RETURNING id`,
		fx.Tenant, ownerID, amountCents, expID, notes, fx.User)
	return loanID
}

// finDeactivateOwner stamps active_to=today (admin pool) — simulates deactivation.
func (fx *fixture) finDeactivateOwner(ownerID uuid.UUID) {
	fx.t.Helper()
	fx.adminExec(`UPDATE cafe_owners SET active_to = CURRENT_DATE WHERE id = $1`, ownerID)
}

// finOwnerLedgerCount returns total owner_ledger rows for the fixture tenant.
func (fx *fixture) finOwnerLedgerCount() int {
	fx.t.Helper()
	return fx.countRows("owner_ledger")
}

// finGetOwnerLedgerEntry reads one ledger row by id via admin pool.
func (fx *fixture) finGetOwnerLedgerEntry(id uuid.UUID) (kind string, amount int64, isCorrection bool, correctsID *uuid.UUID) {
	fx.t.Helper()
	fx.adminScan([]any{&kind, &amount, &isCorrection, &correctsID},
		`SELECT kind::text, amount_cents, is_correction, corrects_id FROM owner_ledger WHERE id = $1`, id)
	return
}

// finOwnerOutstandingLoans computes outstanding loan balance for an owner (admin pool).
func (fx *fixture) finOwnerOutstandingLoans(ownerID uuid.UUID) int64 {
	fx.t.Helper()
	var v int64
	// NOTE: two scalar subqueries, NOT a join — a LEFT JOIN to repayments
	// fans out one advance row per repayment and double-counts the advance.
	fx.adminScan([]any{&v}, `
		SELECT COALESCE((
		         SELECT SUM(amount_cents) FROM owner_ledger
		         WHERE owner_id = $1 AND kind = 'loan_advance' AND is_correction = false
		       ), 0)::bigint
		     - COALESCE((
		         SELECT SUM(amount_cents) FROM owner_ledger
		         WHERE kind = 'loan_repayment' AND parent_loan_id IN (
		           SELECT id FROM owner_ledger
		           WHERE owner_id = $1 AND kind = 'loan_advance' AND is_correction = false
		         )
		       ), 0)::bigint`,
		ownerID)
	return v
}

// =========================================================================
// GetCafeBalance
// =========================================================================

func TestGetCafeBalance_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).
		expectStatus(200)
	var b CafeBalance
	r.decode(&b)
	if b.DrawerSource != "none" {
		t.Fatalf("drawer_source = %q, want none", b.DrawerSource)
	}
	if b.DrawerCents != 0 {
		t.Fatalf("drawer_cents = %d, want 0", b.DrawerCents)
	}
	if b.BankCents != 0 {
		t.Fatalf("bank_cents = %d, want 0", b.BankCents)
	}
	if b.TotalCents != 0 {
		t.Fatalf("total_cents = %d, want 0", b.TotalCents)
	}
	if b.Channels == nil {
		t.Fatalf("channels should be non-nil slice")
	}
}

func TestGetCafeBalance_LiveDrawerFromOpenShift(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(5000)
	r := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).
		expectStatus(200)
	var b CafeBalance
	r.decode(&b)
	if b.DrawerSource != "live" {
		t.Fatalf("drawer_source = %q, want live", b.DrawerSource)
	}
	// No cash payments yet — drawer = opening float.
	if b.DrawerCents != 5000 {
		t.Fatalf("drawer_cents = %d, want 5000", b.DrawerCents)
	}
	if b.DrawerAsOf == nil {
		t.Fatalf("drawer_as_of should be populated for live source")
	}
}

func TestGetCafeBalance_LastCloseAfterShiftClosed(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(3000)
	// Stamp closing count.
	fx.adminExec(`UPDATE shifts SET closed_at = now(), closing_count_cents = 7500,
	              closed_by_user_id = $2 WHERE id = $1`, shiftID, fx.User)
	r := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).
		expectStatus(200)
	var b CafeBalance
	r.decode(&b)
	if b.DrawerSource != "last_close" {
		t.Fatalf("drawer_source = %q, want last_close", b.DrawerSource)
	}
	if b.DrawerCents != 7500 {
		t.Fatalf("drawer_cents = %d, want 7500", b.DrawerCents)
	}
}

func TestGetCafeBalance_BankChangesWithInvestment(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Alice", 100)

	r0 := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b0 CafeBalance
	r0.decode(&b0)

	// Record an investment.
	fx.finSeedInvestment(owner, 50000)

	r1 := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b1 CafeBalance
	r1.decode(&b1)

	if b1.BankCents-b0.BankCents != 50000 {
		t.Fatalf("bank_cents delta = %d, want 50000", b1.BankCents-b0.BankCents)
	}
	if b1.TotalCents-b0.TotalCents != 50000 {
		t.Fatalf("total_cents delta = %d, want 50000", b1.TotalCents-b0.TotalCents)
	}
}

func TestGetCafeBalance_BankDecreasesWithPayout(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Bob", 100)
	fx.finSeedInvestment(owner, 100000)
	fx.finSeedPayout(owner, 30000)

	r := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b CafeBalance
	r.decode(&b)
	// bank = +100000 (investment) − 30000 (payout) = 70000
	if b.BankCents != 70000 {
		t.Fatalf("bank_cents = %d, want 70000", b.BankCents)
	}
}

func TestGetCafeBalance_OutstandingLoansPopulated(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Carol", 100)
	fx.finSeedLoanAdvance(owner, 20000, "advance1")

	r := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b CafeBalance
	r.decode(&b)
	if b.Outstanding.LoansCents != 20000 {
		t.Fatalf("outstanding.loans_cents = %d, want 20000", b.Outstanding.LoansCents)
	}
}

func TestGetCafeBalance_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	owner := fx2.finSeedOwner("Other", 50)
	fx2.finSeedInvestment(owner, 999999)

	r := callHandler(t, fx1, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b CafeBalance
	r.decode(&b)
	// fx1 should not see fx2's investment.
	if b.BankCents != 0 {
		t.Fatalf("bank_cents = %d, want 0 (isolation failure)", b.BankCents)
	}
}

// =========================================================================
// GetCafeSummary
// =========================================================================

func TestGetCafeSummary_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetCafeSummary, "GET", "/", nil).
		expectStatus(200)
	var s CafeSummary
	r.decode(&s)
	if s.LifetimeInvestedCents != 0 {
		t.Fatalf("lifetime_invested_cents = %d, want 0", s.LifetimeInvestedCents)
	}
	if s.LifetimePayoutsCents != 0 {
		t.Fatalf("lifetime_payouts_cents = %d, want 0", s.LifetimePayoutsCents)
	}
	if s.OutstandingLoansCents != 0 {
		t.Fatalf("outstanding_loans_cents = %d, want 0", s.OutstandingLoansCents)
	}
	if s.CafeNetProfitCents != 0 {
		t.Fatalf("cafe_net_profit_cents = %d, want 0", s.CafeNetProfitCents)
	}
}

func TestGetCafeSummary_InvestmentAndPayoutAccounted(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Dave", 100)
	fx.finSeedInvestment(owner, 80000)
	fx.finSeedPayout(owner, 20000)

	r := callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200)
	var s CafeSummary
	r.decode(&s)

	if s.LifetimeInvestedCents != 80000 {
		t.Fatalf("lifetime_invested_cents = %d, want 80000", s.LifetimeInvestedCents)
	}
	if s.LifetimePayoutsCents != 20000 {
		t.Fatalf("lifetime_payouts_cents = %d, want 20000", s.LifetimePayoutsCents)
	}
}

func TestGetCafeSummary_OutstandingLoansReflected(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Eve", 100)
	loanID := fx.finSeedLoanAdvance(owner, 15000, "rent advance")
	// Partially repay: seed loan_repayment row.
	fx.adminExec(`
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, parent_loan_id, notes, created_by_user_id)
		VALUES ($1, $2, 'loan_repayment', 5000, $3, 'partial', $4)`,
		fx.Tenant, owner, loanID, fx.User)

	r := callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200)
	var s CafeSummary
	r.decode(&s)
	if s.OutstandingLoansCents != 10000 {
		t.Fatalf("outstanding_loans_cents = %d, want 10000 (15000−5000)", s.OutstandingLoansCents)
	}
}

// Regression: outstanding-loan math must not fan out when ONE loan has
// MULTIPLE repayments. A LEFT JOIN that sums advance and repayments in the
// same aggregate double-counts the advance per repayment row (15000 was
// counted once per repayment → wildly wrong). With 2 repayments the correct
// outstanding is 15000 − 4000 − 6000 = 5000. This exercises GetCafeSummary,
// GetCafeBalance, and the per-owner roll-up in ListCafeOwners.
func TestOutstandingLoans_MultipleRepaymentsNoFanout(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Multi", 100)
	loanID := fx.finSeedLoanAdvance(owner, 15000, "advance")
	for _, amt := range []int64{4000, 6000} {
		callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
			map[string]any{"amount_cents": amt}, withParam("id", loanID.String())).
			expectStatus(201)
	}

	// GetCafeSummary (all-owners aggregate).
	var s CafeSummary
	callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200).decode(&s)
	if s.OutstandingLoansCents != 5000 {
		t.Fatalf("summary outstanding = %d, want 5000", s.OutstandingLoansCents)
	}

	// GetCafeBalance (all-owners aggregate).
	var b CafeBalance
	callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200).decode(&b)
	if b.Outstanding.LoansCents != 5000 {
		t.Fatalf("balance outstanding = %d, want 5000", b.Outstanding.LoansCents)
	}

	// ListCafeOwners (per-owner roll-up).
	var lst struct {
		Owners []CafeOwner `json:"owners"`
	}
	callHandler(t, fx, ListCafeOwners, "GET", "/", nil).expectStatus(200).decode(&lst)
	var found bool
	for _, o := range lst.Owners {
		if o.ID == owner {
			found = true
			if o.OutstandingLoansCents != 5000 {
				t.Fatalf("owner roll-up outstanding = %d, want 5000", o.OutstandingLoansCents)
			}
		}
	}
	if !found {
		t.Fatal("owner not returned by ListCafeOwners")
	}
}

func TestGetCafeSummary_NetProfitFromClosedOrders(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Coffee", 5000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 5000) // revenue 10000
	// Close the order.
	fx.setOrderStatus(order, "closed")

	r := callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200)
	var s CafeSummary
	r.decode(&s)
	if s.LifetimeRevenueCents != 10000 {
		t.Fatalf("lifetime_revenue_cents = %d, want 10000", s.LifetimeRevenueCents)
	}
	// No cost seeded so net = revenue.
	if s.CafeNetProfitCents != 10000-s.LifetimeExpensesCents {
		t.Fatalf("cafe_net_profit_cents = %d, want %d", s.CafeNetProfitCents,
			10000-s.LifetimeExpensesCents)
	}
}

func TestGetCafeSummary_OpenOrderRevenueExcluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Tea", 3000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 3000)
	// Order left open — should not appear in revenue.

	r := callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200)
	var s CafeSummary
	r.decode(&s)
	if s.LifetimeRevenueCents != 0 {
		t.Fatalf("lifetime_revenue_cents = %d, want 0 (order still open)", s.LifetimeRevenueCents)
	}
}

// =========================================================================
// ListCafeOwners
// =========================================================================

func TestListCafeOwners_EmptyTenant(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListCafeOwners, "GET", "/", nil).
		expectStatus(200)
	m := r.json()
	owners, _ := m["owners"].([]any)
	if len(owners) != 0 {
		t.Fatalf("owners = %d, want 0", len(owners))
	}
}

func TestListCafeOwners_ReturnsAllIncludingInactive(t *testing.T) {
	fx := newTenant(t)
	fx.finSeedOwner("Active", 100)
	inactive := fx.finSeedOwner("Inactive", 50)
	fx.finDeactivateOwner(inactive)

	r := callHandler(t, fx, ListCafeOwners, "GET", "/", nil).
		expectStatus(200)
	m := r.json()
	owners, _ := m["owners"].([]any)
	if len(owners) != 2 {
		t.Fatalf("owners = %d, want 2", len(owners))
	}
}

func TestListCafeOwners_ActiveOnlyFilter(t *testing.T) {
	fx := newTenant(t)
	fx.finSeedOwner("Active", 100)
	inactive := fx.finSeedOwner("Inactive", 50)
	fx.finDeactivateOwner(inactive)

	r := callHandler(t, fx, ListCafeOwners, "GET", "/", nil,
		withQuery("active=true")).
		expectStatus(200)
	m := r.json()
	owners, _ := m["owners"].([]any)
	if len(owners) != 1 {
		t.Fatalf("active owners = %d, want 1", len(owners))
	}
}

func TestListCafeOwners_RollUpsPopulated(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Fiona", 100)
	fx.finSeedInvestment(owner, 60000)
	fx.finSeedPayout(owner, 10000)

	r := callHandler(t, fx, ListCafeOwners, "GET", "/", nil).expectStatus(200)
	m := r.json()
	owners, _ := m["owners"].([]any)
	if len(owners) != 1 {
		t.Fatalf("owners = %d, want 1", len(owners))
	}
	o, _ := owners[0].(map[string]any)
	if got := int64(o["lifetime_investment_cents"].(float64)); got != 60000 {
		t.Fatalf("lifetime_investment_cents = %d, want 60000", got)
	}
	if got := int64(o["lifetime_payouts_cents"].(float64)); got != 10000 {
		t.Fatalf("lifetime_payouts_cents = %d, want 10000", got)
	}
}

func TestListCafeOwners_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx2.finSeedOwner("OtherTenant", 100)

	r := callHandler(t, fx1, ListCafeOwners, "GET", "/", nil).expectStatus(200)
	m := r.json()
	owners, _ := m["owners"].([]any)
	if len(owners) != 0 {
		t.Fatalf("owners = %d, want 0 (isolation failure)", len(owners))
	}
}

// =========================================================================
// CreateCafeOwner
// =========================================================================

func TestCreateCafeOwner_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateCafeOwner_MissingDisplayName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"share_units": 100}).
		expectErr(400, "bad_request")
}

func TestCreateCafeOwner_BlankDisplayName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "  ", "share_units": 100}).
		expectErr(400, "bad_request")
}

func TestCreateCafeOwner_ZeroShareUnits(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Greg", "share_units": 0}).
		expectErr(400, "bad_request")
}

func TestCreateCafeOwner_NegativeShareUnits(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Greg", "share_units": -5}).
		expectErr(400, "bad_request")
}

func TestCreateCafeOwner_UserNotActiveMember(t *testing.T) {
	fx := newTenant(t)
	// A user that exists but is NOT a member of this tenant.
	var foreignUserID uuid.UUID
	fx.adminScan([]any{&foreignUserID},
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"foreigner@test.local", "Foreigner")
	fx.t.Cleanup(func() {
		fx.adminExec(`DELETE FROM users WHERE id = $1`, foreignUserID)
	})
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Greg", "share_units": 10, "user_id": foreignUserID.String()}).
		expectErr(400, "bad_request")
}

func TestCreateCafeOwner_DuplicateUserOwner(t *testing.T) {
	fx := newTenant(t)
	// fx.User is already an active member — link them to an owner.
	fx.finSeedOwnerLinked("First", 100, fx.User)
	// Creating a second active owner with the same user_id should hit the unique partial index.
	callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Second", "share_units": 50, "user_id": fx.User.String()}).
		expectErr(409, "owner_exists")
}

func TestCreateCafeOwner_SuccessNoUser(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Hana", "share_units": 200, "notes": "silent partner"}).
		expectStatus(201)
	var o CafeOwner
	r.decode(&o)
	if o.DisplayName != "Hana" {
		t.Fatalf("display_name = %q, want Hana", o.DisplayName)
	}
	if o.ShareUnits != 200 {
		t.Fatalf("share_units = %d, want 200", o.ShareUnits)
	}
	if o.UserID != nil {
		t.Fatalf("user_id should be nil for unlinked owner")
	}
	if o.ActiveTo != nil {
		t.Fatalf("active_to should be nil for new owner")
	}
	if fx.countRows("cafe_owners") != 1 {
		t.Fatalf("cafe_owners count != 1")
	}
}

func TestCreateCafeOwner_SuccessWithLinkedUser(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Ian", "share_units": 50, "user_id": fx.User.String()}).
		expectStatus(201)
	var o CafeOwner
	r.decode(&o)
	if o.UserID == nil || *o.UserID != fx.User {
		t.Fatalf("user_id = %v, want %v", o.UserID, fx.User)
	}
}

func TestCreateCafeOwner_ActiveFromIsToday(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Jess", "share_units": 10}).
		expectStatus(201)
	var o CafeOwner
	r.decode(&o)
	today := time.Now().UTC().Format("2006-01-02")
	if o.ActiveFrom != today {
		t.Fatalf("active_from = %q, want %q", o.ActiveFrom, today)
	}
}

// =========================================================================
// UpdateCafeOwner
// =========================================================================

func TestUpdateCafeOwner_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"share_units": 100}, withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateCafeOwner_BadJSON(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Kyle", 100)
	callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/", "{bad",
		withParam("id", owner.String())).
		expectErr(400, "bad_request")
}

func TestUpdateCafeOwner_ZeroShareUnits(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Laura", 100)
	callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"share_units": 0}, withParam("id", owner.String())).
		expectErr(400, "bad_request")
}

func TestUpdateCafeOwner_NegativeShareUnits(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Laura", 100)
	callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"share_units": -1}, withParam("id", owner.String())).
		expectErr(400, "bad_request")
}

func TestUpdateCafeOwner_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"share_units": 10}, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateCafeOwner_UpdateDisplayName(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("OldName", 100)
	r := callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"display_name": "NewName"}, withParam("id", owner.String())).
		expectStatus(200)
	var o CafeOwner
	r.decode(&o)
	if o.DisplayName != "NewName" {
		t.Fatalf("display_name = %q, want NewName", o.DisplayName)
	}
	// share_units unchanged.
	if o.ShareUnits != 100 {
		t.Fatalf("share_units = %d, want 100", o.ShareUnits)
	}
}

func TestUpdateCafeOwner_UpdateShareUnits(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Mike", 50)
	r := callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"share_units": 75}, withParam("id", owner.String())).
		expectStatus(200)
	var o CafeOwner
	r.decode(&o)
	if o.ShareUnits != 75 {
		t.Fatalf("share_units = %d, want 75", o.ShareUnits)
	}
}

func TestUpdateCafeOwner_UpdateNotes(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Nina", 100)
	callHandler(t, fx, UpdateCafeOwner(testHub()), "PATCH", "/",
		map[string]any{"notes": "sleeping partner"}, withParam("id", owner.String())).
		expectStatus(200)
}

// =========================================================================
// DeactivateCafeOwner
// =========================================================================

func TestDeactivateCafeOwner_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeactivateCafeOwner_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeactivateCafeOwner_AlreadyDeactivated(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Ollie", 100)
	fx.finDeactivateOwner(owner)
	// Second deactivation — active_to IS NOT NULL so WHERE clause misses.
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/", nil,
		withParam("id", owner.String())).
		expectErr(404, "not_found")
}

func TestDeactivateCafeOwner_BlockedByOutstandingLoan(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Pam", 100)
	fx.finSeedLoanAdvance(owner, 25000, "outstanding")
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/",
		map[string]any{"force": false}, withParam("id", owner.String())).
		expectErr(409, "owner_has_outstanding")
}

func TestDeactivateCafeOwner_ForceOverridesOutstandingLoan(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Quinn", 100)
	fx.finSeedLoanAdvance(owner, 12000, "unpaid")
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/",
		map[string]any{"force": true}, withParam("id", owner.String())).
		expectStatus(204)
	// Verify active_to is set.
	var activeTo *string
	fx.adminScan([]any{&activeTo},
		`SELECT to_char(active_to, 'YYYY-MM-DD') FROM cafe_owners WHERE id = $1`, owner)
	if activeTo == nil {
		t.Fatalf("active_to should be set after deactivation")
	}
}

func TestDeactivateCafeOwner_SuccessNoLoan(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Rosa", 100)
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/", nil,
		withParam("id", owner.String())).
		expectStatus(204)
	var activeTo *string
	fx.adminScan([]any{&activeTo},
		`SELECT to_char(active_to, 'YYYY-MM-DD') FROM cafe_owners WHERE id = $1`, owner)
	today := time.Now().UTC().Format("2006-01-02")
	if activeTo == nil || *activeTo != today {
		t.Fatalf("active_to = %v, want %q", activeTo, today)
	}
}

// =========================================================================
// ListOwnerLedger
// =========================================================================

func TestListOwnerLedger_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListOwnerLedger, "GET", "/", nil).
		expectStatus(200)
	m := r.json()
	entries, _ := m["entries"].([]any)
	if len(entries) != 0 {
		t.Fatalf("entries = %d, want 0", len(entries))
	}
}

func TestListOwnerLedger_AllEntries(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Sam", 100)
	fx.finSeedInvestment(owner, 5000)
	fx.finSeedPayout(owner, 2000)

	r := callHandler(t, fx, ListOwnerLedger, "GET", "/", nil).expectStatus(200)
	m := r.json()
	entries, _ := m["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(entries))
	}
}

func TestListOwnerLedger_FilterByOwnerID(t *testing.T) {
	fx := newTenant(t)
	o1 := fx.finSeedOwner("Owner1", 100)
	o2 := fx.finSeedOwner("Owner2", 50)
	fx.finSeedInvestment(o1, 1000)
	fx.finSeedInvestment(o2, 2000)
	fx.finSeedInvestment(o2, 3000)

	r := callHandler(t, fx, ListOwnerLedger, "GET", "/", nil,
		withQuery("owner_id="+o2.String())).
		expectStatus(200)
	m := r.json()
	entries, _ := m["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("entries for owner2 = %d, want 2", len(entries))
	}
}

func TestListOwnerLedger_FilterByKind(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Tara", 100)
	fx.finSeedInvestment(owner, 5000)
	fx.finSeedInvestment(owner, 3000)
	fx.finSeedPayout(owner, 1000)

	r := callHandler(t, fx, ListOwnerLedger, "GET", "/", nil,
		withQuery("kind=investment")).
		expectStatus(200)
	m := r.json()
	entries, _ := m["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("investment entries = %d, want 2", len(entries))
	}
}

func TestListOwnerLedger_LoanRepaidCentsPopulated(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Uma", 100)
	loanID := fx.finSeedLoanAdvance(owner, 10000, "rent")
	// Repay 4000.
	fx.adminExec(`
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, parent_loan_id, notes, created_by_user_id)
		VALUES ($1, $2, 'loan_repayment', 4000, $3, 'repay', $4)`,
		fx.Tenant, owner, loanID, fx.User)

	r := callHandler(t, fx, ListOwnerLedger, "GET", "/", nil,
		withQuery("kind=loan_advance")).expectStatus(200)
	m := r.json()
	entries, _ := m["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("loan_advance entries = %d, want 1", len(entries))
	}
	e, _ := entries[0].(map[string]any)
	if got := int64(e["repaid_cents"].(float64)); got != 4000 {
		t.Fatalf("repaid_cents = %d, want 4000", got)
	}
}

func TestListOwnerLedger_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	o2 := fx2.finSeedOwner("Other", 100)
	fx2.finSeedInvestment(o2, 99999)

	r := callHandler(t, fx1, ListOwnerLedger, "GET", "/", nil).expectStatus(200)
	m := r.json()
	entries, _ := m["entries"].([]any)
	if len(entries) != 0 {
		t.Fatalf("entries = %d, want 0 (isolation failure)", len(entries))
	}
}

// =========================================================================
// CreateInvestment
// =========================================================================

func TestCreateInvestment_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/", "{bad").
		expectErr(400, "bad_request")
}

func TestCreateInvestment_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Victor", 100)
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 0}).
		expectErr(400, "bad_request")
}

func TestCreateInvestment_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Victor", 100)
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": -500}).
		expectErr(400, "bad_request")
}

func TestCreateInvestment_OwnerNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": uuid.NewString(), "amount_cents": 1000}).
		expectErr(400, "bad_request")
}

func TestCreateInvestment_Success(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Wendy", 100)

	r := callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 50000, "notes": "seed capital"}).
		expectStatus(201)
	m := r.json()
	if m["id"] == nil {
		t.Fatalf("response should contain id")
	}
	if n := fx.finOwnerLedgerCount(); n != 1 {
		t.Fatalf("owner_ledger count = %d, want 1", n)
	}
}

func TestCreateInvestment_LedgerKindIsInvestment(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Xara", 100)
	r := callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 20000}).
		expectStatus(201)
	m := r.json()
	idStr, _ := m["id"].(string)
	id, _ := uuid.Parse(idStr)
	kind, amount, isCorr, _ := fx.finGetOwnerLedgerEntry(id)
	if kind != "investment" {
		t.Fatalf("kind = %q, want investment", kind)
	}
	if amount != 20000 {
		t.Fatalf("amount_cents = %d, want 20000", amount)
	}
	if isCorr {
		t.Fatalf("is_correction should be false for a fresh investment")
	}
}

func TestCreateInvestment_BankBalanceIncrements(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Yuki", 100)

	before := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b0 CafeBalance
	before.decode(&b0)

	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 30000}).
		expectStatus(201)

	after := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b1 CafeBalance
	after.decode(&b1)

	if b1.BankCents-b0.BankCents != 30000 {
		t.Fatalf("bank_cents delta = %d, want 30000", b1.BankCents-b0.BankCents)
	}
}

func TestCreateInvestment_CustomOccurredAt(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Zane", 100)
	past := time.Date(2025, 1, 15, 10, 0, 0, 0, time.UTC)
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": owner.String(), "amount_cents": 5000, "occurred_at": past}).
		expectStatus(201)
}

// =========================================================================
// CreatePayouts
// =========================================================================

func TestCreatePayouts_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/", "{bad").
		expectErr(400, "bad_request")
}

func TestCreatePayouts_EmptyEntries(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{}}).
		expectErr(400, "bad_request")
}

func TestCreatePayouts_MissingEntries(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"notes": "no entries key"}).
		expectErr(400, "bad_request")
}

func TestCreatePayouts_ZeroAmountEntry(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Alpha", 100)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": owner.String(), "amount_cents": 0},
		}}).
		expectErr(400, "bad_request")
}

func TestCreatePayouts_NegativeAmountEntry(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Beta", 100)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": owner.String(), "amount_cents": -100},
		}}).
		expectErr(400, "bad_request")
}

func TestCreatePayouts_OwnerNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": uuid.NewString(), "amount_cents": 1000},
		}}).
		expectErr(400, "bad_request")
}

func TestCreatePayouts_SingleOwner(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Gamma", 100)

	r := callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": owner.String(), "amount_cents": 15000},
		}}).
		expectStatus(201)
	m := r.json()
	ids, _ := m["ids"].([]any)
	if len(ids) != 1 {
		t.Fatalf("ids length = %d, want 1", len(ids))
	}
	if got := int64(m["total_cents"].(float64)); got != 15000 {
		t.Fatalf("total_cents = %d, want 15000", got)
	}
	if n := fx.finOwnerLedgerCount(); n != 1 {
		t.Fatalf("owner_ledger count = %d, want 1", n)
	}
}

func TestCreatePayouts_MultiOwnerSplit(t *testing.T) {
	fx := newTenant(t)
	o1 := fx.finSeedOwner("Delta", 60)
	o2 := fx.finSeedOwner("Epsilon", 40)

	r := callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{
			"entries": []any{
				map[string]any{"owner_id": o1.String(), "amount_cents": 60000},
				map[string]any{"owner_id": o2.String(), "amount_cents": 40000},
			},
			"notes": "monthly split",
		}).
		expectStatus(201)
	m := r.json()
	ids, _ := m["ids"].([]any)
	if len(ids) != 2 {
		t.Fatalf("ids length = %d, want 2", len(ids))
	}
	if got := int64(m["total_cents"].(float64)); got != 100000 {
		t.Fatalf("total_cents = %d, want 100000", got)
	}
	if n := fx.finOwnerLedgerCount(); n != 2 {
		t.Fatalf("owner_ledger count = %d, want 2", n)
	}
}

func TestCreatePayouts_BankDecreases(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Zeta", 100)
	// Seed some bank balance first.
	fx.finSeedInvestment(owner, 100000)

	before := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b0 CafeBalance
	before.decode(&b0)

	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": owner.String(), "amount_cents": 40000},
		}}).
		expectStatus(201)

	after := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b1 CafeBalance
	after.decode(&b1)

	if b0.BankCents-b1.BankCents != 40000 {
		t.Fatalf("bank_cents delta = %d, want 40000", b0.BankCents-b1.BankCents)
	}
}

func TestCreatePayouts_PartialOwnerNotFoundRollsBackAll(t *testing.T) {
	// First entry valid, second invalid — both should fail (single tx).
	fx := newTenant(t)
	owner := fx.finSeedOwner("Eta", 100)
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": owner.String(), "amount_cents": 5000},
			map[string]any{"owner_id": uuid.NewString(), "amount_cents": 3000},
		}}).
		expectErr(400, "bad_request")
	// No ledger rows should have persisted.
	if n := fx.finOwnerLedgerCount(); n != 0 {
		t.Fatalf("owner_ledger count = %d after rollback, want 0", n)
	}
}

// =========================================================================
// RepayLoan
// =========================================================================

func TestRepayLoan_BadLoanID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 1000}, withParam("id", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestRepayLoan_BadJSON(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Theta", 100)
	loanID := fx.finSeedLoanAdvance(owner, 5000, "test")
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/", "{bad",
		withParam("id", loanID.String())).
		expectErr(400, "bad_request")
}

func TestRepayLoan_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Iota", 100)
	loanID := fx.finSeedLoanAdvance(owner, 5000, "test")
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 0}, withParam("id", loanID.String())).
		expectErr(400, "bad_request")
}

func TestRepayLoan_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Kappa", 100)
	loanID := fx.finSeedLoanAdvance(owner, 5000, "test")
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": -100}, withParam("id", loanID.String())).
		expectErr(400, "bad_request")
}

func TestRepayLoan_LoanNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 1000}, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestRepayLoan_NonLoanAdvanceIDRejected(t *testing.T) {
	// Passing the id of an investment row should 404 (not loan_advance kind).
	fx := newTenant(t)
	owner := fx.finSeedOwner("Lambda", 100)
	invID := fx.finSeedInvestment(owner, 5000)
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 1000}, withParam("id", invID.String())).
		expectErr(404, "not_found")
}

func TestRepayLoan_OverpaymentRejected(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Mu", 100)
	loanID := fx.finSeedLoanAdvance(owner, 10000, "test")
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 10001}, withParam("id", loanID.String())).
		expectErr(409, "overpayment")
}

func TestRepayLoan_PartialRepaySuccess(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Nu", 100)
	loanID := fx.finSeedLoanAdvance(owner, 20000, "test")

	r := callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 5000, "notes": "first instalment"},
		withParam("id", loanID.String())).
		expectStatus(201)
	m := r.json()
	if m["id"] == nil {
		t.Fatalf("response should contain repayment id")
	}
	// Outstanding should be 15000 now.
	if got := fx.finOwnerOutstandingLoans(owner); got != 15000 {
		t.Fatalf("outstanding loans = %d, want 15000", got)
	}
}

func TestRepayLoan_FullRepaySuccess(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Xi", 100)
	loanID := fx.finSeedLoanAdvance(owner, 8000, "test")

	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 8000}, withParam("id", loanID.String())).
		expectStatus(201)

	if got := fx.finOwnerOutstandingLoans(owner); got != 0 {
		t.Fatalf("outstanding loans = %d after full repay, want 0", got)
	}
}

func TestRepayLoan_OverpaymentAfterPartialRepay(t *testing.T) {
	// Repay 5000 of a 10000 loan, then try to repay 6000 more — should 409.
	fx := newTenant(t)
	owner := fx.finSeedOwner("Omicron", 100)
	loanID := fx.finSeedLoanAdvance(owner, 10000, "test")

	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 5000}, withParam("id", loanID.String())).
		expectStatus(201)

	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 6000}, withParam("id", loanID.String())).
		expectErr(409, "overpayment")
}

func TestRepayLoan_TenantIsolationOnLoan(t *testing.T) {
	// Loan created in fx2 should not be findable from fx1's RLS context.
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	owner2 := fx2.finSeedOwner("Pi", 100)
	loanID := fx2.finSeedLoanAdvance(owner2, 5000, "cross-tenant attempt")

	callHandler(t, fx1, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 1000}, withParam("id", loanID.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// CorrectOwnerLedger
// =========================================================================

func TestCorrectOwnerLedger_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "oops"}, withParam("id", "not-uuid")).
		expectErr(400, "bad_request")
}

func TestCorrectOwnerLedger_BadJSON(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Rho", 100)
	inv := fx.finSeedInvestment(owner, 5000)
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/", "{bad",
		withParam("id", inv.String())).
		expectErr(400, "bad_request")
}

func TestCorrectOwnerLedger_MissingNotes(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Sigma", 100)
	inv := fx.finSeedInvestment(owner, 5000)
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": ""}, withParam("id", inv.String())).
		expectErr(400, "bad_request")
}

func TestCorrectOwnerLedger_BlankNotes(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Tau", 100)
	inv := fx.finSeedInvestment(owner, 5000)
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "   "}, withParam("id", inv.String())).
		expectErr(400, "bad_request")
}

func TestCorrectOwnerLedger_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "reason"}, withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestCorrectOwnerLedger_CannotCorrectACorrection(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Upsilon", 100)
	inv := fx.finSeedInvestment(owner, 5000)

	// Create a correction.
	r := callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "typo"}, withParam("id", inv.String())).
		expectStatus(201)
	m := r.json()
	corrID, _ := uuid.Parse(m["id"].(string))

	// Now try to correct the correction.
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "double correction"}, withParam("id", corrID.String())).
		expectErr(409, "already_correction")
}

func TestCorrectOwnerLedger_SuccessInvestment(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Phi", 100)
	inv := fx.finSeedInvestment(owner, 8000)

	r := callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "wrong amount entered"}, withParam("id", inv.String())).
		expectStatus(201)
	m := r.json()
	corrIDStr, _ := m["id"].(string)
	corrID, _ := uuid.Parse(corrIDStr)

	// Verify the correction row properties.
	kind, amount, isCorr, correctsID := fx.finGetOwnerLedgerEntry(corrID)
	if kind != "investment" {
		t.Fatalf("correction kind = %q, want investment", kind)
	}
	if amount != 8000 {
		t.Fatalf("correction amount = %d, want 8000 (mirrors original)", amount)
	}
	if !isCorr {
		t.Fatalf("is_correction should be true")
	}
	if correctsID == nil || *correctsID != inv {
		t.Fatalf("corrects_id = %v, want %v", correctsID, inv)
	}
	// Two rows in ledger now.
	if n := fx.finOwnerLedgerCount(); n != 2 {
		t.Fatalf("owner_ledger count = %d, want 2", n)
	}
}

func TestCorrectOwnerLedger_SuccessPayout(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("Chi", 100)
	payout := fx.finSeedPayout(owner, 3000)

	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "paid wrong owner"}, withParam("id", payout.String())).
		expectStatus(201)
}

func TestCorrectOwnerLedger_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	o2 := fx2.finSeedOwner("Psi", 100)
	inv2 := fx2.finSeedInvestment(o2, 5000)

	callHandler(t, fx1, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "cross-tenant"}, withParam("id", inv2.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// Equity-vs-investment math: end-to-end ownership flow
// =========================================================================

// TestFinance_OwnershipFlow is the money-correctness smoke test:
//   - Create two owners with share ratios 60:40
//   - Record an investment for each
//   - Record payouts proportional to shares
//   - Assert cafe balance reflects investments minus payouts
//   - Assert per-owner roll-ups on list
func TestFinance_OwnershipFlow(t *testing.T) {
	fx := newTenant(t)

	// Create owners via handler.
	r1 := callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Omega1", "share_units": 60}).
		expectStatus(201)
	var o1 CafeOwner
	r1.decode(&o1)

	r2 := callHandler(t, fx, CreateCafeOwner(testHub()), "POST", "/",
		map[string]any{"display_name": "Omega2", "share_units": 40}).
		expectStatus(201)
	var o2 CafeOwner
	r2.decode(&o2)

	// Record investments via handler.
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": o1.ID.String(), "amount_cents": 60000}).
		expectStatus(201)
	callHandler(t, fx, CreateInvestment(testHub()), "POST", "/",
		map[string]any{"owner_id": o2.ID.String(), "amount_cents": 40000}).
		expectStatus(201)

	// Cafe balance = 100000.
	bal := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b CafeBalance
	bal.decode(&b)
	if b.BankCents != 100000 {
		t.Fatalf("bank after investments = %d, want 100000", b.BankCents)
	}

	// Pay out proportional to shares: 30000 each.
	callHandler(t, fx, CreatePayouts(testHub()), "POST", "/",
		map[string]any{"entries": []any{
			map[string]any{"owner_id": o1.ID.String(), "amount_cents": 30000},
			map[string]any{"owner_id": o2.ID.String(), "amount_cents": 20000},
		}}).
		expectStatus(201)

	// Cafe balance = 100000 − 50000 = 50000.
	bal2 := callHandler(t, fx, GetCafeBalance, "GET", "/", nil).expectStatus(200)
	var b2 CafeBalance
	bal2.decode(&b2)
	if b2.BankCents != 50000 {
		t.Fatalf("bank after payouts = %d, want 50000", b2.BankCents)
	}

	// Per-owner roll-ups via list.
	list := callHandler(t, fx, ListCafeOwners, "GET", "/", nil).expectStatus(200).json()
	owners, _ := list["owners"].([]any)
	if len(owners) != 2 {
		t.Fatalf("owners = %d, want 2", len(owners))
	}
	for _, ow := range owners {
		o, _ := ow.(map[string]any)
		switch o["display_name"].(string) {
		case "Omega1":
			if got := int64(o["lifetime_investment_cents"].(float64)); got != 60000 {
				t.Fatalf("Omega1 investment = %d, want 60000", got)
			}
			if got := int64(o["lifetime_payouts_cents"].(float64)); got != 30000 {
				t.Fatalf("Omega1 payouts = %d, want 30000", got)
			}
		case "Omega2":
			if got := int64(o["lifetime_investment_cents"].(float64)); got != 40000 {
				t.Fatalf("Omega2 investment = %d, want 40000", got)
			}
			if got := int64(o["lifetime_payouts_cents"].(float64)); got != 20000 {
				t.Fatalf("Omega2 payouts = %d, want 20000", got)
			}
		default:
			t.Fatalf("unexpected owner %q", o["display_name"])
		}
	}
}

// TestFinance_LoanLifecycle covers: advance → partial repay → remaining outstanding
// → full repay → no overpay on already-closed loan.
func TestFinance_LoanLifecycle(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("LoanOwner", 100)
	loanID := fx.finSeedLoanAdvance(owner, 20000, "initial advance")

	// Before any repayment.
	if got := fx.finOwnerOutstandingLoans(owner); got != 20000 {
		t.Fatalf("outstanding before repay = %d, want 20000", got)
	}

	// Partial repay 7000.
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 7000}, withParam("id", loanID.String())).
		expectStatus(201)
	if got := fx.finOwnerOutstandingLoans(owner); got != 13000 {
		t.Fatalf("outstanding after partial repay = %d, want 13000", got)
	}

	// Overpayment attempt.
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 14000}, withParam("id", loanID.String())).
		expectErr(409, "overpayment")

	// Exact remaining repay.
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 13000}, withParam("id", loanID.String())).
		expectStatus(201)
	if got := fx.finOwnerOutstandingLoans(owner); got != 0 {
		t.Fatalf("outstanding after full repay = %d, want 0", got)
	}

	// Loan now fully repaid — any further repayment should 409 overpayment.
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 1}, withParam("id", loanID.String())).
		expectErr(409, "overpayment")
}

// TestFinance_DeactivateWithLoanThenForce ensures the soft guard and force bypass
// interact correctly with the loan lifecycle.
func TestFinance_DeactivateWithLoanThenForce(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("DeactivateMe", 100)
	loanID := fx.finSeedLoanAdvance(owner, 5000, "outstanding loan")

	// Cannot deactivate with unpaid loan without force.
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/",
		map[string]any{"force": false}, withParam("id", owner.String())).
		expectErr(409, "owner_has_outstanding")

	// Repay the loan.
	callHandler(t, fx, RepayLoan(testHub()), "POST", "/",
		map[string]any{"amount_cents": 5000}, withParam("id", loanID.String())).
		expectStatus(201)

	// Now deactivation should succeed without force.
	callHandler(t, fx, DeactivateCafeOwner(testHub()), "POST", "/", nil,
		withParam("id", owner.String())).
		expectStatus(204)
}

// TestFinance_CorrectionNetEffect verifies that a correction row does NOT
// reverse the summarised totals (corrections are flagged, not subtracted from
// the roll-up queries which filter on is_correction=false).
func TestFinance_CorrectionNetEffect(t *testing.T) {
	fx := newTenant(t)
	owner := fx.finSeedOwner("CorrectionTest", 100)
	inv := fx.finSeedInvestment(owner, 12000)

	// Record the correction via handler.
	callHandler(t, fx, CorrectOwnerLedger(testHub()), "POST", "/",
		map[string]any{"notes": "amount was entered twice"}, withParam("id", inv.String())).
		expectStatus(201)

	// Summary should still show the original investment (correction row
	// is_correction=true so excluded from lifetime_invested_cents roll-up).
	r := callHandler(t, fx, GetCafeSummary, "GET", "/", nil).expectStatus(200)
	var s CafeSummary
	r.decode(&s)
	if s.LifetimeInvestedCents != 12000 {
		t.Fatalf("lifetime_invested_cents = %d, want 12000 (correction does not subtract)", s.LifetimeInvestedCents)
	}
}
