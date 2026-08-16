package super

// Tenant cloning (migrations 0063/0064).
//
// The property that matters is that the clone is a SEPARATE café that happens to
// look identical: every id remapped, no row in the clone pointing at a row in the
// source, and the money reading the same on both sides. A clone that silently
// shares rows with production is worse than no clone, because QA would then be
// writing to the real café's data.

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

type cloneResp struct {
	ID     uuid.UUID        `json:"id"`
	Slug   string           `json:"slug"`
	Name   string           `json:"name"`
	Rows   int64            `json:"rows"`
	Counts map[string]int64 `json:"counts"`
}

// cloneSeedBusyTenant builds a café with something in every shape the clone has
// to get right: a menu with add-ons, a closed order paying to a house tab, an
// expense paid from the drawer (the FK chain that broke the purge), and an owner
// loan with a child row (a self-reference).
func cloneSeedBusyTenant(sf *superFixture) (tenantID uuid.UUID, slug string) {
	sf.t.Helper()
	tenantID, slug = sf.seedTenant("Clone Source")
	order, shift := accSeedClosedOrder(sf, tenantID, 5000)
	_ = order

	var userID uuid.UUID
	sf.adminScan([]any{&userID}, `SELECT user_id FROM platform_admins LIMIT 1`)

	// A house tab charged by that order's payment.
	var tabID uuid.UUID
	sf.adminScan([]any{&tabID}, `
		INSERT INTO house_tabs (tenant_id, name, created_by_user_id)
		VALUES ($1, 'Regular', $2) RETURNING id`, tenantID, userID)
	sf.adminExec(`UPDATE payments SET method='house_tab', house_tab_id=$2 WHERE order_id=$1`, order, tabID)
	sf.adminExec(`
		INSERT INTO house_tab_settlements (tenant_id, house_tab_id, amount_cents, payment_method, recorded_by_user_id, shift_id)
		VALUES ($1, $2, 2000, 'cash', $3, $4)`, tenantID, tabID, userID, shift)

	// An expense paid from the drawer: expenses <- cash_drops (RESTRICT). This is
	// the shape that made purge_tenant_data fail before 0064.
	var expID uuid.UUID
	sf.adminScan([]any{&expID}, `
		INSERT INTO expenses (tenant_id, vendor, amount_cents, paid_at, recorded_by_user_id, paid_from, shift_id)
		VALUES ($1, 'Gas', 1500, now(), $2, 'drawer', $3) RETURNING id`, tenantID, userID, shift)
	sf.adminExec(`
		INSERT INTO cash_drops (tenant_id, shift_id, direction, amount_cents, kind, recorded_by_user_id, expense_id)
		VALUES ($1, $2, 'out', 1500, 'expense', $3, $4)`, tenantID, shift, userID, expID)

	// An owner loan and a repayment child — owner_ledger references ITSELF, which
	// only resolves because every id map is built before any row is copied.
	var ownerID, loanID, loanExpID uuid.UUID
	sf.adminScan([]any{&ownerID}, `
		INSERT INTO cafe_owners (tenant_id, display_name, share_units) VALUES ($1, 'Jess', 10) RETURNING id`, tenantID)
	// A loan_advance is an owner paying a bill for the cafe, so the schema
	// requires the expense it funded (owner_ledger_check).
	// paid_from='owner' is the shape the constraint requires when owner_id is set.
	sf.adminScan([]any{&loanExpID}, `
		INSERT INTO expenses (tenant_id, vendor, amount_cents, paid_at, recorded_by_user_id, owner_id, paid_from)
		VALUES ($1, 'Repairs', 50000, now(), $2, $3, 'owner') RETURNING id`, tenantID, userID, ownerID)
	sf.adminScan([]any{&loanID}, `
		INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, created_by_user_id, expense_id)
		VALUES ($1, $2, 'loan_advance', 50000, $3, $4) RETURNING id`, tenantID, ownerID, userID, loanExpID)
	sf.adminExec(`
		INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, created_by_user_id, parent_loan_id)
		VALUES ($1, $2, 'loan_repayment', 10000, $3, $4)`, tenantID, ownerID, userID, loanID)

	// A CUSTOM role with a permission, plus a member holding it. System roles are
	// matched by key rather than copied (they're app-defined), so a custom role is
	// what actually exercises the role cloning path.
	var roleID uuid.UUID
	sf.adminScan([]any{&roleID}, `
		INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'barista', 'Barista', false) RETURNING id`,
		tenantID)
	sf.adminExec(`INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'order:create')`, roleID)
	sf.adminExec(`
		INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')
		ON CONFLICT DO NOTHING`, tenantID, userID)
	sf.adminExec(`
		INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING`, tenantID, userID, roleID)

	// Add-ons, so the 0062 tables are exercised too.
	var catID, itemID, grpID, modID uuid.UUID
	sf.adminScan([]any{&catID}, `SELECT id FROM menu_categories WHERE tenant_id=$1 LIMIT 1`, tenantID)
	sf.adminScan([]any{&itemID}, `SELECT id FROM menu_items WHERE tenant_id=$1 LIMIT 1`, tenantID)
	sf.adminScan([]any{&grpID}, `
		INSERT INTO menu_modifier_groups (tenant_id, name) VALUES ($1, 'Extras') RETURNING id`, tenantID)
	sf.adminScan([]any{&modID}, `
		INSERT INTO menu_modifiers (tenant_id, group_id, name, price_cents)
		VALUES ($1, $2, 'Bacon', 4000) RETURNING id`, tenantID, grpID)
	sf.adminExec(`
		INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id) VALUES ($1, $2, $3)`,
		tenantID, itemID, grpID)
	sf.adminExec(`
		INSERT INTO menu_category_modifier_groups (tenant_id, category_id, group_id) VALUES ($1, $2, $3)`,
		tenantID, catID, grpID)
	_ = modID

	return tenantID, slug
}

