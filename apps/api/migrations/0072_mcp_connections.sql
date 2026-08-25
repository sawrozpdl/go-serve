-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0072 — MCP connections: letting an owner point their own AI assistant at
-- their own café.
--
-- WHAT THIS IS
--
-- A café owner adds one URL to ChatGPT (or Claude, or Cursor) and can then ask
-- questions about their own business in whatever assistant they already use. We
-- do not build the chat; we expose the café. That is the same philosophy the
-- bulk menu import already ships with — the prompt is ours, the model is theirs.
--
-- THE TOKEN IS IN THE URL, AND THAT IS A REAL COMPROMISE
--
-- chatgpt.com's connector UI has no field for a header. None. So the only ways
-- to authenticate are OAuth 2.1 with dynamic client registration, or a secret in
-- the URL added as "no authentication". Full OAuth is the right end state and is
-- deferred; this is the shape that works today.
--
-- It is worth being honest that this codebase has rejected exactly this
-- reasoning before: 0020 introduced ws_tickets specifically so the WebSocket
-- would not "leak a bearer token in the URL / proxy logs". The mitigations here
-- are what make it defensible rather than merely convenient:
--
--   * stored as a sha256 HASH, never the secret — a database dump does not
--     yield working connectors
--   * revocable in one UPDATE, and revocation is immediate because every
--     request re-reads the row
--   * expires_at, so a forgotten connector stops working on its own
--   * SCOPED: read-only by default, and finance is off unless asked for
--   * one connection per URL, so revoking one does not disturb the others
--   * last_used_at, so an owner can see a connector they forgot about
--
-- WHY A SECURITY DEFINER LOOKUP
--
-- The token IS the tenant identity — resolving it is the step that establishes
-- which café this is, so by definition it happens before any tenant context
-- exists and RLS would return nothing. Same situation, same solution as
-- accept_invites_lookup (0010): one bounded read, gated on the caller knowing a
-- 256-bit secret. Knowledge of the secret IS the authorisation; there is nothing
-- else to gate on, and that is not a hole, it is what a bearer token means.
-- =========================================================================

CREATE TABLE mcp_connections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- What the owner called it ("Ram's ChatGPT"), so a list of three is legible.
  label      text NOT NULL,

  -- sha256 of the opaque secret, hex. The secret itself is shown once at
  -- creation and never stored, so it cannot be recovered — only replaced.
  token_hash text NOT NULL UNIQUE,

  -- The connector acts AS this member. Its permissions are theirs, intersected
  -- with `scopes` below — so a connection can only ever be narrower than the
  -- person who made it, never wider. ON DELETE CASCADE because a connection
  -- with no identity to act as is not a connection.
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Narrowing on top of the member's own grants. Never widening.
  --   read_sales      orders, items, reports
  --   read_finance    balances, drawer, credit — OFF unless explicitly asked
  --                   for, because it pushes owner financials to a third-party
  --                   model provider
  --   read_inventory  stock levels
  --   write_followup  the ONE write: accept a finding with a review date
  scopes     text[] NOT NULL DEFAULT ARRAY['read_sales']::text[]
               CHECK (scopes <@ ARRAY['read_sales','read_finance','read_inventory','write_followup']::text[]),

  last_used_at timestamptz,
  -- A forgotten connector stops working on its own. NULL means no expiry, which
  -- the handler still honours — it just never expires.
  expires_at   timestamptz,
  revoked_at   timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX mcp_connections_tenant_idx ON mcp_connections(tenant_id)
  WHERE revoked_at IS NULL;

ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_connections_isolation ON mcp_connections
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: a connector is revoked, not erased, so "who connected what and
-- when" survives. It leaves with its tenant.
GRANT SELECT, INSERT, UPDATE ON mcp_connections TO app;

-- =========================================================================
-- mcp_resolve_connection(token_hash)
--
-- Resolves a presented secret to a live connection. SECURITY DEFINER for the
-- reason in the header: this call is what establishes the tenant, so it cannot
-- itself be tenant-scoped.
--
-- Returns NOTHING for a revoked or expired connection rather than returning the
-- row and leaving the caller to check — a lookup that hands back a dead
-- credential is one refactor away from being used.
--
-- Deliberately does NOT stamp last_used_at: a STABLE function cannot write, and
-- making it VOLATILE to record a timestamp would mean every lookup takes a row
-- lock. The handler stamps it separately, best-effort, once it has tenant
-- context.
-- =========================================================================

CREATE OR REPLACE FUNCTION mcp_resolve_connection(p_token_hash text)
RETURNS TABLE (
  id        uuid,
  tenant_id uuid,
  user_id   uuid,
  scopes    text[],
  label     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT c.id, c.tenant_id, c.user_id, c.scopes, c.label
  FROM mcp_connections c
  JOIN tenants t ON t.id = c.tenant_id AND t.deleted_at IS NULL
  WHERE c.token_hash = p_token_hash
    AND c.revoked_at IS NULL
    AND (c.expires_at IS NULL OR c.expires_at > now())
$fn$;

REVOKE ALL ON FUNCTION mcp_resolve_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mcp_resolve_connection(text) TO app;

-- Back-fill the mcp:* permissions onto managers. Owners hold '*:*'.
-- Deliberately not waiter/kitchen: connecting an outside AI assistant to the
-- café's books is an ownership decision, not a service one.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'mcp:*'
FROM roles r
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DELETE FROM role_permissions rp USING roles r
WHERE rp.role_id = r.id AND r.key = 'manager' AND rp.permission = 'mcp:*';
DROP FUNCTION IF EXISTS mcp_resolve_connection(text);
DROP TABLE IF EXISTS mcp_connections;

-- +goose StatementEnd
