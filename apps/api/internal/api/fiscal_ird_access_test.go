package api

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// asIRDOfficer runs fn in a transaction whose session_user is a throwaway
// per-visit login (member of ird_auditor), as infra/datahub/ird-access.sh
// would create it.
func asIRDOfficer(t *testing.T, grantTenants []uuid.UUID, expired bool, fn func(tx pgx.Tx)) {
	t.Helper()
	ctx := context.Background()
	login := "ird_test_" + uuid.NewString()[:8]
	if _, err := adminPool.Exec(ctx, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ird_auditor') THEN CREATE ROLE ird_auditor NOLOGIN; END IF; END $$`); err != nil {
		t.Fatal(err)
	}
	// Grants on the views are given when the role exists at migration time;
	// re-grant here so the test does not depend on that ordering.
	if _, err := adminPool.Exec(ctx, `GRANT SELECT ON ird_audit_standard_view, ird_audit_credit_notes, ird_audit_purchase_book,
		ird_audit_trail, ird_audit_print_log TO ird_auditor; GRANT EXECUTE ON FUNCTION ird_can_see(uuid) TO ird_auditor`); err != nil {
		t.Fatal(err)
	}
	if _, err := adminPool.Exec(ctx, fmt.Sprintf(`CREATE ROLE %s LOGIN IN ROLE ird_auditor`, login)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM ird_access_grants WHERE login = $1`, login)
		_, _ = adminPool.Exec(context.Background(), fmt.Sprintf(`DROP ROLE IF EXISTS %s`, login))
	})
	expiry := "now() + interval '1 day'"
	if expired {
		expiry = "now() - interval '1 minute'"
	}
	for _, tn := range grantTenants {
		if _, err := adminPool.Exec(ctx, `INSERT INTO ird_access_grants (login, tenant_id, expires_at, reason)
			VALUES ($1, $2, `+expiry+`, 'test')`, login, tn); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := adminPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, fmt.Sprintf(`SET LOCAL SESSION AUTHORIZATION %s`, login)); err != nil {
		t.Fatal(err)
	}
	fn(tx)
}

func TestIRDAccess_PerTaxpayerReadOnly(t *testing.T) {
	a := newFiscalTenant(t, "vat")
	b := newFiscalTenant(t, "vat")
	settle(t, a, []int64{11300}, nil)
	settle(t, a, []int64{22600}, nil)
	settle(t, b, []int64{5650}, nil)
	ctx := context.Background()

	asIRDOfficer(t, []uuid.UUID{a.Tenant}, false, func(tx pgx.Tx) {
		var n int
		var org string
		if err := tx.QueryRow(ctx, `SELECT count(*), min(org) FROM ird_audit_standard_view`).Scan(&n, &org); err != nil {
			t.Fatal(err)
		}
		if n != 2 || org != a.Slug {
			t.Fatalf("officer sees %d rows of %q, want 2 of %q", n, org, a.Slug)
		}
		// Raw tables are out of reach.
		sp, _ := tx.Begin(ctx)
		if _, err := sp.Exec(ctx, `SELECT 1 FROM invoices LIMIT 1`); err == nil {
			t.Error("officer read the raw invoices table")
		}
		_ = sp.Rollback(ctx)
		sp, _ = tx.Begin(ctx)
		if _, err := sp.Exec(ctx, `SELECT 1 FROM fiscal_profiles LIMIT 1`); err == nil {
			t.Error("officer read fiscal profiles (CBMS credentials)")
		}
		_ = sp.Rollback(ctx)
		sp, _ = tx.Begin(ctx)
		if _, err := sp.Exec(ctx, `INSERT INTO ird_access_grants (login, tenant_id, expires_at, reason) VALUES (session_user, $1, now() + interval '1 day', 'self')`, b.Tenant); err == nil {
			t.Error("officer granted itself another taxpayer")
		}
		_ = sp.Rollback(ctx)
	})

	asIRDOfficer(t, []uuid.UUID{a.Tenant}, true, func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM ird_audit_standard_view`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("expired grant still sees %d rows", n)
		}
	})
}