func doClone(sf *superFixture, srcID uuid.UUID, srcSlug string) cloneResp {
	sf.t.Helper()
	var out cloneResp
	callSuper(sf.t, sf, CloneTenant(sf.rbacRepo), http.MethodPost, "/super/tenants/x/clone",
		map[string]any{"confirm_slug": srcSlug},
		superParam("id", srcID.String())).
		expectStatus(http.StatusCreated).decode(&out)
	sf.t.Cleanup(func() {
		// context.Background(), NOT t.Context(): Go cancels the test context
		// BEFORE cleanups run, so a t.Context() here silently did nothing and
		// leaked a whole cloned tenant (~2.5k rows) per run. Matches how the rest
		// of the harness writes its cleanups.
		_, _ = adminPool.Exec(context.Background(), `SELECT purge_tenant_data($1, ARRAY['everything'])`, out.ID)
	})
	return out
}

// The headline: the clone holds the same data, and NOTHING in it points back at
// the source café.
func TestCloneTenant_CopiesEverythingWithoutSharingRows(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, srcSlug := cloneSeedBusyTenant(sf)

	got := doClone(sf, srcID, srcSlug)
	if got.Rows == 0 {
		t.Fatal("clone copied 0 rows")
	}
	if got.ID == srcID {
		t.Fatal("clone reused the source tenant id")
	}

	// Row counts match, table by table, for the tables we copy.
	for _, tbl := range []string{
		"menu_categories", "menu_items", "menu_modifier_groups", "menu_modifiers",
		"menu_item_modifier_groups", "menu_category_modifier_groups",
		"house_tabs", "house_tab_settlements", "cafe_owners", "owner_ledger",
		"orders", "order_items", "payments", "expenses", "cash_drops", "shifts",
	} {
		var src, dst int
		sf.adminScan([]any{&src}, `SELECT count(*)::int FROM `+tbl+` WHERE tenant_id = $1`, srcID)
		sf.adminScan([]any{&dst}, `SELECT count(*)::int FROM `+tbl+` WHERE tenant_id = $1`, got.ID)
		if src != dst {
			t.Errorf("%s: source has %d rows, clone has %d", tbl, src, dst)
		}
		if src == 0 {
			t.Errorf("%s: fixture seeded nothing, so this table proves nothing", tbl)
		}
	}

	// Roles are the one table that is NOT a plain copy: system roles are matched
	// by key (provisioning already made them), custom roles are cloned. So assert
	// the shape rather than the count.
	var customRoles, customPerms int
	sf.adminScan([]any{&customRoles},
		`SELECT count(*)::int FROM roles WHERE tenant_id = $1 AND NOT is_system AND key = 'barista'`, got.ID)
	if customRoles != 1 {
		t.Errorf("custom roles in clone = %d, want 1", customRoles)
	}
	sf.adminScan([]any{&customPerms}, `
		SELECT count(*)::int FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
		WHERE r.tenant_id = $1 AND r.key = 'barista'`, got.ID)
	if customPerms != 1 {
		t.Errorf("custom role permissions in clone = %d, want 1", customPerms)
	}
	// The system owner role must NOT have been duplicated.
	var ownerRoles int
	sf.adminScan([]any{&ownerRoles},
		`SELECT count(*)::int FROM roles WHERE tenant_id = $1 AND key = 'owner'`, got.ID)
	if ownerRoles != 1 {
		t.Errorf("owner roles in clone = %d, want exactly 1", ownerRoles)
	}
	// A member's role assignment survived and points INTO the clone.
	var badAssign int
	sf.adminScan([]any{&badAssign}, `
		SELECT count(*)::int FROM tenant_member_roles tmr JOIN roles r ON r.id = tmr.role_id
		WHERE tmr.tenant_id = $1 AND r.tenant_id <> $1`, got.ID)
	if badAssign != 0 {
		t.Errorf("%d role assignments in the clone point at another tenant's role", badAssign)
	}

	// No id is shared: every cloned row must be a NEW row.
	for _, tbl := range []string{"menu_items", "orders", "order_items", "payments", "house_tabs", "expenses"} {
		var shared int
		sf.adminScan([]any{&shared}, `
			SELECT count(*)::int FROM `+tbl+` a
			JOIN `+tbl+` b ON b.id = a.id
			WHERE a.tenant_id = $1 AND b.tenant_id = $2`, srcID, got.ID)
		if shared != 0 {
			t.Errorf("%s: %d rows shared an id between source and clone", tbl, shared)
		}
	}

	// And no cross-tenant reference survived the copy. These are the joins that
	// would let QA write into the real café's data.
	type leak struct{ name, sql string }
	for _, l := range []leak{
		{"order_items -> orders", `
			SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id
			WHERE oi.tenant_id = $1 AND o.tenant_id <> $1`},
		{"order_items -> menu_items", `
			SELECT count(*)::int FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
			WHERE oi.tenant_id = $1 AND mi.tenant_id <> $1`},
		{"payments -> orders", `
			SELECT count(*)::int FROM payments p JOIN orders o ON o.id = p.order_id
			WHERE p.tenant_id = $1 AND o.tenant_id <> $1`},
		{"payments -> house_tabs", `
			SELECT count(*)::int FROM payments p JOIN house_tabs h ON h.id = p.house_tab_id
			WHERE p.tenant_id = $1 AND h.tenant_id <> $1`},
		{"cash_drops -> expenses", `
			SELECT count(*)::int FROM cash_drops c JOIN expenses e ON e.id = c.expense_id
			WHERE c.tenant_id = $1 AND e.tenant_id <> $1`},
		{"owner_ledger -> itself (parent_loan_id)", `
			SELECT count(*)::int FROM owner_ledger a JOIN owner_ledger b ON b.id = a.parent_loan_id
			WHERE a.tenant_id = $1 AND b.tenant_id <> $1`},
		{"menu_item_modifier_groups -> menu_modifier_groups", `
			SELECT count(*)::int FROM menu_item_modifier_groups l JOIN menu_modifier_groups g ON g.id = l.group_id
			WHERE l.tenant_id = $1 AND g.tenant_id <> $1`},
		{"menu_items -> menu_categories", `
			SELECT count(*)::int FROM menu_items mi JOIN menu_categories c ON c.id = mi.category_id
			WHERE mi.tenant_id = $1 AND c.tenant_id <> $1`},
	} {
		var n int
		sf.adminScan([]any{&n}, l.sql, got.ID)
		if n != 0 {
			t.Errorf("clone leaks across tenants via %s (%d rows)", l.name, n)
		}
	}
}

