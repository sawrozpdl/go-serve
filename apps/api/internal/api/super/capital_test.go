package super

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Partner capital + company balance (0087)
//
// Same style as finance_test.go: assert deltas and identities against the
// all-time position, never absolute totals — the dev database is shared with
// every other test's fixtures.
// =========================================================================

type statementSnap struct {
	NetCents     int64            `json:"net_cents"`
	CashPosition map[string]int64 `json:"cash_position"`
	Capital      map[string]int64 `json:"capital"`
	AllTime      map[string]int64 `json:"all_time"`
}

func readStatement(t *testing.T, sf *superFixture) statementSnap {
	t.Helper()
	var s statementSnap
	callSuper(t, sf, GetStatement, http.MethodGet, "/v1/super/finance/statement", nil,
		superQuery("from=2020-01-01&to=2035-01-01")).expectStatus(http.StatusOK).decode(&s)
	return s
}

func recordCapital(t *testing.T, sf *superFixture, person uuid.UUID, kind, account string, cents int64) uuid.UUID {
	t.Helper()
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateCapitalEntry, http.MethodPost, "/v1/super/finance/capital",
		map[string]any{"person_id": person.String(), "kind": kind, "account": account,
			"amount_cents": cents, "occurred_on": "2026-09-01"}).
		expectStatus(http.StatusCreated).decode(&out)
	return out.ID
}

// createExpense records an expense and removes it afterwards. Person-paid ones
// are swept by cleanupPerson too; bank/wallet ones have no owner and would
// otherwise leak into every later run's statement.
func createExpense(t *testing.T, sf *superFixture, body map[string]any) uuid.UUID {
	t.Helper()
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses", body).
		expectStatus(http.StatusCreated).decode(&out)
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = adminPool.Exec(bg, `DELETE FROM platform_cash_entries WHERE expense_id = $1`, out.ID)
		_, _ = adminPool.Exec(bg, `DELETE FROM platform_expenses WHERE id = $1`, out.ID)
	})
	return out.ID
}

func partnerCapital(t *testing.T, sf *superFixture, person uuid.UUID) (CapitalPartner, bool) {
	t.Helper()
	var out struct {
		Partners []CapitalPartner `json:"partners"`
	}
	callSuper(t, sf, ListCapital, http.MethodGet, "/v1/super/finance/capital", nil).
		expectStatus(http.StatusOK).decode(&out)
	for _, p := range out.Partners {
		if p.PersonID == person {
			return p, true
		}
	}
	return CapitalPartner{}, false
}

func TestCapital_ContributionRaisesBankAndBalance(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Capital Founder", "admin")

	s0 := readStatement(t, sf)
	recordCapital(t, sf, person, "contribution", "bank", 10000000)
	s1 := readStatement(t, sf)

	if d := s1.CashPosition["bank_cents"] - s0.CashPosition["bank_cents"]; d != 10000000 {
		t.Errorf("bank rose by %d, want 10000000", d)
	}
	if d := s1.CashPosition["total_cents"] - s0.CashPosition["total_cents"]; d != 10000000 {
		t.Errorf("balance rose by %d, want 10000000", d)
	}
	if d := s1.Capital["net_cents"] - s0.Capital["net_cents"]; d != 10000000 {
		t.Errorf("capital rose by %d, want 10000000", d)
	}
	if s1.NetCents != s0.NetCents {
		t.Errorf("trading net moved %d → %d — capital is not income", s0.NetCents, s1.NetCents)
	}
}

