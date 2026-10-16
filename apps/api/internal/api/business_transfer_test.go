package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

func (fx *fixture) seedStock(name string, qty string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `INSERT INTO inventory_items (tenant_id, name, sale_unit, qty_on_hand_units, last_purchase_unit_cost_cents)
		VALUES ($1, $2, 'ml', $3::numeric, 12) RETURNING id`, fx.Tenant, name, qty)
	return id
}

func (fx *fixture) onHand(name string) (string, bool) {
	fx.t.Helper()
	if fx.count(`SELECT count(*) FROM inventory_items WHERE tenant_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`, fx.Tenant, name) == 0 {
		return "", false
	}
	var q string
	fx.adminScan([]any{&q}, `SELECT qty_on_hand_units::numeric(14,0)::text FROM inventory_items WHERE tenant_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`, fx.Tenant, name)
	return q, true
}

func transfer(t *testing.T, from *fixture, body map[string]any) *apiResp {
	t.Helper()
	return callHandler(t, from, CreateStockTransfer(appPool, rbac.NewRepo(nil, nil)), http.MethodPost, "/v1/business/stock-transfers", body)
}

func transferPair(t *testing.T) (*fixture, *fixture) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Stock Group", a, b)
	joinBranch(t, b, a.User, "owner")
	for _, fx := range []*fixture{a, b} {
		fx.grantFeatures("inventory")
	}
	return a, b
}

func TestStockTransfer_MovesStockAndCreatesTheItemThere(t *testing.T) {
	a, b := transferPair(t)
	milk := a.seedStock("Milk", "5000")
	var pr uuid.UUID
	a.adminScan([]any{&pr}, `INSERT INTO pack_rules (tenant_id, inventory_item_id, container_unit, container_qty, sale_unit, sale_qty_per_container)
		VALUES ($1, $2, 'carton', 1, 'ml', 1000) RETURNING id`, a.Tenant, milk)

	transfer(t, a, map[string]any{"to": b.Slug, "lines": []map[string]any{{"inventory_item_id": milk, "qty_units": "2000"}}}).
		expectStatus(http.StatusCreated)

	if q, _ := a.onHand("Milk"); q != "3000" {
		t.Fatalf("sender on hand = %s, want 3000", q)
	}
	if q, ok := b.onHand("Milk"); !ok || q != "2000" {
		t.Fatalf("receiver on hand = %s (exists %v), want 2000", q, ok)
	}
	if n := b.count(`SELECT count(*) FROM pack_rules p JOIN inventory_items i ON i.id = p.inventory_item_id
		WHERE i.tenant_id = $1 AND i.name = 'Milk' AND p.container_unit = 'carton'`, b.Tenant); n != 1 {
		t.Fatal("the new item at the receiver didn't get the sender's pack rule")
	}
	// Both legs share one transfer id.
	if n := a.count(`SELECT count(DISTINCT ref_id) FROM stock_movements WHERE ref_type = 'branch_transfer' AND tenant_id IN ($1, $2)`, a.Tenant, b.Tenant); n != 1 {
		t.Fatalf("legs carry %d transfer ids, want 1", n)
	}
}

func TestStockTransfer_AddsToAnExistingItemByName(t *testing.T) {
	a, b := transferPair(t)
	milk := a.seedStock("Milk", "5000")
	b.seedStock("milk", "100")
	transfer(t, a, map[string]any{"to": b.Slug, "lines": []map[string]any{{"inventory_item_id": milk, "qty_units": "900"}}}).
		expectStatus(http.StatusCreated)
	if q, _ := b.onHand("milk"); q != "1000" {
		t.Fatalf("receiver on hand = %s, want 1000", q)
	}
	if n := b.count(`SELECT count(*) FROM inventory_items WHERE tenant_id = $1`, b.Tenant); n != 1 {
		t.Fatal("a duplicate item was created at the receiver")
	}
}

func TestStockTransfer_RefusesMoreThanOnHand(t *testing.T) {
	a, b := transferPair(t)
	milk := a.seedStock("Milk", "500")
	transfer(t, a, map[string]any{"to": b.Slug, "lines": []map[string]any{{"inventory_item_id": milk, "qty_units": "501"}}}).
		expectErr(http.StatusConflict, "insufficient_stock")
	if q, _ := a.onHand("Milk"); q != "500" {
		t.Fatalf("sender changed: %s", q)
	}
}