// The books must read the same on both sides — that is the whole point of
// cloning rather than generating fake data.
func TestCloneTenant_MoneyMatchesTheSource(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, srcSlug := cloneSeedBusyTenant(sf)
	got := doClone(sf, srcID, srcSlug)

	for _, q := range []struct {
		name string
		sql  string
	}{
		{"closed sales", `SELECT COALESCE(SUM(total_cents),0)::bigint FROM orders WHERE tenant_id=$1 AND status='closed'`},
		{"payments", `SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE tenant_id=$1`},
		{"expenses", `SELECT COALESCE(SUM(amount_cents),0)::bigint FROM expenses WHERE tenant_id=$1 AND deleted_at IS NULL`},
		{"credit collected", `SELECT COALESCE(SUM(amount_cents),0)::bigint FROM house_tab_settlements WHERE tenant_id=$1 AND reversed_at IS NULL`},
		{"owner ledger", `SELECT COALESCE(SUM(amount_cents),0)::bigint FROM owner_ledger WHERE tenant_id=$1`},
		{"line money", `SELECT COALESCE(SUM(qty*unit_price_cents),0)::bigint FROM order_items WHERE tenant_id=$1`},
	} {
		var src, dst int64
		sf.adminScan([]any{&src}, q.sql, srcID)
		sf.adminScan([]any{&dst}, q.sql, got.ID)
		if src != dst {
			t.Errorf("%s: source %d, clone %d", q.name, src, dst)
		}
		if src == 0 {
			t.Errorf("%s: zero on both sides, so this comparison proves nothing", q.name)
		}
	}

	// The add-on fold invariant must hold inside the clone too.
	var folds int
	sf.adminScan([]any{&folds}, `
		SELECT count(*)::int FROM order_items oi
		WHERE oi.tenant_id = $1
		  AND oi.unit_price_cents <> oi.base_price_cents
		      + COALESCE((SELECT SUM(round(m.qty*m.price_cents)) FROM order_item_modifiers m
		                   WHERE m.order_item_id = oi.id), 0)`, got.ID)
	if folds != 0 {
		t.Errorf("clone has %d lines whose add-on fold does not reconcile", folds)
	}
}