func TestCapital_WithdrawalLowersWallet(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Capital Withdrawer", "admin")
	recordCapital(t, sf, person, "contribution", "wallet", 500000)

	s0 := readStatement(t, sf)
	recordCapital(t, sf, person, "withdrawal", "wallet", 200000)
	s1 := readStatement(t, sf)

	if d := s0.CashPosition["wallet_cents"] - s1.CashPosition["wallet_cents"]; d != 200000 {
		t.Errorf("wallet fell by %d, want 200000", d)
	}
	if d := s0.CashPosition["total_cents"] - s1.CashPosition["total_cents"]; d != 200000 {
		t.Errorf("balance fell by %d, want 200000", d)
	}
	p, ok := partnerCapital(t, sf, person)
	if !ok || p.Net != 300000 || p.Contributed != 500000 || p.Withdrawn != 200000 {
		t.Errorf("partner = %+v (found=%v), want 500000 in, 200000 out, net 300000", p, ok)
	}
}

func TestCapital_OutOfPocketExpenseIsInvestmentNotSpendingOfCompanyMoney(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Printer Buyer", "admin")

	s0 := readStatement(t, sf)
	id := createExpense(t, sf, map[string]any{"amount_cents": 1500000, "occurred_on": "2026-09-02",
		"paid_from": "out_of_pocket", "paid_by_person_id": person.String(), "vendor": "Printer shop"})
	s1 := readStatement(t, sf)

	if s1.CashPosition["total_cents"] != s0.CashPosition["total_cents"] {
		t.Errorf("balance moved %d → %d — company money didn't pay for this",
			s0.CashPosition["total_cents"], s1.CashPosition["total_cents"])
	}
	if d := s0.NetCents - s1.NetCents; d != 1500000 {
		t.Errorf("trading net fell by %d, want 1500000 — it's still an expense", d)
	}
	p, ok := partnerCapital(t, sf, person)
	if !ok || p.PaidPersonally != 1500000 || p.Net != 1500000 {
		t.Errorf("partner = %+v (found=%v), want 1500000 paid personally", p, ok)
	}

	// Deleting the expense takes it back out of their capital — no second write.
	callSuper(t, sf, DeleteExpense, http.MethodPost, "/v1/super/finance/expenses/"+id.String()+"/delete",
		nil, superParam("id", id.String())).expectStatus(http.StatusOK)
	if p, ok := partnerCapital(t, sf, person); ok {
		t.Errorf("partner still listed after delete: %+v", p)
	}
}

func TestCapital_OutOfPocketNeedsAKnownPerson(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{"amount_cents": 1000, "occurred_on": "2026-09-02", "paid_from": "out_of_pocket"}).
		expectStatus(http.StatusBadRequest)
	callSuper(t, sf, CreateExpense, http.MethodPost, "/v1/super/finance/expenses",
		map[string]any{"amount_cents": 1000, "occurred_on": "2026-09-02",
			"paid_from": "out_of_pocket", "paid_by_person_id": uuid.NewString()}).
		expectStatus(http.StatusBadRequest)
}

// Regression: wallet-paid expenses used to be subtracted from nothing.
func TestStatement_WalletExpenseLowersWallet(t *testing.T) {
	sf := newSuperFixture(t)
	s0 := readStatement(t, sf)
	createExpense(t, sf, map[string]any{"amount_cents": 70000, "occurred_on": "2026-09-03", "paid_from": "wallet"})
	s1 := readStatement(t, sf)
	if d := s0.CashPosition["wallet_cents"] - s1.CashPosition["wallet_cents"]; d != 70000 {
		t.Errorf("wallet fell by %d, want 70000", d)
	}
}

func TestCapital_DeleteRemovesItFromTheBalance(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Typo Founder", "admin")
	s0 := readStatement(t, sf)
	id := recordCapital(t, sf, person, "contribution", "bank", 99900)

	callSuper(t, sf, DeleteCapitalEntry, http.MethodPost, "/v1/super/finance/capital/"+id.String()+"/delete",
		nil, superParam("id", id.String())).expectStatus(http.StatusOK)
	s1 := readStatement(t, sf)
	if s1.CashPosition["total_cents"] != s0.CashPosition["total_cents"] {
		t.Errorf("balance %d → %d after delete, want unchanged",
			s0.CashPosition["total_cents"], s1.CashPosition["total_cents"])
	}
	if _, ok := partnerCapital(t, sf, person); ok {
		t.Error("person still has capital after their only entry was deleted")
	}
	callSuper(t, sf, DeleteCapitalEntry, http.MethodPost, "/v1/super/finance/capital/"+id.String()+"/delete",
		nil, superParam("id", id.String())).expectStatus(http.StatusNotFound)
}

