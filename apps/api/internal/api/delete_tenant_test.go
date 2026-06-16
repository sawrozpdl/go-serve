package api

import (
	"context"
	"encoding/json"
	"testing"
)

func TestDeleteTenantCascade_RemovesEverythingButUsers(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	// Seed a spread of child rows across cascade depths.
	cat := fx.seedCategory("Coffee")
	item := fx.seedMenuItem(cat, "Latte", 50000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 50000)
	fx.seedPayment(order, "cash", 50000, nil)
	owner := fx.seedOwner("Owner A")
	fx.adminExec(`INSERT INTO owner_ledger (tenant_id, owner_id, kind, amount_cents, created_by_user_id)
	              VALUES ($1, $2, 'investment'::owner_ledger_kind, 1000, $3)`, fx.Tenant, owner, fx.User)

	ctx := context.Background()
	var deleted int64
	if err := adminPool.QueryRow(ctx, `SELECT delete_tenant_cascade($1)`, fx.Tenant).Scan(&deleted); err != nil {
		t.Fatalf("delete_tenant_cascade: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}

	// Tenant + every child gone.
	for _, q := range []struct {
		table string
		sql   string
	}{
		{"tenants", `SELECT count(*) FROM tenants WHERE id = $1`},
		{"orders", `SELECT count(*) FROM orders WHERE tenant_id = $1`},
		{"order_items", `SELECT count(*) FROM order_items WHERE tenant_id = $1`},
		{"payments", `SELECT count(*) FROM payments WHERE tenant_id = $1`},
		{"owner_ledger", `SELECT count(*) FROM owner_ledger WHERE tenant_id = $1`},
		{"cafe_owners", `SELECT count(*) FROM cafe_owners WHERE tenant_id = $1`},
		{"menu_items", `SELECT count(*) FROM menu_items WHERE tenant_id = $1`},
		{"tenant_members", `SELECT count(*) FROM tenant_members WHERE tenant_id = $1`},
	} {
		var n int
		if err := adminPool.QueryRow(ctx, q.sql, fx.Tenant).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", q.table, err)
		}
		if n != 0 {
			t.Errorf("%s still has %d rows after deep delete", q.table, n)
		}
	}

	// Shared user survives (only the membership cascaded away).
	var users int
	if err := adminPool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, fx.User).Scan(&users); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if users != 1 {
		t.Errorf("owner user count = %d, want 1 (users are shared, not deleted)", users)
	}
}

// mustJSON unmarshals a response body or fails the test.
func mustJSON(t *testing.T, body []byte, dst any) {
	t.Helper()
	if err := json.Unmarshal(body, dst); err != nil {
		t.Fatalf("unmarshal: %v; body: %s", err, string(body))
	}
}
