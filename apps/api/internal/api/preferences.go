package api

import (
	"context"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// TenantPreferences mirrors the JSON shape we accept in PATCH /v1/tenant.
// All fields are optional — unset means "default off".
type TenantPreferences struct {
	AutoServeOnReady bool `json:"autoServeOnReady"`
	AutoCleanTables  bool `json:"autoCleanTables"`
	CombinedSettle   bool `json:"combinedSettle"`
}

// loadTenantPreferences reads the preferences jsonb for the current tenant.
// Reads through the request transaction so RLS scoping is consistent. On any
// error returns zero values — the calling code falls back to default behavior.
func loadTenantPreferences(ctx context.Context, tenantID uuid.UUID) TenantPreferences {
	tx := appctx.Tx(ctx)
	var p TenantPreferences
	// Pull individual flags directly from jsonb so we don't have to round-trip
	// a JSON decode for three booleans.
	_ = tx.QueryRow(ctx, `
		SELECT
		  COALESCE((preferences->>'autoServeOnReady')::boolean, false),
		  COALESCE((preferences->>'autoCleanTables')::boolean,  false),
		  COALESCE((preferences->>'combinedSettle')::boolean,   false)
		FROM tenants WHERE id = $1
	`, tenantID).Scan(&p.AutoServeOnReady, &p.AutoCleanTables, &p.CombinedSettle)
	return p
}