func TestCapital_RejectsBadInput(t *testing.T) {
	sf := newSuperFixture(t)
	person := sf.seedPerson("Validator", "admin")
	for name, body := range map[string]map[string]any{
		"zero":        {"person_id": person.String(), "kind": "contribution", "account": "bank", "amount_cents": 0, "occurred_on": "2026-09-01"},
		"bad kind":    {"person_id": person.String(), "kind": "gift", "account": "bank", "amount_cents": 100, "occurred_on": "2026-09-01"},
		"bad account": {"person_id": person.String(), "kind": "contribution", "account": "cash", "amount_cents": 100, "occurred_on": "2026-09-01"},
		"bad date":    {"person_id": person.String(), "kind": "contribution", "account": "bank", "amount_cents": 100, "occurred_on": "Sept"},
		"no person":   {"person_id": uuid.NewString(), "kind": "contribution", "account": "bank", "amount_cents": 100, "occurred_on": "2026-09-01"},
	} {
		t.Run(name, func(t *testing.T) {
			callSuper(t, sf, CreateCapitalEntry, http.MethodPost, "/v1/super/finance/capital", body).
				expectStatus(http.StatusBadRequest)
		})
	}
}

// The bridge the Balance tab shows must add up exactly, after every kind of
// movement the books know about.
func TestStatement_BalanceBridgeReconciles(t *testing.T) {
	sf := newSuperFixture(t)
	founder := sf.seedPerson("Bridge Founder", "admin")
	collector := sf.seedPerson("Bridge Collector", "agent")

	recordCapital(t, sf, founder, "contribution", "bank", 30000000)
	recordCapital(t, sf, founder, "withdrawal", "wallet", 100000)
	recordCashPayment(t, sf, collector, 400000)
	callSuper(t, sf, DepositCash, http.MethodPost, "/v1/super/finance/cash/deposit",
		map[string]any{"person_id": collector.String(), "amount_cents": 150000}).
		expectStatus(http.StatusCreated)
	for _, body := range []map[string]any{
		{"amount_cents": 250000, "paid_from": "bank"},
		{"amount_cents": 30000, "paid_from": "wallet"},
		{"amount_cents": 50000, "paid_from": "person_cash", "paid_by_person_id": collector.String()},
		{"amount_cents": 80000, "paid_from": "out_of_pocket", "paid_by_person_id": founder.String()},
	} {
		body["occurred_on"] = "2026-09-04"
		createExpense(t, sf, body)
	}

	s := readStatement(t, sf)
	cp, c, a := s.CashPosition, s.Capital, s.AllTime
	if cp["total_cents"] != cp["bank_cents"]+cp["wallet_cents"]+cp["held_by_people_cents"] {
		t.Errorf("total %d ≠ bank+wallet+held %d", cp["total_cents"],
			cp["bank_cents"]+cp["wallet_cents"]+cp["held_by_people_cents"])
	}
	bridge := c["contributed_cents"] - c["withdrawn_cents"] + a["revenue_cents"] -
		a["spent_from_funds_cents"] - cp["untracked_cash_cents"]
	if bridge != cp["total_cents"] {
		t.Errorf("bridge %d ≠ balance %d (off by %d)", bridge, cp["total_cents"], bridge-cp["total_cents"])
	}
	if c["net_cents"] != c["contributed_cents"]-c["withdrawn_cents"]+c["paid_personally_cents"] {
		t.Errorf("capital net %d doesn't match its parts %+v", c["net_cents"], c)
	}
}
