-- +goose Up
-- +goose StatementBegin

-- 0073 — mcp_resolve_connection also returns the tenant SLUG.
--
-- The loopback dispatcher (internal/mcp/dispatch.go) replays a tool call through
-- the app's own /v1 handlers, and tenant.Middleware resolves the café from
-- X-Tenant-ID, which carries a SLUG (see internal/tenant/middleware.go). Without
-- it the dispatcher would need a second cross-tenant read to turn the id into a
-- slug — and that read has no tenant context either, so it would need its own
-- escape hatch. One extra column here removes the need for a second one.
--
-- Replaces rather than overloads: two functions of the same name with different
-- return shapes is exactly the ambiguity that makes a migration hard to reason
-- about later.

DROP FUNCTION IF EXISTS mcp_resolve_connection(text);

CREATE OR REPLACE FUNCTION mcp_resolve_connection(p_token_hash text)
RETURNS TABLE (
  id          uuid,
  tenant_id   uuid,
  tenant_slug text,
  user_id     uuid,
  scopes      text[],
  label       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT c.id, c.tenant_id, t.slug::text, c.user_id, c.scopes, c.label
  FROM mcp_connections c
  JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
  WHERE c.token_hash = p_token_hash
    AND c.revoked_at IS NULL
    AND (c.expires_at IS NULL OR c.expires_at > now())
$fn$;

REVOKE ALL ON FUNCTION mcp_resolve_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mcp_resolve_connection(text) TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS mcp_resolve_connection(text);
-- +goose StatementEnd
