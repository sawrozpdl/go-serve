package api

import (
	"context"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// TenantPreferences mirrors the JSON shape we accept in PATCH /v1/tenant.
// All fields are optional — unset means default. Some defaults are true
// (stackItems, discountAutoApply, autoRecordPayment) — these are the modern
// ergonomic defaults that new workspaces should get even with no preferences row.
type TenantPreferences struct {
	AutoServeOnReady  bool `json:"autoServeOnReady"`
	AutoCleanTables   bool `json:"autoCleanTables"`
	CombinedSettle    bool `json:"combinedSettle"`
	StackItems        bool `json:"stackItems"`
	DiscountAutoApply bool `json:"discountAutoApply"`
	AutoRecordPayment bool `json:"autoRecordPayment"`
	RequireTxnRef     bool `json:"requireTxnRef"`
}

// loadTenantPreferences reads the preferences jsonb for the current tenant.
// Reads through the request transaction so RLS scoping is consistent. On any
// error returns zero values — the calling code falls back to default behavior.
func loadTenantPreferences(ctx context.Context, tenantID uuid.UUID) TenantPreferences {
	tx := appctx.Tx(ctx)
	var p TenantPreferences
	_ = tx.QueryRow(ctx, `
		SELECT
		  COALESCE((preferences->>'autoServeOnReady')::boolean,  false),
		  COALESCE((preferences->>'autoCleanTables')::boolean,   false),
		  COALESCE((preferences->>'combinedSettle')::boolean,    false),
		  COALESCE((preferences->>'stackItems')::boolean,        true),
		  COALESCE((preferences->>'discountAutoApply')::boolean, true),
		  COALESCE((preferences->>'autoRecordPayment')::boolean, true),
		  COALESCE((preferences->>'requireTxnRef')::boolean,     false)
		FROM tenants WHERE id = $1
	`, tenantID).Scan(
		&p.AutoServeOnReady, &p.AutoCleanTables, &p.CombinedSettle,
		&p.StackItems, &p.DiscountAutoApply, &p.AutoRecordPayment, &p.RequireTxnRef,
	)
	return p
}
