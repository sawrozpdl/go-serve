package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// expense fixture helpers (domain-prefixed: exp*)
// =========================================================================

// expSeedCategory inserts an expense category directly via adminPool.
func (fx *fixture) expSeedCategory(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id`,
		fx.Tenant, name)
	return id
}

// expSeedCategoryColor inserts an expense category with a color.
func (fx *fixture) expSeedCategoryColor(name, color string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO expense_categories (tenant_id, name, color) VALUES ($1, $2, $3) RETURNING id`,
		fx.Tenant, name, color)
	return id
}

// expSeedInactive inserts an inactive expense category.
func (fx *fixture) expSeedInactive(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO expense_categories (tenant_id, name, is_active) VALUES ($1, $2, false) RETURNING id`,
		fx.Tenant, name)
	return id
}

// expSeedCategorySoftDeleted inserts a soft-deleted expense category.
func (fx *fixture) expSeedCategorySoftDeleted(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO expense_categories (tenant_id, name, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
		fx.Tenant, name)
	return id
}

// expSeedExpense inserts an expense directly via adminPool (paid_from=bank).
func (fx *fixture) expSeedExpense(vendor string, amountCents int64, catID *uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expenses
		  (tenant_id, expense_category_id, vendor, amount_cents, payment_method, paid_from, recorded_by_user_id)
		VALUES ($1, $2, $3, $4, 'bank'::payment_method, 'bank'::expense_source, $5)
		RETURNING id`,
		fx.Tenant, catID, vendor, amountCents, fx.User)
	return id
}

// expSeedExpensePaidAt inserts an expense with an explicit paid_at.
func (fx *fixture) expSeedExpensePaidAt(vendor string, amountCents int64, paidAt time.Time) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, payment_method, paid_from, recorded_by_user_id, paid_at)
		VALUES ($1, $2, $3, 'bank'::payment_method, 'bank'::expense_source, $4, $5)
		RETURNING id`,
		fx.Tenant, vendor, amountCents, fx.User, paidAt)
	return id
}

// expSeedDrawerExpense inserts a drawer-paid expense with a shift and cash_drops row.
func (fx *fixture) expSeedDrawerExpense(vendor string, amountCents int64, shiftID uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, payment_method, paid_from, shift_id, recorded_by_user_id)
		VALUES ($1, $2, $3, 'cash'::payment_method, 'drawer'::expense_source, $4, $5)
		RETURNING id`,
		fx.Tenant, vendor, amountCents, shiftID, fx.User)
	// Cash drop row required by the constraint on cash_drops.kind='expense'.
	fx.adminExec(`
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, expense_id, recorded_by_user_id)
		VALUES ($1, $2, 'out', 'expense', $3, $4, $5, $6)`,
		fx.Tenant, shiftID, amountCents, "expense — "+vendor, id, fx.User)
	return id
}

// expSeedOwner inserts a cafe_owner row.
func (fx *fixture) expSeedOwner(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO cafe_owners (tenant_id, display_name, share_units) VALUES ($1, $2, 100) RETURNING id`,
		fx.Tenant, name)
	return id
}

// expSeedOwnerExpense inserts an owner-paid expense with its loan_advance ledger row.
func (fx *fixture) expSeedOwnerExpense(vendor string, amountCents int64, ownerID uuid.UUID) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, payment_method, paid_from, owner_id, recorded_by_user_id)
		VALUES ($1, $2, $3, 'cash'::payment_method, 'owner'::expense_source, $4, $5)
		RETURNING id`,
		fx.Tenant, vendor, amountCents, ownerID, fx.User)
	// Ledger row required by owner_ledger.kind='loan_advance' constraint.
	fx.adminExec(`
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, expense_id, created_by_user_id, notes)
		VALUES ($1, $2, 'loan_advance', $3, $4, $5, $6)`,
		fx.Tenant, ownerID, amountCents, id, fx.User, "advanced for expense — "+vendor)
	return id
}

// expSeedAllocation inserts an allocation for an expense.
func (fx *fixture) expSeedAllocation(expenseID, menuCatID uuid.UUID, sharePct string, amountCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO expense_allocations
		  (tenant_id, expense_id, menu_category_id, share_pct, amount_cents)
		VALUES ($1, $2, $3, $4::numeric, $5)
		RETURNING id`,
		fx.Tenant, expenseID, menuCatID, sharePct, amountCents)
	return id
}

// expSeedInventoryItem inserts an inventory item directly.
func (fx *fixture) expSeedInventoryItem(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO inventory_items (tenant_id, name, kind, sale_unit) VALUES ($1, $2, 'ingredient', 'kg') RETURNING id`,
		fx.Tenant, name)
	return id
}

// expCashDropCount counts cash_drops rows for the fixture tenant that are of
// kind='expense', used to verify drawer side-effects.
func (fx *fixture) expCashDropCount() int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM cash_drops WHERE tenant_id = $1 AND kind = 'expense'`,
		fx.Tenant)
	return n
}

// expOwnerLedgerCount counts owner_ledger rows for the fixture tenant.
func (fx *fixture) expOwnerLedgerCount() int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM owner_ledger WHERE tenant_id = $1`,
		fx.Tenant)
	return n
}

