package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// purge runs the SECURITY DEFINER purge_tenant_data via the superuser pool
// (mirrors the /super route's call) and returns rows deleted.
func purge(t *testing.T, tenant uuid.UUID, scopes ...string) int64 {
	t.Helper()
	var n int64
	if err := adminPool.QueryRow(context.Background(),
		`SELECT purge_tenant_data($1, $2)`, tenant, scopes).Scan(&n); err != nil {
		t.Fatalf("purge_tenant_data(%v): %v", scopes, err)
	}
	return n
}

// seedTxnSpread lays down one row through every RESTRICT-laden transaction
// path so the child-first delete order is genuinely exercised.
func seedTxnSpread(fx *fixture) {
	fx.t.Helper()
	owner := fx.seedOwner("Owner A")
	tab := fx.seedHouseTab("Supplier", true)
	shift := fx.seedOpenShift(100000)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Latte", 50000)
	table := fx.seedTable("T1")

	// order + item + a cash payment carrying the shift (payment->shift RESTRICT).
	order := fx.seedOpenOrder(&table)
	fx.seedOrderItem(order, item, 1, 50000)
	fx.seedPayment(order, "cash", 50000, &shift)

	// owner_ledger: investment + a correction of it + a loan advance + repayment
	// (self-referential corrects_id / parent_loan_id RESTRICT; loan_advance also
	// links an expense, exercising the owner_ledger -> expenses RESTRICT order).
	var inv, loan, exp uuid.UUID
	fx.adminScan([]any{&inv}, `INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, created_by_user_id)
	  VALUES ($1,$2,'investment'::owner_ledger_kind,1000,$3) RETURNING id`, fx.Tenant, owner, fx.User)
	fx.adminExec(`INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, is_correction, corrects_id, created_by_user_id)
	  VALUES ($1,$2,'investment'::owner_ledger_kind,1000,true,$3,$4)`, fx.Tenant, owner, inv, fx.User)
	fx.adminScan([]any{&exp}, `INSERT INTO expenses (tenant_id, amount_cents, paid_from, payment_method, recorded_by_user_id)
	  VALUES ($1,500,'bank','bank',$2) RETURNING id`, fx.Tenant, fx.User)
	fx.adminScan([]any{&loan}, `INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, expense_id, created_by_user_id)
	  VALUES ($1,$2,'loan_advance'::owner_ledger_kind,500,$3,$4) RETURNING id`, fx.Tenant, owner, exp, fx.User)
	fx.adminExec(`INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, parent_loan_id, created_by_user_id)
	  VALUES ($1,$2,'loan_repayment'::owner_ledger_kind,200,$3,$4)`, fx.Tenant, owner, loan, fx.User)

	// owner_cash withdrawal paired with a cash_drop + shift (RESTRICT on both).
	var drop uuid.UUID
	fx.adminScan([]any{&drop}, `INSERT INTO cash_drops (tenant_id, shift_id, direction, kind, amount_cents, recorded_by_user_id)
	  VALUES ($1,$2,'out'::cash_drop_direction,'owner_draw'::cash_drop_kind,300,$3) RETURNING id`, fx.Tenant, shift, fx.User)
	fx.adminExec(`INSERT INTO owner_cash_entries (tenant_id, owner_id, kind, amount_cents, cash_drop_id, shift_id, recorded_by_user_id)
	  VALUES ($1,$2,'withdrawal'::owner_cash_kind,300,$3,$4,$5)`, fx.Tenant, owner, drop, shift, fx.User)

	// house-tab charge (payment->house_tabs RESTRICT) + a settlement (->house_tabs, ->shift RESTRICT).
	fx.adminExec(`INSERT INTO payments (tenant_id, order_id, method, amount_cents, recorded_by_user_id, house_tab_id)
	  VALUES ($1,$2,'house_tab'::payment_method,400,$3,$4)`, fx.Tenant, order, fx.User, tab)
	fx.adminExec(`INSERT INTO house_tab_settlements (tenant_id, house_tab_id, amount_cents, payment_method, shift_id, recorded_by_user_id)
	  VALUES ($1,$2,200,'cash'::payment_method,$3,$4)`, fx.Tenant, tab, shift, fx.User)
}

func TestPurge_TransactionsKeepConfig(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	seedTxnSpread(fx)

	// No FK RESTRICT should fire — child-first order + owner_ledger two-step.
	purge(t, fx.Tenant, "transactions")

	for _, tbl := range []string{"orders", "order_items", "payments", "shifts", "cash_drops",
		"owner_ledger", "owner_cash_entries", "house_tab_settlements", "expenses"} {
		if n := fx.countRows(tbl); n != 0 {
			t.Errorf("%s = %d after transactions purge, want 0", tbl, n)
		}
	}
	// Config survives.
	for _, tbl := range []string{"menu_items", "menu_categories", "service_tables", "cafe_owners", "house_tabs"} {
		if n := fx.countRows(tbl); n == 0 {
			t.Errorf("%s = 0 after transactions purge, want kept", tbl)
		}
	}
	// Tenant survives.
	var live int
	fx.adminScan([]any{&live}, `SELECT count(*) FROM tenants WHERE id = $1`, fx.Tenant)
	if live != 1 {
		t.Errorf("tenant rows = %d, want 1 (partial purge keeps the tenant)", live)
	}
}

func TestPurge_MenuAutoIncludesTransactions(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Latte", 50000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 50000) // order_items -> menu_items RESTRICT

	// Selecting only 'menu' must still clear the orders that reference it.
	purge(t, fx.Tenant, "menu")

	if n := fx.countRows("menu_items"); n != 0 {
		t.Errorf("menu_items = %d, want 0", n)
	}
	if n := fx.countRows("orders"); n != 0 {
		t.Errorf("orders = %d, want 0 (transactions auto-included so menu can drop)", n)
	}
}

func TestPurge_EverythingRemovesTenant(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	seedTxnSpread(fx)

	purge(t, fx.Tenant, "everything")

	var tenants, users int
	fx.adminScan([]any{&tenants}, `SELECT count(*) FROM tenants WHERE id = $1`, fx.Tenant)
	fx.adminScan([]any{&users}, `SELECT count(*) FROM users WHERE id = $1`, fx.User)
	if tenants != 0 {
		t.Errorf("tenant rows = %d, want 0", tenants)
	}
	if users != 1 {
		t.Errorf("owner user = %d, want 1 (shared users survive)", users)
	}
}

func TestTenantDataCounts(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Latte", 50000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 50000)
	fx.seedPayment(order, "cash", 100000, nil)

	var counts struct {
		Menu         int `json:"menu"`
		Transactions int `json:"transactions"`
	}
	mustJSON(t, []byte(dataCounts(t, fx.Tenant)), &counts)
	if counts.Menu != 2 { // 1 item + 1 category
		t.Errorf("menu count = %d, want 2", counts.Menu)
	}
	if counts.Transactions != 3 { // 1 order + 1 item + 1 payment
		t.Errorf("transactions count = %d, want 3", counts.Transactions)
	}
}

func dataCounts(t *testing.T, tenant uuid.UUID) string {
	t.Helper()
	var raw string
	if err := adminPool.QueryRow(context.Background(),
		`SELECT tenant_data_counts($1)::text`, tenant).Scan(&raw); err != nil {
		t.Fatalf("tenant_data_counts: %v", err)
	}
	return raw
}
