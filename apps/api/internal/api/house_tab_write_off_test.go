package api

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// =========================================================================
// Credit write-offs (0082)
//
// The design claim is narrow and load-bearing: a write-off reduces what a
// customer owes WITHOUT any money arriving. So it must move the balance, and it
// must not move a single figure that describes money — not the drawer, not the
// bank, not "credit collected". Every test below is one half of that sentence.
//
// The failure mode is silent in the worst way: a write-off counted as a
// collection looks exactly like a good day.
// =========================================================================

func TestWriteOff_ReducesTheBalance(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 100000, pastUTC(24*7))

	// Paid 800 of the 1000, the rest forgiven.
	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 80000, "payment_method": "cash"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)

	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 20000, "reason": "goodwill — long-standing regular"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)

	m := callHandler(t, fx, GetHouseTab, http.MethodGet, "/", nil,
		withParam("id", tabID.String())).expectStatus(http.StatusOK).json()
	ht := m["house_tab"].(map[string]any)

	if got := int64(ht["balance_cents"].(float64)); got != 0 {
		t.Fatalf("balance_cents = %d, want 0 — 800 paid + 200 forgiven clears 1000", got)
	}
	if got := int64(ht["settled_cents"].(float64)); got != 80000 {
		t.Fatalf("settled_cents = %d, want 80000 — only the money that arrived", got)
	}
	if got := int64(ht["written_off_cents"].(float64)); got != 20000 {
		t.Fatalf("written_off_cents = %d, want 20000", got)
	}
}

func TestWriteOff_IsNotCreditCollected(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 100000, pastUTC(24*7))

	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 80000, "payment_method": "cash"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 20000, "reason": "bad debt"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)

	today := localDay(t, time.Now().UTC())
	m := callHandler(t, fx, GetDashboard, http.MethodGet, "/reports/dashboard", nil,
		withQuery("range=custom&from="+today+"&to="+today)).
		expectStatus(http.StatusOK).json()
	kpis := m["kpis"].(map[string]any)

	// The whole point. 800 arrived; 200 did not.
	if got := int64(kpis["credit_collected_cents"].(float64)); got != 80000 {
		t.Fatalf("credit_collected_cents = %d, want 80000 — a write-off is not a collection", got)
	}
	if got := int64(kpis["sales_cents"].(float64)); got != 0 {
		t.Fatalf("sales_cents = %d, want 0 — neither a payment nor a write-off is a sale", got)
	}

	// The per-tab breakdown promises to sum to the KPI above.
	var sum int64
	if rows, ok := m["credit_collected_breakdown"].([]any); ok {
		for _, r := range rows {
			sum += int64(r.(map[string]any)["amount_cents"].(float64))
		}
		if sum != 80000 {
			t.Fatalf("breakdown sums to %d, want 80000 — it must match the KPI", sum)
		}
	}
}

func TestWriteOff_NeverTouchesAnAccountBucket(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 100000, pastUTC(24*7))

	before := callHandler(t, fx, GetCafeBalance, http.MethodGet, "/finance/cafe-balance", nil).
		expectStatus(http.StatusOK).json()
	beforeTotal := int64(before["total_cents"].(float64))

	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 100000, "reason": "uncollectable"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)

	after := callHandler(t, fx, GetCafeBalance, http.MethodGet, "/finance/cafe-balance", nil).
		expectStatus(http.StatusOK).json()

	// No money moved, so no account moved. This is what the NULL payment_method
	// buys: every bucket query filters on the method and NULL matches none of
	// them, so none of them had to learn what a write-off is.
	if got := int64(after["total_cents"].(float64)); got != beforeTotal {
		t.Fatalf("cafe balance moved on a write-off: %d -> %d", beforeTotal, got)
	}
	if got := int64(after["drawer_cents"].(float64)); got != int64(before["drawer_cents"].(float64)) {
		t.Fatalf("drawer moved on a write-off: %v -> %d", before["drawer_cents"], got)
	}
	if got := int64(after["bank_cents"].(float64)); got != int64(before["bank_cents"].(float64)) {
		t.Fatalf("bank moved on a write-off: %v -> %d", before["bank_cents"], got)
	}
}

func TestWriteOff_AbsentFromTheDayHistory(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 100000, pastUTC(24*7))

	callHandler(t, fx, CreateHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"amount_cents": 60000, "payment_method": "cash"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)
	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 40000, "reason": "settled short"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)

	today := localDay(t, time.Now().UTC())
	m := callHandler(t, fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("date="+today)).expectStatus(http.StatusOK).json()

	var total int64
	if rows, ok := m["credit_collections"].([]any); ok {
		for _, r := range rows {
			total += int64(r.(map[string]any)["amount_cents"].(float64))
		}
	}
	// "Who handed money over today" — the write-off did not.
	if total != 60000 {
		t.Fatalf("credit_collections total = %d, want 60000", total)
	}
}