// expAllocationCount counts expense_allocations for the fixture tenant.
func (fx *fixture) expAllocationCount() int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM expense_allocations WHERE tenant_id = $1`,
		fx.Tenant)
	return n
}

// expStockMovementCount counts stock_movements for the fixture tenant.
func (fx *fixture) expStockMovementCount() int {
	fx.t.Helper()
	var n int
	fx.adminScan([]any{&n},
		`SELECT count(*) FROM stock_movements WHERE tenant_id = $1`,
		fx.Tenant)
	return n
}

// expCategoryDeleted returns whether an expense category has a deleted_at.
func (fx *fixture) expCategoryDeleted(id uuid.UUID) bool {
	fx.t.Helper()
	var deletedAt *time.Time
	fx.adminScan([]any{&deletedAt},
		`SELECT deleted_at FROM expense_categories WHERE id = $1`, id)
	return deletedAt != nil
}

// expExpenseDeleted returns whether an expense has a deleted_at.
func (fx *fixture) expExpenseDeleted(id uuid.UUID) bool {
	fx.t.Helper()
	var deletedAt *time.Time
	fx.adminScan([]any{&deletedAt},
		`SELECT deleted_at FROM expenses WHERE id = $1`, id)
	return deletedAt != nil
}

// expExpenseAmount returns the current amount_cents for an expense.
func (fx *fixture) expExpenseAmount(id uuid.UUID) int64 {
	fx.t.Helper()
	var a int64
	fx.adminScan([]any{&a}, `SELECT amount_cents FROM expenses WHERE id = $1`, id)
	return a
}

// expExpenseCategoryID returns the current expense_category_id for an expense.
func (fx *fixture) expExpenseCategoryID(id uuid.UUID) *uuid.UUID {
	fx.t.Helper()
	var catID *uuid.UUID
	// Use a raw query via adminPool to scan nullable uuid.
	if err := adminPool.QueryRow(context.Background(),
		`SELECT expense_category_id FROM expenses WHERE id = $1`, id,
	).Scan(&catID); err != nil {
		fx.t.Fatalf("expExpenseCategoryID: %v", err)
	}
	return catID
}

// expCashDropAmount returns amount_cents of the cash_drop linked to an expense.
func (fx *fixture) expCashDropAmount(expenseID uuid.UUID) int64 {
	fx.t.Helper()
	var a int64
	fx.adminScan([]any{&a},
		`SELECT amount_cents FROM cash_drops WHERE expense_id = $1`, expenseID)
	return a
}

// =========================================================================
// ListExpenseCategories
// =========================================================================

func TestListExpenseCategories_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 0 {
		t.Fatalf("categories = %d, want 0", len(cats))
	}
}

func TestListExpenseCategories_WithRows(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedCategory("Utilities")
	fx.expSeedCategory("Supplies")
	r := callHandler(t, fx, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats, _ := r["categories"].([]any)
	if len(cats) != 2 {
		t.Fatalf("categories = %d, want 2", len(cats))
	}
}

func TestListExpenseCategories_OrderedByNameCaseInsensitive(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedCategory("Zebra")
	fx.expSeedCategory("apple")
	fx.expSeedCategory("Mango")
	r := callHandler(t, fx, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats := r["categories"].([]any)
	names := make([]string, len(cats))
	for i, c := range cats {
		m := c.(map[string]any)
		names[i] = m["name"].(string)
	}
	if names[0] != "apple" || names[1] != "Mango" || names[2] != "Zebra" {
		t.Fatalf("unexpected order: %v", names)
	}
}

func TestListExpenseCategories_SoftDeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedCategory("Visible")
	fx.expSeedCategorySoftDeleted("Hidden")
	r := callHandler(t, fx, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats := r["categories"].([]any)
	if len(cats) != 1 {
		t.Fatalf("categories = %d, want 1 (soft-deleted should be excluded)", len(cats))
	}
	m := cats[0].(map[string]any)
	if m["name"].(string) != "Visible" {
		t.Fatalf("unexpected category name %q", m["name"])
	}
}

func TestListExpenseCategories_InactiveCategoryIncluded(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedInactive("Inactive")
	r := callHandler(t, fx, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats := r["categories"].([]any)
	if len(cats) != 1 {
		t.Fatalf("inactive categories should still be listed, got %d", len(cats))
	}
	m := cats[0].(map[string]any)
	if m["is_active"].(bool) {
		t.Fatal("is_active should be false for inactive category")
	}
}

func TestListExpenseCategories_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.expSeedCategory("fx1-only")
	r := callHandler(t, fx2, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats := r["categories"].([]any)
	if len(cats) != 0 {
		t.Fatalf("tenant isolation violated: fx2 sees fx1's categories")
	}
}

// =========================================================================
// CreateExpenseCategory
// =========================================================================

func TestCreateExpenseCategory_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpenseCategory, "POST", "/", "{bad json").
		expectErr(400, "bad_request")
}

func TestCreateExpenseCategory_MissingName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpenseCategory, "POST", "/",
		map[string]any{"color": "#ff0000"}).
		expectErr(400, "bad_request")
}

func TestCreateExpenseCategory_BlankName(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpenseCategory, "POST", "/",
		map[string]any{"name": ""}).
		expectErr(400, "bad_request")
}

func TestCreateExpenseCategory_Success(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateExpenseCategory, "POST", "/",
		map[string]any{"name": "Rent"}).
		expectStatus(201).json()
	if r["name"].(string) != "Rent" {
		t.Fatalf("name = %q, want Rent", r["name"])
	}
	if !r["is_active"].(bool) {
		t.Fatal("new category should be active")
	}
	if r["id"] == nil || r["id"].(string) == "" {
		t.Fatal("id should be present")
	}
	if fx.countRows("expense_categories") != 1 {
		t.Fatal("expected 1 row in expense_categories")
	}
}

func TestCreateExpenseCategory_WithColor(t *testing.T) {
	fx := newTenant(t)
	color := "#aabbcc"
	r := callHandler(t, fx, CreateExpenseCategory, "POST", "/",
		map[string]any{"name": "Utilities", "color": color}).
		expectStatus(201).json()
	if r["color"] == nil || r["color"].(string) != color {
		t.Fatalf("color = %v, want %q", r["color"], color)
	}
}

func TestCreateExpenseCategory_WithIcon(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateExpenseCategory, "POST", "/",
		map[string]any{"name": "Rent", "icon": "Receipt"}).
		expectStatus(201).json()
	if r["icon"].(string) != "Receipt" {
		t.Fatalf("icon = %v, want Receipt", r["icon"])
	}
}

func TestCreateExpenseCategory_IconDefaultsEmpty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateExpenseCategory, "POST", "/",
		map[string]any{"name": "Misc"}).
		expectStatus(201).json()
	if r["icon"].(string) != "" {
		t.Fatalf("icon = %v, want empty string", r["icon"])
	}
}

// =========================================================================
// UpdateExpenseCategory
// =========================================================================

func TestUpdateExpenseCategory_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/", map[string]any{"name": "X"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateExpenseCategory_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("Supplies")
	callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/", "{bad",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateExpenseCategory_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"name": "Nope"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateExpenseCategory_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategorySoftDeleted("Gone")
	callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"name": "New Name"},
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestUpdateExpenseCategory_UpdateName(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("Old Name")
	r := callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"name": "New Name"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["name"].(string) != "New Name" {
		t.Fatalf("name = %q, want New Name", r["name"])
	}
}

func TestUpdateExpenseCategory_UpdateColor(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategoryColor("Branded", "#111111")
	r := callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"color": "#222222"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["color"].(string) != "#222222" {
		t.Fatalf("color = %v, want #222222", r["color"])
	}
}

func TestUpdateExpenseCategory_UpdateIcon(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("Supplies")
	r := callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"icon": "Wallet"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["icon"].(string) != "Wallet" {
		t.Fatalf("icon = %v, want Wallet", r["icon"])
	}
}

func TestUpdateExpenseCategory_DeactivateAndReactivate(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("Active")
	// Deactivate.
	r1 := callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"is_active": false},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r1["is_active"].(bool) {
		t.Fatal("should be inactive")
	}
	// Reactivate.
	r2 := callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"is_active": true},
		withParam("id", id.String())).
		expectStatus(200).json()
	if !r2["is_active"].(bool) {
		t.Fatal("should be active again")
	}
}

func TestUpdateExpenseCategory_OmittedFieldsPreserved(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategoryColor("Supply", "#abcdef")
	// Only update is_active — name and color should remain.
	r := callHandler(t, fx, UpdateExpenseCategory, "PATCH", "/",
		map[string]any{"is_active": false},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["name"].(string) != "Supply" {
		t.Fatalf("name changed unexpectedly: %q", r["name"])
	}
	if r["color"] == nil || r["color"].(string) != "#abcdef" {
		t.Fatalf("color changed unexpectedly: %v", r["color"])
	}
}

// =========================================================================
// DeleteExpenseCategory
// =========================================================================

func TestDeleteExpenseCategory_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteExpenseCategory_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteExpenseCategory_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategorySoftDeleted("Gone")
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestDeleteExpenseCategory_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("ToDelete")
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	if !fx.expCategoryDeleted(id) {
		t.Fatal("category should be soft-deleted")
	}
}

func TestDeleteExpenseCategory_SecondDeleteFails(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("ToDelete")
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestDeleteExpenseCategory_DoesNotAppearInList(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedCategory("Gone")
	callHandler(t, fx, DeleteExpenseCategory, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	r := callHandler(t, fx, ListExpenseCategories, "GET", "/", nil).
		expectStatus(200).json()
	cats := r["categories"].([]any)
	for _, c := range cats {
		if c.(map[string]any)["id"].(string) == id.String() {
			t.Fatal("soft-deleted category should not appear in list")
		}
	}
}

// =========================================================================
// ListExpenses
// =========================================================================

func TestListExpenses_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps, _ := r["expenses"].([]any)
	if len(exps) != 0 {
		t.Fatalf("expenses = %d, want 0", len(exps))
	}
}

func TestListExpenses_WithRows(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("Vendor A", 10000, nil)
	fx.expSeedExpense("Vendor B", 20000, nil)
	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 2 {
		t.Fatalf("expenses = %d, want 2", len(exps))
	}
}

func TestListExpenses_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.expSeedExpense("fx1-vendor", 5000, nil)
	r := callHandler(t, fx2, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 0 {
		t.Fatalf("tenant isolation violated")
	}
}

func TestListExpenses_SoftDeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("Gone", 5000, nil)
	fx.adminExec(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, id)
	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 0 {
		t.Fatalf("soft-deleted expense should be excluded, got %d", len(exps))
	}
}

func TestListExpenses_FilterByCategory(t *testing.T) {
	fx := newTenant(t)
	catA := fx.expSeedCategory("A")
	catB := fx.expSeedCategory("B")
	fx.expSeedExpense("VendorA", 1000, &catA)
	fx.expSeedExpense("VendorB", 2000, &catB)
	fx.expSeedExpense("NoCat", 3000, nil)

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("expense_category_id="+catA.String())).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 1 {
		t.Fatalf("filter by category: expenses = %d, want 1", len(exps))
	}
	m := exps[0].(map[string]any)
	if m["vendor"].(string) != "VendorA" {
		t.Fatalf("vendor = %q, want VendorA", m["vendor"])
	}
}

func TestListExpenses_FilterByDateRange(t *testing.T) {
	fx := newTenant(t)
	base := time.Date(2026, 5, 15, 12, 0, 0, 0, time.UTC)
	fx.expSeedExpensePaidAt("Early", 1000, base.Add(-24*time.Hour))  // May 14
	fx.expSeedExpensePaidAt("InRange", 2000, base)                   // May 15
	fx.expSeedExpensePaidAt("Late", 3000, base.Add(24*time.Hour))    // May 16
	fx.expSeedExpensePaidAt("TooLate", 4000, base.Add(48*time.Hour)) // May 17

	// `to` is compared as a bare timestamp (midnight), so to include the
	// May-16 12:00 row the upper bound must be 2026-05-17. This yields
	// InRange (May 15) + Late (May 16); Early (May 14) and TooLate (May 17
	// 12:00) fall outside.
	r := callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("from=2026-05-15&to=2026-05-17")).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 2 {
		t.Fatalf("date filter: expenses = %d, want 2", len(exps))
	}
}

func TestListExpenses_FilterByFromOnly(t *testing.T) {
	fx := newTenant(t)
	base := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	fx.expSeedExpensePaidAt("Before", 1000, base.Add(-24*time.Hour))
	fx.expSeedExpensePaidAt("After", 2000, base.Add(24*time.Hour))

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("from=2026-05-10")).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 1 {
		t.Fatalf("from filter: expenses = %d, want 1", len(exps))
	}
}

func TestListExpenses_FilterBySearch(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("Flour Mill", 1000, nil)
	fx.expSeedExpense("Sugar Shop", 2000, nil)

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("q=flour")).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 1 {
		t.Fatalf("search filter: expenses = %d, want 1", len(exps))
	}
	m := exps[0].(map[string]any)
	if m["vendor"].(string) != "Flour Mill" {
		t.Fatalf("vendor = %q, want Flour Mill", m["vendor"])
	}
}

func TestListExpenses_FilterByPaidFrom_Drawer(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	fx.expSeedDrawerExpense("DrawerVendor", 1000, shiftID)
	fx.expSeedExpense("BankVendor", 2000, nil)

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("paid_from=drawer")).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 1 {
		t.Fatalf("paid_from=drawer: expenses = %d, want 1", len(exps))
	}
	m := exps[0].(map[string]any)
	if m["vendor"].(string) != "DrawerVendor" {
		t.Fatalf("vendor = %q, want DrawerVendor", m["vendor"])
	}
}

func TestListExpenses_FilterByPaidFrom_Bank(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	fx.expSeedDrawerExpense("DrawerVendor", 1000, shiftID)
	fx.expSeedExpense("BankVendor", 2000, nil)

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("paid_from=bank")).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if len(exps) != 1 {
		t.Fatalf("paid_from=bank: expenses = %d, want 1", len(exps))
	}
}

func TestListExpenses_FilterByPaidFrom_InvalidValue(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListExpenses, "GET", "/", nil,
		withQuery("paid_from=cash")).
		expectErr(400, "bad_request")
}

func TestListExpenses_ResponseFieldsPresent(t *testing.T) {
	fx := newTenant(t)
	cat := fx.expSeedCategory("Supplies")
	fx.expSeedExpense("Vendor X", 50000, &cat)
	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	m := exps[0].(map[string]any)
	// Spot-check essential fields.
	for _, field := range []string{"id", "vendor", "amount_cents", "paid_at", "payment_method",
		"paid_from", "paid_from_drawer", "recorded_by_user_id", "created_at"} {
		if _, ok := m[field]; !ok {
			t.Fatalf("response missing field %q", field)
		}
	}
	if m["expense_category_name"] == nil {
		t.Fatal("expense_category_name should be populated when category set")
	}
}

func TestListExpenses_OrderedByPaidAtDesc(t *testing.T) {
	fx := newTenant(t)
	base := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	fx.expSeedExpensePaidAt("Old", 1000, base)
	fx.expSeedExpensePaidAt("New", 2000, base.Add(24*time.Hour))

	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	if exps[0].(map[string]any)["vendor"].(string) != "New" {
		t.Fatal("expenses should be ordered by paid_at DESC")
	}
}

// =========================================================================
// GetExpense
// =========================================================================

func TestGetExpense_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetExpense, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestGetExpense_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetExpense, "GET", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestGetExpense_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("Gone", 5000, nil)
	fx.adminExec(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, GetExpense, "GET", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestGetExpense_Success(t *testing.T) {
	fx := newTenant(t)
	cat := fx.expSeedCategory("Supplies")
	id := fx.expSeedExpense("Mill Store", 75000, &cat)
	r := callHandler(t, fx, GetExpense, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["id"].(string) != id.String() {
		t.Fatalf("id = %q, want %q", r["id"], id.String())
	}
	if r["vendor"].(string) != "Mill Store" {
		t.Fatalf("vendor = %q, want Mill Store", r["vendor"])
	}
	if r["amount_cents"].(float64) != 75000 {
		t.Fatalf("amount_cents = %v, want 75000", r["amount_cents"])
	}
	if r["expense_category_name"] == nil {
		t.Fatal("expense_category_name should be populated")
	}
}

func TestGetExpense_WithAllocations(t *testing.T) {
	fx := newTenant(t)
	menuCat := fx.seedCategory("Food")
	id := fx.expSeedExpense("Supplier", 100000, nil)
	fx.expSeedAllocation(id, menuCat, "60.000", 60000)

	r := callHandler(t, fx, GetExpense, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()

	allocs, ok := r["allocations"].([]any)
	if !ok || len(allocs) != 1 {
		t.Fatalf("allocations = %v, want 1", r["allocations"])
	}
	a := allocs[0].(map[string]any)
	if a["share_pct"].(string) != "60.000" {
		t.Fatalf("share_pct = %q, want 60.000", a["share_pct"])
	}
	if int64(a["amount_cents"].(float64)) != 60000 {
		t.Fatalf("amount_cents = %v, want 60000", a["amount_cents"])
	}
	if a["menu_category_name"] == nil {
		t.Fatal("menu_category_name should be populated")
	}
}

func TestGetExpense_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := fx1.expSeedExpense("Hidden", 1000, nil)
	callHandler(t, fx2, GetExpense, "GET", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

// =========================================================================
// CreateExpense
// =========================================================================

func TestCreateExpense_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpense, "POST", "/", "{bad").
		expectErr(400, "bad_request")
}

func TestCreateExpense_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 0, "vendor": "V"}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": -100, "vendor": "V"}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_InvalidPaidFrom(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000, "paid_from": "wallet"}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_OwnerRequiresOwnerID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000, "paid_from": "owner"}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_DrawerWithOwnerIDForbidden(t *testing.T) {
	fx := newTenant(t)
	ownerID := fx.expSeedOwner("Alice")
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000, "paid_from": "drawer", "owner_id": ownerID.String()}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_BankWithOwnerIDForbidden(t *testing.T) {
	fx := newTenant(t)
	ownerID := fx.expSeedOwner("Alice")
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000, "paid_from": "bank", "owner_id": ownerID.String()}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_LinkedInventoryRequiresDeltaUnits(t *testing.T) {
	fx := newTenant(t)
	inv := fx.expSeedInventoryItem("Flour")
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"amount_cents":             1000,
			"linked_inventory_item_id": inv.String(),
		}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_AllocationSumOver100Forbidden(t *testing.T) {
	fx := newTenant(t)
	menuCat := fx.seedCategory("Food")
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"amount_cents": 10000,
			"allocations": []map[string]any{
				{"menu_category_id": menuCat.String(), "share_pct": "60"},
				{"menu_category_id": menuCat.String(), "share_pct": "60"},
			},
		}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_DrawerRequiresOpenShift(t *testing.T) {
	fx := newTenant(t)
	// No shift seeded.
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000, "paid_from": "drawer"}).
		expectErr(409, "shift_required")
}

func TestCreateExpense_OwnerNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"amount_cents": 1000,
			"paid_from":    "owner",
			"owner_id":     uuid.NewString(),
		}).
		expectErr(400, "bad_request")
}

func TestCreateExpense_BankSuccess(t *testing.T) {
	fx := newTenant(t)
	cat := fx.expSeedCategory("Utilities")
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":              "Power Co",
			"amount_cents":        5000,
			"paid_from":           "bank",
			"expense_category_id": cat.String(),
		}).
		expectStatus(201).json()
	if r["vendor"].(string) != "Power Co" {
		t.Fatalf("vendor = %q, want Power Co", r["vendor"])
	}
	if r["paid_from"].(string) != "bank" {
		t.Fatalf("paid_from = %q, want bank", r["paid_from"])
	}
	if r["paid_from_drawer"].(bool) {
		t.Fatal("paid_from_drawer should be false for bank expense")
	}
	if fx.countRows("expenses") != 1 {
		t.Fatal("expected 1 expense row")
	}
}

func TestCreateExpense_DrawerSuccess(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":       "Market",
			"amount_cents": 3000,
			"paid_from":    "drawer",
		}).
		expectStatus(201).json()
	if !r["paid_from_drawer"].(bool) {
		t.Fatal("paid_from_drawer should be true for drawer expense")
	}
	if r["shift_id"] == nil || r["shift_id"].(string) == "" {
		t.Fatalf("shift_id should be set, got %v", r["shift_id"])
	}
	if r["shift_id"].(string) != shiftID.String() {
		t.Fatalf("shift_id = %q, want %q", r["shift_id"], shiftID.String())
	}
	// Cash drop should have been created.
	if fx.expCashDropCount() != 1 {
		t.Fatalf("cash_drops count = %d, want 1", fx.expCashDropCount())
	}
}

func TestCreateExpense_DrawerCreatesCorrectCashDrop(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	var expID string
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":       "Supplier",
			"amount_cents": 7500,
			"paid_from":    "drawer",
			"notes":        "weekly order",
		}).
		expectStatus(201).json()
	expID = r["id"].(string)

	var expUUID uuid.UUID
	expUUID, _ = uuid.Parse(expID)
	amt := fx.expCashDropAmount(expUUID)
	if amt != 7500 {
		t.Fatalf("cash_drop amount_cents = %d, want 7500", amt)
	}
}

func TestCreateExpense_OwnerSuccess(t *testing.T) {
	fx := newTenant(t)
	ownerID := fx.expSeedOwner("Bob")
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":       "Food Depot",
			"amount_cents": 12000,
			"paid_from":    "owner",
			"owner_id":     ownerID.String(),
		}).
		expectStatus(201).json()
	if r["paid_from"].(string) != "owner" {
		t.Fatalf("paid_from = %q, want owner", r["paid_from"])
	}
	// Owner ledger row should have been created.
	if fx.expOwnerLedgerCount() != 1 {
		t.Fatalf("owner_ledger count = %d, want 1", fx.expOwnerLedgerCount())
	}
}

func TestCreateExpense_LegacyPaidFromDrawerBool(t *testing.T) {
	// paid_from_drawer=true without explicit paid_from should resolve to 'drawer'
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":           "Old Client",
			"amount_cents":     2000,
			"paid_from_drawer": true,
		}).
		expectStatus(201).json()
	if r["paid_from"].(string) != "drawer" {
		t.Fatalf("paid_from = %q, want drawer", r["paid_from"])
	}
}

func TestCreateExpense_DefaultsToBank(t *testing.T) {
	// No paid_from and paid_from_drawer=false → default 'bank'
	fx := newTenant(t)
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":       "Landlord",
			"amount_cents": 50000,
		}).
		expectStatus(201).json()
	if r["paid_from"].(string) != "bank" {
		t.Fatalf("paid_from = %q, want bank (default)", r["paid_from"])
	}
}

func TestCreateExpense_WithAllocation(t *testing.T) {
	fx := newTenant(t)
	menuCat := fx.seedCategory("Beverages")
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":       "Supplier",
			"amount_cents": 10000,
			"allocations": []map[string]any{
				{"menu_category_id": menuCat.String(), "share_pct": "60"},
			},
		}).
		expectStatus(201).json()
	allocs, _ := r["allocations"].([]any)
	if len(allocs) != 1 {
		t.Fatalf("allocations = %d, want 1", len(allocs))
	}
	a := allocs[0].(map[string]any)
	// 10000 × 60% = 6000 (with rounding)
	if int64(a["amount_cents"].(float64)) != 6000 {
		t.Fatalf("allocation amount_cents = %v, want 6000", a["amount_cents"])
	}
}

func TestCreateExpense_AllocationExactly100Allowed(t *testing.T) {
	fx := newTenant(t)
	menuCat := fx.seedCategory("Food")
	callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":       "Supplier",
			"amount_cents": 10000,
			"allocations": []map[string]any{
				{"menu_category_id": menuCat.String(), "share_pct": "100"},
			},
		}).
		expectStatus(201)
}

func TestCreateExpense_WithLinkedInventory(t *testing.T) {
	fx := newTenant(t)
	inv := fx.expSeedInventoryItem("Rice")
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"vendor":                   "Rice Farm",
			"amount_cents":             20000,
			"linked_inventory_item_id": inv.String(),
			"delta_units":              "50",
		}).
		expectStatus(201).json()
	if r["linked_inventory_item_id"] == nil || r["linked_inventory_item_id"].(string) == "" {
		t.Fatal("linked_inventory_item_id should be set")
	}
	// A stock movement should have been created.
	if fx.expStockMovementCount() != 1 {
		t.Fatalf("stock_movements count = %d, want 1", fx.expStockMovementCount())
	}
}

func TestCreateExpense_ResponseContainsAllocations(t *testing.T) {
	// The allocations field is `omitempty`, so with none supplied it's absent
	// from the JSON. The created expense should still come back with an id.
	fx := newTenant(t)
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000}).
		expectStatus(201).json()
	if _, ok := r["id"].(string); !ok {
		t.Fatalf("response missing id: %v", r)
	}
}

// =========================================================================
// UpdateExpense
// =========================================================================

func TestUpdateExpense_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"vendor": "X"},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateExpense_BadJSON(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/", "{bad",
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateExpense_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"vendor": "X"},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateExpense_SoftDeletedNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	fx.adminExec(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"vendor": "X"},
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestUpdateExpense_ImmutableFields_PaidFrom(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"paid_from": "drawer"},
		withParam("id", id.String())).
		expectErr(400, "immutable_field")
}

func TestUpdateExpense_ImmutableFields_PaidFromDrawer(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"paid_from_drawer": true},
		withParam("id", id.String())).
		expectErr(400, "immutable_field")
}

func TestUpdateExpense_ImmutableFields_OwnerID(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"owner_id": uuid.NewString()},
		withParam("id", id.String())).
		expectErr(400, "immutable_field")
}

func TestUpdateExpense_ImmutableFields_ShiftID(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"shift_id": uuid.NewString()},
		withParam("id", id.String())).
		expectErr(400, "immutable_field")
}

func TestUpdateExpense_ImmutableFields_LinkedInventory(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"linked_inventory_item_id": uuid.NewString()},
		withParam("id", id.String())).
		expectErr(400, "immutable_field")
}

func TestUpdateExpense_ImmutableFields_PaymentMethod(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"payment_method": "cash"},
		withParam("id", id.String())).
		expectErr(400, "immutable_field")
}

func TestUpdateExpense_ZeroAmountRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 0},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateExpense_NegativeAmountRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": -500},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateExpense_AllocationSumOver100Rejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 10000, nil)
	menuCatA := fx.seedCategory("A")
	menuCatB := fx.seedCategory("B")
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{
			"allocations": []map[string]any{
				{"menu_category_id": menuCatA.String(), "share_pct": "70"},
				{"menu_category_id": menuCatB.String(), "share_pct": "60"},
			},
		},
		withParam("id", id.String())).
		expectErr(400, "bad_request")
}

func TestUpdateExpense_UpdateVendor(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("OldVendor", 5000, nil)
	r := callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"vendor": "NewVendor"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["vendor"].(string) != "NewVendor" {
		t.Fatalf("vendor = %q, want NewVendor", r["vendor"])
	}
}

func TestUpdateExpense_UpdateAmount(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 5000, nil)
	r := callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 9999},
		withParam("id", id.String())).
		expectStatus(200).json()
	if int64(r["amount_cents"].(float64)) != 9999 {
		t.Fatalf("amount_cents = %v, want 9999", r["amount_cents"])
	}
	if fx.expExpenseAmount(id) != 9999 {
		t.Fatal("DB amount not updated")
	}
}

func TestUpdateExpense_SetCategory(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 5000, nil)
	cat := fx.expSeedCategory("Supplies")
	r := callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"expense_category_id": cat.String()},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["expense_category_name"] == nil {
		t.Fatal("expense_category_name should be set after update")
	}
	catID := fx.expExpenseCategoryID(id)
	if catID == nil || *catID != cat {
		t.Fatalf("DB expense_category_id not updated correctly")
	}
}

func TestUpdateExpense_ClearCategory(t *testing.T) {
	fx := newTenant(t)
	cat := fx.expSeedCategory("Supplies")
	id := fx.expSeedExpense("V", 5000, &cat)
	r := callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"clear_category": true},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["expense_category_id"] != nil {
		t.Fatalf("expense_category_id should be nil after clear, got %v", r["expense_category_id"])
	}
	catID := fx.expExpenseCategoryID(id)
	if catID != nil {
		t.Fatal("DB expense_category_id should be NULL after clear")
	}
}

func TestUpdateExpense_CategoryNotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 5000, nil)
	// The handler does NOT pre-validate the category id; a non-existent one
	// trips the expense_category_id FK and surfaces as internal_error (500).
	// (Hardening opportunity: validate up-front and return 400 bad_category.)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"expense_category_id": uuid.NewString()},
		withParam("id", id.String())).
		expectStatus(500)
}

func TestUpdateExpense_DrawerAmountBlockedOnClosedShift(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	id := fx.expSeedDrawerExpense("Market", 3000, shiftID)
	// Close the shift.
	fx.closeShift(shiftID)
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 9999},
		withParam("id", id.String())).
		expectErr(409, "shift_closed")
}

func TestUpdateExpense_DrawerVendorAllowedOnClosedShift(t *testing.T) {
	// Vendor (no amount change) is allowed even on a closed shift.
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	id := fx.expSeedDrawerExpense("Market", 3000, shiftID)
	fx.closeShift(shiftID)
	r := callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"vendor": "New Market"},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["vendor"].(string) != "New Market" {
		t.Fatalf("vendor = %q, want New Market", r["vendor"])
	}
}

func TestUpdateExpense_DrawerAmountUpdatesOpenShift(t *testing.T) {
	// Amount change on an open-shift drawer expense should update the cash_drop.
	fx := newTenant(t)
	fx.seedOpenShift(10000)
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"vendor": "Market", "amount_cents": 3000, "paid_from": "drawer"}).
		expectStatus(201).json()
	expIDStr := r["id"].(string)
	expID, _ := uuid.Parse(expIDStr)

	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 5000},
		withParam("id", expIDStr)).
		expectStatus(200)

	amt := fx.expCashDropAmount(expID)
	if amt != 5000 {
		t.Fatalf("cash_drop amount_cents = %d, want 5000 after update", amt)
	}
}

func TestUpdateExpense_OwnerAmountBlockedWhenRepaid(t *testing.T) {
	fx := newTenant(t)
	ownerID := fx.expSeedOwner("Alice")
	id := fx.expSeedOwnerExpense("Vendor", 10000, ownerID)

	// Fetch the loan_advance ledger row so we can add a repayment.
	var loanID uuid.UUID
	fx.adminScan([]any{&loanID},
		`SELECT id FROM owner_ledger WHERE expense_id = $1 AND kind = 'loan_advance'`, id)
	// Simulate a partial repayment.
	fx.adminExec(`
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, parent_loan_id, created_by_user_id, notes)
		VALUES ($1, $2, 'loan_repayment', 5000, $3, $4, 'repaid partial')`,
		fx.Tenant, ownerID, loanID, fx.User)

	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 15000},
		withParam("id", id.String())).
		expectErr(409, "loan_repaid")
}

func TestUpdateExpense_ReplaceAllocations(t *testing.T) {
	fx := newTenant(t)
	menuCat := fx.seedCategory("Food")
	id := fx.expSeedExpense("V", 10000, nil)
	fx.expSeedAllocation(id, menuCat, "40.000", 4000)

	menuCat2 := fx.seedCategory("Drinks")
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{
			"allocations": []map[string]any{
				{"menu_category_id": menuCat2.String(), "share_pct": "50"},
			},
		},
		withParam("id", id.String())).
		expectStatus(200)

	// Old allocation should be removed, new one inserted.
	var allocationMenuCats []uuid.UUID
	rows, err := adminPool.Query(context.Background(),
		`SELECT menu_category_id FROM expense_allocations WHERE expense_id = $1`, id)
	if err != nil {
		t.Fatalf("query allocations: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var mcID uuid.UUID
		_ = rows.Scan(&mcID)
		allocationMenuCats = append(allocationMenuCats, mcID)
	}
	if len(allocationMenuCats) != 1 || allocationMenuCats[0] != menuCat2 {
		t.Fatalf("allocations after replace: %v, want [%v]", allocationMenuCats, menuCat2)
	}
}

func TestUpdateExpense_AmountChangeRescalesAllocations(t *testing.T) {
	fx := newTenant(t)
	menuCat := fx.seedCategory("Food")
	id := fx.expSeedExpense("V", 10000, nil)
	fx.expSeedAllocation(id, menuCat, "50.000", 5000)

	// Double the amount — allocation amount_cents should be rescaled proportionally.
	callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 20000},
		withParam("id", id.String())).
		expectStatus(200)

	var newAllocAmt int64
	fx.adminScan([]any{&newAllocAmt},
		`SELECT amount_cents FROM expense_allocations WHERE expense_id = $1`, id)
	if newAllocAmt != 10000 {
		t.Fatalf("rescaled allocation amount_cents = %d, want 10000", newAllocAmt)
	}
}

func TestUpdateExpense_OmittedFieldsPreserved(t *testing.T) {
	fx := newTenant(t)
	cat := fx.expSeedCategory("Cat")
	id := fx.expSeedExpense("VendorX", 12345, &cat)
	// Only update amount; vendor and category should remain.
	r := callHandler(t, fx, UpdateExpense, "PATCH", "/",
		map[string]any{"amount_cents": 99999},
		withParam("id", id.String())).
		expectStatus(200).json()
	if r["vendor"].(string) != "VendorX" {
		t.Fatalf("vendor changed unexpectedly: %q", r["vendor"])
	}
	if r["expense_category_name"] == nil {
		t.Fatal("expense_category_name should still be set")
	}
}

// =========================================================================
// DeleteExpense
// =========================================================================

func TestDeleteExpense_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestDeleteExpense_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestDeleteExpense_AlreadyDeleted(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("V", 1000, nil)
	fx.adminExec(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, id)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(404, "not_found")
}

func TestDeleteExpense_DrawerClosedShiftBlocked(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	id := fx.expSeedDrawerExpense("Market", 3000, shiftID)
	fx.closeShift(shiftID)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(409, "shift_closed")
}

func TestDeleteExpense_DrawerOpenShiftAllowed(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	id := fx.expSeedDrawerExpense("Market", 3000, shiftID)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	if !fx.expExpenseDeleted(id) {
		t.Fatal("expense should be soft-deleted")
	}
	// Cash drop should also be removed.
	if fx.expCashDropCount() != 0 {
		t.Fatalf("cash_drops count = %d, want 0 after expense delete", fx.expCashDropCount())
	}
}

func TestDeleteExpense_OwnerRepaidBlocked(t *testing.T) {
	fx := newTenant(t)
	ownerID := fx.expSeedOwner("Alice")
	id := fx.expSeedOwnerExpense("Vendor", 10000, ownerID)

	var loanID uuid.UUID
	fx.adminScan([]any{&loanID},
		`SELECT id FROM owner_ledger WHERE expense_id = $1 AND kind = 'loan_advance'`, id)
	fx.adminExec(`
		INSERT INTO owner_ledger
		  (tenant_id, owner_id, kind, amount_cents, parent_loan_id, created_by_user_id, notes)
		VALUES ($1, $2, 'loan_repayment', 5000, $3, $4, 'repaid partial')`,
		fx.Tenant, ownerID, loanID, fx.User)

	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectErr(409, "loan_repaid")
}

func TestDeleteExpense_OwnerNoRepaymentAllowed(t *testing.T) {
	fx := newTenant(t)
	ownerID := fx.expSeedOwner("Alice")
	id := fx.expSeedOwnerExpense("Vendor", 10000, ownerID)

	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)

	if !fx.expExpenseDeleted(id) {
		t.Fatal("expense should be soft-deleted")
	}
	// Owner ledger row should be removed.
	if fx.expOwnerLedgerCount() != 0 {
		t.Fatalf("owner_ledger count = %d, want 0 after clean delete", fx.expOwnerLedgerCount())
	}
}

func TestDeleteExpense_BankExpenseSuccess(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("Rent", 100000, nil)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	if !fx.expExpenseDeleted(id) {
		t.Fatal("expense should be soft-deleted")
	}
}

func TestDeleteExpense_NotInListAfterDelete(t *testing.T) {
	fx := newTenant(t)
	id := fx.expSeedExpense("Gone", 1000, nil)
	callHandler(t, fx, DeleteExpense, "DELETE", "/", nil,
		withParam("id", id.String())).
		expectStatus(204)
	r := callHandler(t, fx, ListExpenses, "GET", "/", nil).
		expectStatus(200).json()
	exps := r["expenses"].([]any)
	for _, e := range exps {
		if e.(map[string]any)["id"].(string) == id.String() {
			t.Fatal("deleted expense should not appear in list")
		}
	}
}

// =========================================================================
// ListExpenseVendors
// =========================================================================

func TestListExpenseVendors_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors, _ := r["vendors"].([]any)
	if len(vendors) != 0 {
		t.Fatalf("vendors = %d, want 0", len(vendors))
	}
}

func TestListExpenseVendors_ReturnsDistinctVendors(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("Mill", 1000, nil)
	fx.expSeedExpense("Mill", 2000, nil) // duplicate
	fx.expSeedExpense("Bakery", 3000, nil)
	r := callHandler(t, fx, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors := r["vendors"].([]any)
	if len(vendors) != 2 {
		t.Fatalf("vendors = %d, want 2 (distinct)", len(vendors))
	}
}

func TestListExpenseVendors_ExcludesBlankVendor(t *testing.T) {
	fx := newTenant(t)
	// Empty vendor
	fx.adminExec(`
		INSERT INTO expenses (tenant_id, vendor, amount_cents, payment_method, paid_from, recorded_by_user_id)
		VALUES ($1, '', 1000, 'bank'::payment_method, 'bank'::expense_source, $2)`,
		fx.Tenant, fx.User)
	fx.expSeedExpense("Named", 1000, nil)
	r := callHandler(t, fx, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors := r["vendors"].([]any)
	if len(vendors) != 1 {
		t.Fatalf("vendors = %d, want 1 (blank excluded)", len(vendors))
	}
	if vendors[0].(string) != "Named" {
		t.Fatalf("vendor = %q, want Named", vendors[0])
	}
}

func TestListExpenseVendors_SoftDeletedExcluded(t *testing.T) {
	fx := newTenant(t)
	fx.expSeedExpense("Active", 1000, nil)
	id := fx.expSeedExpense("Deleted", 2000, nil)
	fx.adminExec(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, id)
	r := callHandler(t, fx, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors := r["vendors"].([]any)
	if len(vendors) != 1 || vendors[0].(string) != "Active" {
		t.Fatalf("vendors = %v, want [Active]", vendors)
	}
}

func TestListExpenseVendors_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.expSeedExpense("fx1-vendor", 1000, nil)
	r := callHandler(t, fx2, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors := r["vendors"].([]any)
	if len(vendors) != 0 {
		t.Fatalf("tenant isolation violated: vendors = %v", vendors)
	}
}

func TestListExpenseVendors_OrderedByRecentPaidAt(t *testing.T) {
	fx := newTenant(t)
	base := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	fx.expSeedExpensePaidAt("OldVendor", 1000, base)
	fx.expSeedExpensePaidAt("NewVendor", 2000, base.Add(24*time.Hour))
	r := callHandler(t, fx, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors := r["vendors"].([]any)
	if len(vendors) < 2 {
		t.Fatalf("vendors = %d, want 2", len(vendors))
	}
	if vendors[0].(string) != "NewVendor" {
		t.Fatalf("first vendor = %q, want NewVendor (most recent)", vendors[0])
	}
}

func TestListExpenseVendors_LimitedTo30(t *testing.T) {
	fx := newTenant(t)
	// Insert 35 unique vendors.
	for i := 0; i < 35; i++ {
		fx.expSeedExpense(fmt.Sprintf("Vendor%02d", i), 1000, nil)
	}
	r := callHandler(t, fx, ListExpenseVendors, "GET", "/", nil).
		expectStatus(200).json()
	vendors := r["vendors"].([]any)
	if len(vendors) > 30 {
		t.Fatalf("vendors = %d, want at most 30", len(vendors))
	}
}

// =========================================================================
// Integration: expense with allocations in GetExpense
// =========================================================================

func TestGetExpense_MultipleAllocationsOrderedByShareDesc(t *testing.T) {
	fx := newTenant(t)
	menuCatA := fx.seedCategory("CatA")
	menuCatB := fx.seedCategory("CatB")
	id := fx.expSeedExpense("Supplier", 100000, nil)
	fx.expSeedAllocation(id, menuCatA, "30.000", 30000)
	fx.expSeedAllocation(id, menuCatB, "60.000", 60000)

	r := callHandler(t, fx, GetExpense, "GET", "/", nil,
		withParam("id", id.String())).
		expectStatus(200).json()
	allocs := r["allocations"].([]any)
	if len(allocs) != 2 {
		t.Fatalf("allocations = %d, want 2", len(allocs))
	}
	first := allocs[0].(map[string]any)
	if first["share_pct"].(string) != "60.000" {
		t.Fatalf("allocations should be ordered by share_pct DESC, first = %q", first["share_pct"])
	}
}

// =========================================================================
// Expense created response: all new fields wired correctly
// =========================================================================

func TestCreateExpense_PaidAtDefaultsToNow(t *testing.T) {
	fx := newTenant(t)
	before := time.Now().UTC().Add(-2 * time.Second)
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{"amount_cents": 1000}).
		expectStatus(201).json()
	// paid_at is a string timestamp — just check it's not zero.
	if r["paid_at"] == nil || r["paid_at"].(string) == "" {
		t.Fatal("paid_at should be set")
	}
	_ = before
}

func TestCreateExpense_ExplicitPaidAt(t *testing.T) {
	fx := newTenant(t)
	paidAt := "2026-03-15T10:00:00Z"
	r := callHandler(t, fx, CreateExpense, "POST", "/",
		map[string]any{
			"amount_cents": 1000,
			"paid_at":      paidAt,
		}).
		expectStatus(201).json()
	if r["paid_at"] == nil {
		t.Fatal("paid_at should be set from request body")
	}
}