// A clone is flagged as one, and comped, so it can't be mistaken for a paying
// café or start a trial clock someone has to chase.
func TestCloneTenant_IsMarkedAndComped(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, srcSlug := cloneSeedBusyTenant(sf)
	got := doClone(sf, srcID, srcSlug)

	var from *uuid.UUID
	var clonedAt, trialEnds, paidThrough *string
	sf.adminScan([]any{&from, &clonedAt, &trialEnds, &paidThrough}, `
		SELECT cloned_from_tenant_id, cloned_at::text, trial_ends_at::text, paid_through_at::text
		FROM tenants WHERE id = $1`, got.ID)
	if from == nil || *from != srcID {
		t.Errorf("cloned_from_tenant_id = %v, want %v", from, srcID)
	}
	if clonedAt == nil {
		t.Error("cloned_at not stamped")
	}
	if trialEnds != nil {
		t.Errorf("trial_ends_at = %v, want NULL — a clone must not run a trial clock", *trialEnds)
	}
	if paidThrough == nil {
		t.Error("paid_through_at not set — the clone would show as past due")
	}
}

// Cloning is gated on typing the SOURCE slug. It copies a real café's books,
// including customer names, so it asks the operator to name what they're copying.
func TestCloneTenant_RequiresTypedConfirmation(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, srcSlug := cloneSeedBusyTenant(sf)

	callSuper(t, sf, CloneTenant(sf.rbacRepo), http.MethodPost, "/super/tenants/x/clone",
		map[string]any{"confirm_slug": "not-the-slug"},
		superParam("id", srcID.String())).
		expectStatus(http.StatusBadRequest)

	// Nothing was provisioned by the refused attempt.
	var clones int
	sf.adminScan([]any{&clones},
		`SELECT count(*)::int FROM tenants WHERE cloned_from_tenant_id = $1`, srcID)
	if clones != 0 {
		t.Errorf("a rejected clone still provisioned %d tenant(s)", clones)
	}
	_ = srcSlug
}