// The receiving side refuses AFTER the sending side was written: the savepoint
// must undo the send, even though a 4xx response commits the request tx.
func TestStockTransfer_RefusalAtReceiverLeavesBothUntouched(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Half Group", a, b)
	a.grantFeatures("inventory")
	b.grantFeatures("inventory")
	// A custom role at b that may adjust stock but not create items.
	var role uuid.UUID
	b.adminScan([]any{&role}, `INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'stocker', 'Stocker', false) RETURNING id`, b.Tenant)
	b.adminExec(`INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'inventory:adjust'), ($1, 'inventory:read')`, role)
	b.adminExec(`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`, b.Tenant, a.User)
	b.adminExec(`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, b.Tenant, a.User, role)

	milk := a.seedStock("Milk", "5000")
	sugar := a.seedStock("Sugar", "800")
	b.seedStock("Milk", "0") // Milk exists there, Sugar doesn't → needs inventory:create
	resp := transfer(t, a, map[string]any{"to": b.Slug, "lines": []map[string]any{
		{"inventory_item_id": milk, "qty_units": "1000"},
		{"inventory_item_id": sugar, "qty_units": "100"},
	}})
	resp.expectErr(http.StatusForbidden, "forbidden")
	// The refusal must come from the RECEIVING side (Sugar needs creating),
	// i.e. after Milk's send was already written — otherwise this proves nothing.
	if !strings.Contains(resp.errMsg(), "can't add inventory items") {
		t.Fatalf("refused for the wrong reason: %s", resp.errMsg())
	}

	if q, _ := a.onHand("Milk"); q != "5000" {
		t.Fatalf("sender Milk = %s; the send was not rolled back", q)
	}
	if q, _ := b.onHand("Milk"); q != "0" {
		t.Fatalf("receiver Milk = %s; a half transfer landed", q)
	}
	if n := a.count(`SELECT count(*) FROM stock_movements WHERE ref_type = 'branch_transfer' AND tenant_id IN ($1, $2)`, a.Tenant, b.Tenant); n != 0 {
		t.Fatalf("%d transfer movements survived a refused transfer", n)
	}
}

func TestStockTransfer_ReceiverMustBeAnotherBranchYouCanAdjust(t *testing.T) {
	a, b := transferPair(t)
	other := newTenant(t)
	milk := a.seedStock("Milk", "500")
	transfer(t, a, map[string]any{"to": other.Slug, "lines": []map[string]any{{"inventory_item_id": milk, "qty_units": "1"}}}).
		expectErr(http.StatusNotFound, "not_found")

	// Demote a.User at b to waiter (no inventory:adjust).
	b.adminExec(`UPDATE tenant_member_roles SET role_id = (SELECT id FROM roles WHERE tenant_id = $1 AND key = 'waiter')
		WHERE tenant_id = $1 AND user_id = $2`, b.Tenant, a.User)
	transfer(t, a, map[string]any{"to": b.Slug, "lines": []map[string]any{{"inventory_item_id": milk, "qty_units": "1"}}}).
		expectErr(http.StatusForbidden, "forbidden")
}

func TestStockTransfer_ListedOnBothSides(t *testing.T) {
	a, b := transferPair(t)
	milk := a.seedStock("Milk", "500")
	transfer(t, a, map[string]any{"to": b.Slug, "note": "for the weekend", "lines": []map[string]any{{"inventory_item_id": milk, "qty_units": "200"}}}).
		expectStatus(http.StatusCreated)
	var la, lb struct {
		Transfers []TransferRow `json:"transfers"`
	}
	callHandler(t, a, ListStockTransfers, http.MethodGet, "/x", nil).expectStatus(http.StatusOK).decode(&la)
	callHandler(t, b, ListStockTransfers, http.MethodGet, "/x", nil, actingAs(a.User)).expectStatus(http.StatusOK).decode(&lb)
	if len(la.Transfers) != 1 || la.Transfers[0].Direction != "out" || len(lb.Transfers) != 1 || lb.Transfers[0].Direction != "in" {
		t.Fatalf("sender %+v / receiver %+v", la.Transfers, lb.Transfers)
	}
	if la.Transfers[0].ID != lb.Transfers[0].ID {
		t.Fatal("the two sides show different transfers")
	}
}