func TestWriteOff_RejectsMoreThanIsOwed(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 50000, pastUTC(24*7))

	before := fx.countRows("house_tab_settlements")
	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 60000, "reason": "typo"},
		withParam("id", tabID.String())).expectErr(http.StatusConflict, "exceeds_balance")

	// A 4xx still COMMITS, so "was it refused" and "was nothing written" are
	// two separate questions and both have to be asked.
	if after := fx.countRows("house_tab_settlements"); after != before {
		t.Fatalf("a rejected write-off still wrote a row: %d -> %d", before, after)
	}
}

func TestWriteOff_RequiresAReason(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 50000, pastUTC(24*7))

	before := fx.countRows("house_tab_settlements")
	for _, reason := range []string{"", "   "} {
		callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
			map[string]any{"amount_cents": 1000, "reason": reason},
			withParam("id", tabID.String())).expectErr(http.StatusBadRequest, "reason_required")
	}
	if after := fx.countRows("house_tab_settlements"); after != before {
		t.Fatalf("a reasonless write-off was written anyway: %d -> %d", before, after)
	}
}

func TestWriteOff_ShapeIsEnforcedByTheDatabase(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)

	// Not the handler's rules — the table's. A future write path that forgets
	// them still cannot produce a write-off that lands in an account bucket.
	cases := []struct {
		name string
		sql  string
	}{
		{"a write-off with a payment method", `
			INSERT INTO house_tab_settlements
			  (tenant_id, house_tab_id, amount_cents, kind, payment_method, write_off_reason, recorded_by_user_id)
			VALUES ($1, $2, 100, 'write_off', 'cash', 'x', $3)`},
		{"a write-off with no reason", `
			INSERT INTO house_tab_settlements
			  (tenant_id, house_tab_id, amount_cents, kind, payment_method, write_off_reason, recorded_by_user_id)
			VALUES ($1, $2, 100, 'write_off', NULL, '', $3)`},
		{"a payment with no method", `
			INSERT INTO house_tab_settlements
			  (tenant_id, house_tab_id, amount_cents, kind, payment_method, recorded_by_user_id)
			VALUES ($1, $2, 100, 'payment', NULL, $3)`},
		{"a payment carrying a write-off reason", `
			INSERT INTO house_tab_settlements
			  (tenant_id, house_tab_id, amount_cents, kind, payment_method, write_off_reason, recorded_by_user_id)
			VALUES ($1, $2, 100, 'payment', 'cash', 'why', $3)`},
	}
	for _, c := range cases {
		if _, err := adminPool.Exec(context.Background(), c.sql, fx.Tenant, tabID, fx.User); err == nil {
			t.Fatalf("expected the kind-shape constraint to reject: %s", c.name)
		}
	}
}

func TestWriteOff_ReversalPutsTheDebtBack(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 100000, pastUTC(24*7))

	var s struct {
		ID string `json:"id"`
	}
	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 100000, "reason": "written off in error"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated).decode(&s)

	// The reversal path (0054) keys on id and never looks at kind, so sharing
	// the row means un-forgiving works with no new code.
	callHandler(t, fx, ReverseHouseTabSettlement, http.MethodPost, "/",
		map[string]any{"reason": "wrong account"},
		withParam("id", tabID.String()), withParam("settlementId", s.ID)).
		expectStatus(http.StatusOK)

	m := callHandler(t, fx, GetHouseTab, http.MethodGet, "/", nil,
		withParam("id", tabID.String())).expectStatus(http.StatusOK).json()
	ht := m["house_tab"].(map[string]any)
	if got := int64(ht["balance_cents"].(float64)); got != 100000 {
		t.Fatalf("balance after reversing the write-off = %d, want 100000", got)
	}
	if got := int64(ht["written_off_cents"].(float64)); got != 0 {
		t.Fatalf("written_off_cents after reversal = %d, want 0", got)
	}
}

func TestArchive_RefusesWhileMoneyIsStillOwed(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Ramesh", true)
	creditSaleOn(fx, tabID, 100000, pastUTC(24*7))

	// Archiving a tab that still owes money used to file a live receivable
	// under "closed business", where nobody looks at it again.
	callHandler(t, fx, UpdateHouseTab, http.MethodPatch, "/",
		map[string]any{"is_active": false}, withParam("id", tabID.String())).
		expectErr(http.StatusConflict, "balance_outstanding")

	var archivedAt *time.Time
	fx.adminScan([]any{&archivedAt}, `SELECT archived_at FROM house_tabs WHERE id = $1`, tabID)
	if archivedAt != nil {
		t.Fatal("the account was archived despite the refusal — a 4xx still commits")
	}

	// Say which it is, and the archive goes through.
	callHandler(t, fx, CreateHouseTabWriteOff, http.MethodPost, "/",
		map[string]any{"amount_cents": 100000, "reason": "never collected"},
		withParam("id", tabID.String())).expectStatus(http.StatusCreated)
	callHandler(t, fx, UpdateHouseTab, http.MethodPatch, "/",
		map[string]any{"is_active": false}, withParam("id", tabID.String())).
		expectStatus(http.StatusOK)
}

func TestArchive_StillWorksOnASettledAccount(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	tabID := fx.seedHouseTab("Clean", true)

	callHandler(t, fx, UpdateHouseTab, http.MethodPatch, "/",
		map[string]any{"is_active": false}, withParam("id", tabID.String())).
		expectStatus(http.StatusOK)
}
