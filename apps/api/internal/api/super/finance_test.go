package super

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Platform books (0060)
//
// These assert IDENTITIES, not row counts — the same style as
// owner_cash_handlers_test.go on the tenant side. A handover must leave total
// cash-in-hands unchanged; a deposit must move exactly its amount out of
// somebody's hands. Getting a row count right while the arithmetic is wrong is
// the failure mode worth guarding against.
// =========================================================================

func (sf *superFixture) holding(personID uuid.UUID) int64 {
	sf.t.Helper()
	var held int64
	sf.adminScan([]any{&held}, `
		SELECT COALESCE(SUM(CASE WHEN kind IN ('collection','handover_in')
		                         THEN amount_cents ELSE -amount_cents END), 0)::bigint
		FROM platform_cash_entries WHERE person_id = $1`, personID)
	return held
}

func (sf *superFixture) totalHeld() int64 {
	sf.t.Helper()
	var held int64
	sf.adminScan([]any{&held}, `
		SELECT COALESCE(SUM(CASE WHEN kind IN ('collection','handover_in')
		                         THEN amount_cents ELSE -amount_cents END), 0)::bigint
		FROM platform_cash_entries`)
	return held
}

// recordCashPayment books a cash payment collected by someone, through the real
// handler, and returns the tenant it was for.
func recordCashPayment(t *testing.T, sf *superFixture, personID uuid.UUID, cents int64) uuid.UUID {
	t.Helper()
	tenantID, _ := sf.seedTenantWithPlan("Paying Cafe", "standard")
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{
			"amount_cents": cents, "method": "cash", "period_end": "2030-12-31",
			"collected_by_person_id": personID.String(),
		},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusCreated)
	return tenantID
}

// The central guarantee: the custody ledger is written by the SAME transaction
// as the payment, so the two can never disagree.
func TestRecordPayment_CashCreatesExactlyOneCustodyRow(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Collector", "agent")

	recordCashPayment(t, sf, person, 500000)

	if got := sf.holding(person); got != 500000 {
		t.Errorf("holding = %d, want 500000", got)
	}
	var rows int
	sf.adminScan([]any{&rows},
		`SELECT count(*)::int FROM platform_cash_entries WHERE person_id = $1 AND kind = 'collection'`, person)
	if rows != 1 {
		t.Errorf("got %d collection rows, want exactly 1", rows)
	}
}

// A bank transfer creates revenue but no custody obligation — nobody is holding
// anything.
func TestRecordPayment_BankCreatesNoCustodyRow(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Bank Payer", "standard")

	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 100000, "method": "bank", "period_end": "2030-12-31"},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusCreated)

	var rows int
	sf.adminScan([]any{&rows},
		`SELECT count(*)::int FROM platform_cash_entries ce
		 JOIN tenant_payments tp ON tp.id = ce.payment_id WHERE tp.tenant_id = $1`, tenantID)
	if rows != 0 {
		t.Errorf("a bank payment created %d custody rows, want 0", rows)
	}
	var into string
	sf.adminScan([]any{&into}, `SELECT received_into FROM tenant_payments WHERE tenant_id = $1`, tenantID)
	if into != "bank" {
		t.Errorf("received_into = %q, want bank derived from the method", into)
	}
}

