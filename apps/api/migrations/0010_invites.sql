-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- TENANT_INVITES
-- An owner pre-creates a pending invite keyed by email + role(s). When the
-- invited user signs in (Google or dev), the auth flow turns matching
-- pending invites into active tenant_members rows. No link, no token —
-- the email *is* the join key.
--
-- Why a separate table (vs. a pending tenant_members row):
--   - tenant_members.user_id is NOT NULL — we don't know the user_id until
--     they first authenticate.
--   - Keeps the invite lifecycle (pending → accepted/revoked) cleanly
--     separable from membership state (active/suspended).
-- =========================================================================

CREATE TABLE tenant_invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email               citext NOT NULL,
  roles               tenant_role[] NOT NULL,
  invited_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at          timestamptz,
  CONSTRAINT tenant_invites_roles_nonempty CHECK (array_length(roles, 1) >= 1),
  CONSTRAINT tenant_invites_one_terminal CHECK (
    NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

-- One outstanding invite per (tenant, email). Re-inviting after revoke is
-- fine; re-inviting while pending is a 409.
CREATE UNIQUE INDEX tenant_invites_unique_pending
  ON tenant_invites (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX tenant_invites_email_pending_idx
  ON tenant_invites (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE tenant_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invites FORCE ROW LEVEL SECURITY;

-- Tenant-scoped: invites are visible/editable only when the request is
-- bound to the inviting tenant. The accept-on-login flow runs server-side
-- with elevated context (it sets app.tenant_id per invite row) so RLS is
-- satisfied there too.
CREATE POLICY tenant_invites_isolation ON tenant_invites
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_invites TO app;

-- =========================================================================
-- accept_invites_lookup(email)
-- The auth flow (post-login) needs to read pending invites for the freshly
-- authenticated user, BUT no tenant context has been established yet, so
-- the row-level policy would hide every row. This SECURITY DEFINER helper
-- runs with the owner's privileges (the migration role, superuser-ish) and
-- bypasses RLS for this single bounded read. Caller is responsible for
-- only invoking with the verified email of the current session.
-- =========================================================================

CREATE OR REPLACE FUNCTION accept_invites_lookup(p_email citext)
RETURNS TABLE (id uuid, tenant_id uuid, roles tenant_role[])
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT id, tenant_id, roles
  FROM tenant_invites
  WHERE email = p_email
    AND accepted_at IS NULL
    AND revoked_at IS NULL
$fn$;

REVOKE ALL ON FUNCTION accept_invites_lookup(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invites_lookup(citext) TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS accept_invites_lookup(citext);
DROP TABLE IF EXISTS tenant_invites;
-- +goose StatementEnd
