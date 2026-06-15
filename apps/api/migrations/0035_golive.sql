-- +goose Up

-- =========================================================================
-- 0035 — Go-live support: opening-balance flag + tenant deep-delete.
--
-- Two unrelated-but-paired pieces of the "demo -> live" transition:
--
-- 1. owner_ledger.is_opening — marks investment rows seeded by the go-live
--    wizard as the OPENING capital baseline. They must count toward
--    lifetime-invested / ROI (GetCafeSummary.LifetimeInvested, ListCafeOwners)
--    but must NOT be re-added to the live bank tile (GetCafeBalance /
--    GetCafeSummary.CafeBalance), because the opening bank cash is already
--    represented as an opening payment. Without this flag those two views
--    double-count the bank at go-live. See finance.go.
--
--    app already holds INSERT (0014) + UPDATE/DELETE (0028) on owner_ledger,
--    and a table-wide grant covers a new column, so NO new GRANT is needed.
--
-- 2. delete_tenant_cascade(uuid) — super-admin "deep delete". A single
--    DELETE FROM tenants cascades to every tenant-scoped table (all tenant_id
--    FKs are ON DELETE CASCADE; the only non-cascade refs —
--    tenant_requests.provisioned_tenant_id and platform_audit.target_tenant_id
--    — are ON DELETE SET NULL by design so platform records survive). Wrapped
--    in SECURITY DEFINER (owned by the superuser, BYPASSRLS) so the /super
--    route — which runs as app_user with NO tenant context — can cross every
--    RLS boundary in one bounded call. Mirrors the 0025 SECURITY DEFINER
--    pattern. Callers MUST be gated by RequirePlatformAdmin in Go.
-- =========================================================================

ALTER TABLE owner_ledger ADD COLUMN is_opening boolean NOT NULL DEFAULT false;

CREATE INDEX owner_ledger_opening_idx ON owner_ledger(tenant_id) WHERE is_opening;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION delete_tenant_cascade(p_tenant uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  WITH del AS (DELETE FROM tenants WHERE id = p_tenant RETURNING 1)
  SELECT count(*)::bigint FROM del
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION delete_tenant_cascade(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_tenant_cascade(uuid) TO app;

-- +goose Down

DROP FUNCTION IF EXISTS delete_tenant_cascade(uuid);
DROP INDEX IF EXISTS owner_ledger_opening_idx;
ALTER TABLE owner_ledger DROP COLUMN IF EXISTS is_opening;