// Cash with nobody named still records — refusing would break every existing
// caller — but it defaults to whoever is entering it, because in practice they
// are the person who just took the money.
func TestRecordPayment_CashDefaultsCollectorToTheActingAdmin(t *testing.T) {
	sf := newSuperFixture(t)
	var personID uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO platform_people (name, kind, user_id) VALUES ('Recording Admin', 'admin', $1) RETURNING id`,
		sf.AdminUser).Scan(&personID); err != nil {
		t.Fatalf("seed acting person: %v", err)
	}
	t.Cleanup(func() { cleanupPerson(personID) })

	tenantID, _ := sf.seedTenantWithPlan("Defaulted Cash", "standard")
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 100000, "method": "cash", "period_end": "2030-12-31"},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusCreated)

	if got := sf.holding(personID); got != 100000 {
		t.Errorf("holding = %d, want the acting admin credited with 100000", got)
	}
}

// …and when nobody can be resolved at all, the payment is still recorded rather
// than lost. It shows up as unattributed, which is a prompt to fix it.
func TestRecordPayment_CashWithNoResolvableCollectorStillRecords(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Orphan Cash", "standard")
	// sf.AdminUser has no platform_people row in this fixture.
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 100000, "method": "cash", "period_end": "2030-12-31"},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusCreated)

	var collector *uuid.UUID
	sf.adminScan([]any{&collector},
		`SELECT collected_by_person_id FROM tenant_payments WHERE tenant_id = $1`, tenantID)
	if collector != nil {
		t.Errorf("collector = %v, want unattributed", collector)
	}
}

func TestRecordPayment_UnknownCollectorIsRejected(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Ghost Collector", "standard")
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{
			"amount_cents": 100000, "method": "cash", "period_end": "2030-12-31",
			"collected_by_person_id": uuid.New().String(),
		},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "unknown_person")
}

// --- deposits ------------------------------------------------------------

// Banking cash moves it out of somebody's hands. It does NOT change how much
// money the platform has, which is why the statement's net is unaffected.
func TestDepositCash_MovesMoneyOutOfHands(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Depositor", "agent")
	recordCashPayment(t, sf, person, 500000)

	callSuper(t, sf, DepositCash, http.MethodPost, "/v1/super/finance/cash/deposit",
		map[string]any{"person_id": person.String(), "amount_cents": 200000, "reference_no": "SLIP-1"}).
		expectStatus(http.StatusCreated)

	if got := sf.holding(person); got != 300000 {
		t.Errorf("holding = %d, want 300000 after banking 200000 of 500000", got)
	}
}

func TestDepositCash_CannotOverdraw(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Optimist", "agent")
	recordCashPayment(t, sf, person, 100000)

	callSuper(t, sf, DepositCash, http.MethodPost, "/v1/super/finance/cash/deposit",
		map[string]any{"person_id": person.String(), "amount_cents": 100001}).
		expectErr(http.StatusConflict, "insufficient_holding")

	if got := sf.holding(person); got != 100000 {
		t.Errorf("a refused deposit changed the holding to %d", got)
	}
}

func TestDepositCash_ExactBalanceIsAllowed(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Precise", "agent")
	recordCashPayment(t, sf, person, 100000)

	callSuper(t, sf, DepositCash, http.MethodPost, "/v1/super/finance/cash/deposit",
		map[string]any{"person_id": person.String(), "amount_cents": 100000}).
		expectStatus(http.StatusCreated)

	if got := sf.holding(person); got != 0 {
		t.Errorf("holding = %d, want 0 after banking everything", got)
	}
}

// --- handovers -----------------------------------------------------------

// The identity that matters: passing cash between people must leave the
// platform's TOTAL cash-in-hands untouched.
func TestHandoverCash_ConservesTotal(t *testing.T) {
	sf := newSuperFixture(t)
	giver := sf.seedPerson("Giver", "agent")
	taker := sf.seedPerson("Taker", "admin")
	recordCashPayment(t, sf, giver, 400000)

	before := sf.totalHeld()
	callSuper(t, sf, HandoverCash, http.MethodPost, "/v1/super/finance/cash/handover",
		map[string]any{
			"from_person_id": giver.String(), "to_person_id": taker.String(),
			"amount_cents": 150000,
		}).expectStatus(http.StatusCreated)

	if got := sf.holding(giver); got != 250000 {
		t.Errorf("giver holds %d, want 250000", got)
	}
	if got := sf.holding(taker); got != 150000 {
		t.Errorf("taker holds %d, want 150000", got)
	}
	if after := sf.totalHeld(); after != before {
		t.Errorf("total cash-in-hands changed from %d to %d — a handover creates no money", before, after)
	}
}

// Both halves must share a transfer_group_id so the pair can be shown, and
// reversed, together.
func TestHandoverCash_WritesAPairedGroup(t *testing.T) {
	sf := newSuperFixture(t)
	giver := sf.seedPerson("Pair Giver", "agent")
	taker := sf.seedPerson("Pair Taker", "agent")
	recordCashPayment(t, sf, giver, 100000)

	callSuper(t, sf, HandoverCash, http.MethodPost, "/v1/super/finance/cash/handover",
		map[string]any{
			"from_person_id": giver.String(), "to_person_id": taker.String(), "amount_cents": 40000,
		}).expectStatus(http.StatusCreated)

	var groups, rows int
	sf.adminScan([]any{&groups, &rows}, `
		SELECT count(DISTINCT transfer_group_id)::int, count(*)::int
		FROM platform_cash_entries
		WHERE kind IN ('handover_out','handover_in') AND person_id IN ($1, $2)`, giver, taker)
	if groups != 1 || rows != 2 {
		t.Errorf("got %d groups across %d rows, want 1 group of 2", groups, rows)
	}
}

func TestHandoverCash_CannotOverdraw(t *testing.T) {
	sf := newSuperFixture(t)
	giver := sf.seedPerson("Broke Giver", "agent")
	taker := sf.seedPerson("Hopeful Taker", "agent")
	recordCashPayment(t, sf, giver, 50000)

	callSuper(t, sf, HandoverCash, http.MethodPost, "/v1/super/finance/cash/handover",
		map[string]any{
			"from_person_id": giver.String(), "to_person_id": taker.String(), "amount_cents": 60000,
		}).expectErr(http.StatusConflict, "insufficient_holding")

	if got := sf.holding(taker); got != 0 {
		t.Errorf("a refused handover credited the taker %d", got)
	}
}

func TestHandoverCash_RejectsSelfTransfer(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Solo", "agent")
	callSuper(t, sf, HandoverCash, http.MethodPost, "/v1/super/finance/cash/handover",
		map[string]any{
			"from_person_id": person.String(), "to_person_id": person.String(), "amount_cents": 1000,
		}).expectErr(http.StatusBadRequest, "bad_request")
}

// --- expenses ------------------------------------------------------------

// Spending collected cash must draw the holding down in the same transaction —
// otherwise the money is gone but the ledger still says they have it.
func TestCreateExpense_FromPersonCashDrawsDownTheHolding(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Spender", "agent")
	recordCashPayment(t, sf, person, 300000)

	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{
			"amount_cents": 50000, "occurred_on": "2026-08-01", "vendor": "Petrol",
			"paid_from": "person_cash", "paid_by_person_id": person.String(),
		}).expectStatus(http.StatusCreated)

	if got := sf.holding(person); got != 250000 {
		t.Errorf("holding = %d, want 250000 after spending 50000", got)
	}
}

func TestCreateExpense_FromPersonCashCannotOverdraw(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Overspender", "agent")
	recordCashPayment(t, sf, person, 10000)

	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{
			"amount_cents": 20000, "occurred_on": "2026-08-01",
			"paid_from": "person_cash", "paid_by_person_id": person.String(),
		}).expectErr(http.StatusConflict, "insufficient_holding")

	// And nothing was half-written.
	var expenses int
	sf.adminScan([]any{&expenses}, `SELECT count(*)::int FROM platform_expenses WHERE paid_by_person_id = $1`, person)
	if expenses != 0 {
		t.Errorf("a refused expense left %d rows behind", expenses)
	}
	if got := sf.holding(person); got != 10000 {
		t.Errorf("holding changed to %d after a refused expense", got)
	}
}

// A bank expense creates no custody movement.
func TestCreateExpense_FromBankTouchesNoHolding(t *testing.T) {
	sf := newSuperFixture(t)
	before := sf.totalHeld()
	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{
			"amount_cents": 90000, "occurred_on": "2026-08-01",
			"vendor": "Hetzner", "paid_from": "bank",
		}).expectStatus(http.StatusCreated)

	if after := sf.totalHeld(); after != before {
		t.Errorf("a bank expense moved %d into custody; it must move none", after-before)
	}
}

// The CHECK makes the illegal combinations unrepresentable; the handler should
// catch them first with a readable message.
func TestCreateExpense_PaidFromAndPersonMustAgree(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Confused", "agent")

	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{
			"amount_cents": 1000, "occurred_on": "2026-08-01", "paid_from": "person_cash",
		}).expectErr(http.StatusBadRequest, "bad_request")

	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{
			"amount_cents": 1000, "occurred_on": "2026-08-01", "paid_from": "bank",
			"paid_by_person_id": person.String(),
		}).expectErr(http.StatusBadRequest, "bad_request")
}

// Deleting an expense that drew on collected cash would silently inflate that
// person's holding, because the custody ledger is append-only.
func TestDeleteExpense_RefusesWhenLinkedToCash(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Linked", "agent")
	recordCashPayment(t, sf, person, 100000)

	var created struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{
			"amount_cents": 30000, "occurred_on": "2026-08-01",
			"paid_from": "person_cash", "paid_by_person_id": person.String(),
		}).expectStatus(http.StatusCreated).decode(&created)

	callSuper(t, sf, DeleteExpense, http.MethodPost,
		"/v1/super/finance/expenses/"+created.ID.String()+"/delete", nil,
		superParam("id", created.ID.String())).
		expectErr(http.StatusConflict, "linked_to_cash")

	if got := sf.holding(person); got != 70000 {
		t.Errorf("holding = %d, want it untouched at 70000", got)
	}
}

func TestDeleteExpense_SoftDeletesABankExpense(t *testing.T) {
	sf := newSuperFixture(t)
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{"amount_cents": 5000, "occurred_on": "2026-08-01", "paid_from": "bank"}).
		expectStatus(http.StatusCreated).decode(&created)

	callSuper(t, sf, DeleteExpense, http.MethodPost,
		"/v1/super/finance/expenses/"+created.ID.String()+"/delete", nil,
		superParam("id", created.ID.String())).
		expectStatus(http.StatusOK)

	var deleted bool
	sf.adminScan([]any{&deleted}, `SELECT deleted_at IS NOT NULL FROM platform_expenses WHERE id = $1`, created.ID)
	if !deleted {
		t.Error("the expense should be soft-deleted")
	}
}

// --- listings + statement ------------------------------------------------

// The listed holding must equal the ledger sum — a UI that shows a different
// number than the data is worse than one that shows nothing.
func TestListCash_HoldingsMatchTheLedger(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Listed Holder", "agent")
	recordCashPayment(t, sf, person, 250000)

	var out struct {
		Holders        []CashHolder `json:"holders"`
		TotalHeldCents int64        `json:"total_held_cents"`
	}
	callSuper(t, sf, ListCash, http.MethodGet, "/v1/super/finance/cash", nil).
		expectStatus(http.StatusOK).decode(&out)

	var found bool
	for _, h := range out.Holders {
		if h.PersonID == person {
			found = true
			if h.HeldCents != sf.holding(person) {
				t.Errorf("listed holding %d != ledger %d", h.HeldCents, sf.holding(person))
			}
			if h.OldestHeld == nil {
				t.Error("a holder with a collection should report when it started")
			}
		}
	}
	if !found {
		t.Error("the collector is missing from the holdings list")
	}
	// The list's own total must agree with the ledger it summarises. Both are
	// global figures, so they're compared to each other, not to a fixture.
	if out.TotalHeldCents != sf.totalHeld() {
		t.Errorf("total %d != ledger total %d", out.TotalHeldCents, sf.totalHeld())
	}
}

// Depositing moves money between buckets; it must not change the net.
func TestStatement_DepositMovesMoneyWithoutChangingNet(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Statement Holder", "agent")
	recordCashPayment(t, sf, person, 600000)

	read := func() (net, held, bank int64) {
		var out struct {
			NetCents     int64            `json:"net_cents"`
			CashPosition map[string]int64 `json:"cash_position"`
		}
		callSuper(t, sf, GetStatement, http.MethodGet, "/v1/super/finance/statement", nil,
			superQuery("from=2020-01-01&to=2035-01-01")).
			expectStatus(http.StatusOK).decode(&out)
		return out.NetCents, out.CashPosition["held_by_people_cents"], out.CashPosition["bank_cents"]
	}

	net0, held0, bank0 := read()
	callSuper(t, sf, DepositCash, http.MethodPost, "/v1/super/finance/cash/deposit",
		map[string]any{"person_id": person.String(), "amount_cents": 200000}).
		expectStatus(http.StatusCreated)
	net1, held1, bank1 := read()

	if net1 != net0 {
		t.Errorf("net changed from %d to %d — banking cash is not income", net0, net1)
	}
	if held0-held1 != 200000 {
		t.Errorf("held dropped by %d, want 200000", held0-held1)
	}
	if bank1-bank0 != 200000 {
		t.Errorf("bank rose by %d, want 200000", bank1-bank0)
	}
}

func TestStatement_NetIsRevenueMinusExpenses(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenantWithPlan("Net Cafe", "standard")
	callSuper(t, sf, RecordPayment, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/payments",
		map[string]any{"amount_cents": 500000, "method": "bank", "period_end": "2030-12-31"},
		superParam("id", tenantID.String())).expectStatus(http.StatusCreated)

	var before struct {
		NetCents int64 `json:"net_cents"`
	}
	callSuper(t, sf, GetStatement, http.MethodGet, "/v1/super/finance/statement", nil,
		superQuery("from=2020-01-01&to=2035-01-01")).expectStatus(http.StatusOK).decode(&before)

	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{"amount_cents": 120000, "occurred_on": "2026-08-01", "paid_from": "bank"}).
		expectStatus(http.StatusCreated)

	var after struct {
		NetCents int64 `json:"net_cents"`
	}
	callSuper(t, sf, GetStatement, http.MethodGet, "/v1/super/finance/statement", nil,
		superQuery("from=2020-01-01&to=2035-01-01")).expectStatus(http.StatusOK).decode(&after)

	if before.NetCents-after.NetCents != 120000 {
		t.Errorf("net moved by %d, want it down by the 120000 expense", before.NetCents-after.NetCents)
	}
}

func TestListRevenue_GroupsAndTotals(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Revenue Collector", "agent")
	recordCashPayment(t, sf, person, 111000)

	var out struct {
		Payments    []RevenueRow     `json:"payments"`
		TotalCents  int64            `json:"total_cents"`
		ByMethod    map[string]int64 `json:"by_method"`
		ByCollector map[string]int64 `json:"by_collector"`
	}
	callSuper(t, sf, ListRevenue, http.MethodGet, "/v1/super/finance/revenue", nil,
		superQuery("from=2020-01-01&to=2035-01-01")).
		expectStatus(http.StatusOK).decode(&out)

	// The grouped totals must agree with the rows they summarise.
	var sum int64
	for _, p := range out.Payments {
		sum += p.AmountCents
	}
	if sum != out.TotalCents {
		t.Errorf("rows sum to %d but total says %d", sum, out.TotalCents)
	}
	var methodSum int64
	for _, v := range out.ByMethod {
		methodSum += v
	}
	if methodSum != out.TotalCents {
		t.Errorf("by_method sums to %d, want %d", methodSum, out.TotalCents)
	}
	if out.ByCollector["Revenue Collector"] < 111000 {
		t.Errorf("by_collector should attribute the payment: %+v", out.ByCollector)
	}
}

func TestFinanceRange_RejectsInvertedRange(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, GetStatement, http.MethodGet, "/v1/super/finance/statement", nil,
		superQuery("from=2026-08-01&to=2026-07-01")).
		expectErr(http.StatusBadRequest, "bad_request")
}

// Grants: every write path here must work as app_user, not just as the
// superuser the fixtures use. A missing GRANT only shows up in the live API.
func TestFinance_WritePathsWorkAsAppUser(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Grant Check", "agent")
	// callSuper already runs through appPool (app_user), so reaching a 2xx here
	// IS the grant assertion; this test exists to say so explicitly.
	recordCashPayment(t, sf, person, 100000)
	callSuper(t, sf, DepositCash, http.MethodPost, "/v1/super/finance/cash/deposit",
		map[string]any{"person_id": person.String(), "amount_cents": 1000}).
		expectStatus(http.StatusCreated)
	callSuper(t, sf, CreateExpenseCategory, http.MethodPost, "/v1/super/finance/expense-categories",
		map[string]any{"name": "Grant Test " + uuid.NewString()[:6]}).
		expectStatus(http.StatusCreated)

	_, _ = adminPool.Exec(context.Background(),
		`DELETE FROM platform_expense_categories WHERE name LIKE 'Grant Test %'`)
}