// Cloning a clone compounds drift; the original is always the right source.
func TestCloneTenant_RefusesToCloneAClone(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, srcSlug := cloneSeedBusyTenant(sf)
	first := doClone(sf, srcID, srcSlug)

	callSuper(t, sf, CloneTenant(sf.rbacRepo), http.MethodPost, "/super/tenants/x/clone",
		map[string]any{"confirm_slug": first.Slug},
		superParam("id", first.ID.String())).
		expectStatus(http.StatusConflict)
}

// The destination must be empty. Guards against a second clone landing on top of
// the first and producing a tenant made of two cafés.
func TestCloneTenantData_RefusesANonEmptyDestination(t *testing.T) {
	sf := newSuperFixture(t)
	srcID, _ := cloneSeedBusyTenant(sf)
	dstID, _ := cloneSeedBusyTenant(sf) // already has a menu + orders

	_, err := adminPool.Exec(context.Background(), `SELECT clone_tenant_data($1, $2)`, srcID, dstID)
	if err == nil {
		t.Fatal("cloning into a tenant that already has data was allowed")
	}
}

// 0064: the purge used to abort on any café with a drawer-paid expense, because
// it deleted expenses before cash_drops (which RESTRICT-references them) and
// never deleted staff_pay at all in the transactions scope. Both are the normal
// shape, so this covers the whole super-admin delete path.
func TestPurgeTenantData_HandlesDrawerPaidExpenses(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := cloneSeedBusyTenant(sf)

	// A salary payment too — staff_pay.expense_id was the second blocker.
	var userID, staffID, expID uuid.UUID
	sf.adminScan([]any{&userID}, `SELECT user_id FROM platform_admins LIMIT 1`)
	sf.adminScan([]any{&staffID}, `
		INSERT INTO staff (tenant_id, full_name) VALUES ($1, 'Ramesh') RETURNING id`, tenantID)
	sf.adminScan([]any{&expID}, `
		INSERT INTO expenses (tenant_id, vendor, amount_cents, paid_at, recorded_by_user_id, paid_from, payment_method)
		VALUES ($1, 'Salary', 20000, now(), $2, 'bank', 'bank') RETURNING id`, tenantID, userID)
	sf.adminExec(`
		INSERT INTO staff_pay (tenant_id, staff_id, amount, paid_on, period_label, created_by_user_id, expense_id)
		VALUES ($1, $2, 200.00, current_date, 'Aug', $3, $4)`, tenantID, staffID, userID, expID)

	var removed int64
	sf.adminScan([]any{&removed},
		`SELECT purge_tenant_data($1, ARRAY['transactions'])`, tenantID)
	if removed == 0 {
		t.Fatal("purge removed nothing")
	}

	for _, tbl := range []string{"expenses", "cash_drops", "orders", "shifts", "staff_pay"} {
		var left int
		sf.adminScan([]any{&left}, `SELECT count(*)::int FROM `+tbl+` WHERE tenant_id = $1`, tenantID)
		if left != 0 {
			t.Errorf("%s: %d rows survived the purge", tbl, left)
		}
	}
}
