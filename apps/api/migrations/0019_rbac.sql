-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- RBAC: roles, role_permissions, tenant_member_roles.
--
-- Permissions themselves are NOT stored in the DB. They live in
-- packages/rbac/permissions.json and are embedded into the Go binary; the
-- manifest is the single source of truth for both Go and TypeScript. The
-- DB only stores role grants (which roles exist per tenant + which
-- permission keys each grants).
--
-- Wildcards are stored literally:
--   "*:*"      → all permissions (owner only)
--   "menu:*"   → all permissions whose resource is "menu"
-- so adding a new menu permission to the manifest automatically extends
-- any role that already holds the wildcard.
-- =========================================================================

-- Bump this whenever any role / role_permission / tenant_member_role
-- changes for a tenant. The auth layer caches per-user permission sets
-- keyed by (tenant_id, user_id, roles_version) — incrementing this field
-- invalidates the cache for the tenant.
ALTER TABLE tenants ADD COLUMN roles_version bigint NOT NULL DEFAULT 1;

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_isolation ON roles
  USING (current_tenant_id() IS NOT NULL AND tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission ~ '^(\*|[a-z][a-z0-9_]*):(\*|[a-z][a-z0-9_]*)$'),
  PRIMARY KEY (role_id, permission)
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
-- role_permissions inherits tenant scope via roles.tenant_id. We enforce
-- the tenant check through an EXISTS lookup against roles.
CREATE POLICY role_permissions_isolation ON role_permissions
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND current_tenant_id() IS NOT NULL
        AND r.tenant_id = current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.tenant_id = current_tenant_id()
    )
  );

CREATE TABLE tenant_member_roles (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX tenant_member_roles_role_idx ON tenant_member_roles(role_id);
CREATE INDEX tenant_member_roles_member_idx ON tenant_member_roles(tenant_id, user_id);

ALTER TABLE tenant_member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_member_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_member_roles_isolation ON tenant_member_roles
  USING (
    (current_tenant_id() IS NOT NULL AND tenant_id = current_tenant_id())
    OR
    (current_tenant_id() IS NULL AND current_user_id() IS NOT NULL AND user_id = current_user_id())
  )
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- Owner-role invariants (DB-enforced).
--   1. The system 'owner' role row cannot be UPDATEd or DELETEd.
--   2. The system 'owner' role always holds exactly one permission row: '*:*'.
--   3. Each tenant has ≥1 active user holding the owner role.
-- =========================================================================

CREATE OR REPLACE FUNCTION rbac_block_owner_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.is_system AND OLD.key = 'owner') THEN
    RAISE EXCEPTION 'cannot delete the system owner role'
      USING ERRCODE = '23514';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD.is_system AND OLD.key = 'owner') THEN
    IF NEW.key <> OLD.key OR NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'cannot rename the system owner role'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

CREATE TRIGGER roles_protect_owner
  BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION rbac_block_owner_role_mutation();

CREATE OR REPLACE FUNCTION rbac_block_owner_perm_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  is_owner_role boolean;
  perm_value    text;
BEGIN
  perm_value := COALESCE(NEW.permission, OLD.permission);
  SELECT (r.is_system AND r.key = 'owner') INTO is_owner_role
    FROM roles r WHERE r.id = COALESCE(NEW.role_id, OLD.role_id);
  IF NOT COALESCE(is_owner_role, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND perm_value = '*:*' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cannot modify the system owner role permissions (always *:*)'
    USING ERRCODE = '23514';
END
$fn$;

CREATE TRIGGER role_permissions_protect_owner
  BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION rbac_block_owner_perm_change();

-- Bump tenants.roles_version on any RBAC mutation so the in-process
-- permission cache invalidates the next time a member's permissions are
-- looked up.
CREATE OR REPLACE FUNCTION rbac_bump_roles_version() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  t uuid;
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    t := COALESCE(NEW.tenant_id, OLD.tenant_id);
  ELSIF TG_TABLE_NAME = 'tenant_member_roles' THEN
    t := COALESCE(NEW.tenant_id, OLD.tenant_id);
  ELSIF TG_TABLE_NAME = 'role_permissions' THEN
    SELECT r.tenant_id INTO t FROM roles r WHERE r.id = COALESCE(NEW.role_id, OLD.role_id);
  END IF;
  IF t IS NOT NULL THEN
    UPDATE tenants SET roles_version = roles_version + 1 WHERE id = t;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

CREATE TRIGGER roles_bump_version
  AFTER INSERT OR UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION rbac_bump_roles_version();
CREATE TRIGGER role_permissions_bump_version
  AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION rbac_bump_roles_version();
CREATE TRIGGER tenant_member_roles_bump_version
  AFTER INSERT OR UPDATE OR DELETE ON tenant_member_roles
  FOR EACH ROW EXECUTE FUNCTION rbac_bump_roles_version();

-- =========================================================================
-- Seed: for every existing tenant, create the 4 system roles + grants and
-- backfill tenant_member_roles from tenant_members.roles[].
--
-- Wildcards are stored literally — adding a new permission to the manifest
-- automatically extends every wildcard grant.
-- =========================================================================

DO $seed$
DECLARE
  t           record;
  owner_id    uuid;
  manager_id  uuid;
  waiter_id   uuid;
  kitchen_id  uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO roles (tenant_id, key, name, description, is_system)
    VALUES (t.id, 'owner', 'Owner', 'Full control of this tenant. Owner permissions cannot be edited or removed.', true)
    RETURNING id INTO owner_id;
    INSERT INTO role_permissions (role_id, permission) VALUES (owner_id, '*:*');

    INSERT INTO roles (tenant_id, key, name, description, is_system)
    VALUES (t.id, 'manager', 'Manager', 'Day-to-day operational control: menu, orders, payments, inventory, shifts, expenses, reports, activity.', true)
    RETURNING id INTO manager_id;
    INSERT INTO role_permissions (role_id, permission) VALUES
      (manager_id, 'menu:*'),
      (manager_id, 'order:*'),
      (manager_id, 'payment:*'),
      (manager_id, 'adjustment:*'),
      (manager_id, 'kitchen:*'),
      (manager_id, 'table:*'),
      (manager_id, 'inventory:*'),
      (manager_id, 'shift:*'),
      (manager_id, 'account:read'),
      (manager_id, 'transfer:*'),
      (manager_id, 'expense:*'),
      (manager_id, 'house_tab:*'),
      (manager_id, 'member:read'),
      (manager_id, 'invite:read'),
      (manager_id, 'tenant:read'),
      (manager_id, 'report:read'),
      (manager_id, 'audit:read'),
      (manager_id, 'gdpr:export'),
      (manager_id, 'gdpr:delete_account');

    INSERT INTO roles (tenant_id, key, name, description, is_system)
    VALUES (t.id, 'waiter', 'Waiter', 'Floor service: open and run tabs, add items, send tickets to the kitchen.', true)
    RETURNING id INTO waiter_id;
    INSERT INTO role_permissions (role_id, permission) VALUES
      (waiter_id, 'menu:read'),
      (waiter_id, 'table:read'),
      (waiter_id, 'order:read'),
      (waiter_id, 'order:create'),
      (waiter_id, 'order:add_items'),
      (waiter_id, 'order:send_kitchen'),
      (waiter_id, 'kitchen:read'),
      (waiter_id, 'tenant:read'),
      (waiter_id, 'gdpr:export'),
      (waiter_id, 'gdpr:delete_account');

    INSERT INTO roles (tenant_id, key, name, description, is_system)
    VALUES (t.id, 'kitchen', 'Kitchen', 'Kitchen display: view incoming tickets and mark items ready.', true)
    RETURNING id INTO kitchen_id;
    INSERT INTO role_permissions (role_id, permission) VALUES
      (kitchen_id, 'menu:read'),
      (kitchen_id, 'table:read'),
      (kitchen_id, 'kitchen:read'),
      (kitchen_id, 'kitchen:update'),
      (kitchen_id, 'tenant:read'),
      (kitchen_id, 'gdpr:export'),
      (kitchen_id, 'gdpr:delete_account');

    -- Backfill tenant_member_roles from the existing tenant_members.roles
    -- ENUM array. Every (tenant_id, user_id, role_key) maps cleanly to a
    -- roles row we just created.
    INSERT INTO tenant_member_roles (tenant_id, user_id, role_id)
    SELECT tm.tenant_id, tm.user_id, r.id
    FROM tenant_members tm
    JOIN unnest(tm.roles) AS role_key ON true
    JOIN roles r ON r.tenant_id = tm.tenant_id AND r.key = role_key::text
    WHERE tm.tenant_id = t.id
    ON CONFLICT DO NOTHING;
  END LOOP;
END
$seed$;

-- =========================================================================
-- Migrate tenant_invites: roles column was tenant_role[] tied to the ENUM
-- we're about to drop. Switch to text[] of role keys (still validated at
-- accept time against the roles table).
-- =========================================================================

DROP FUNCTION IF EXISTS accept_invites_lookup(citext);

ALTER TABLE tenant_invites
  ALTER COLUMN roles TYPE text[] USING roles::text[];

CREATE OR REPLACE FUNCTION accept_invites_lookup(p_email citext)
RETURNS TABLE (id uuid, tenant_id uuid, roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT i.id, i.tenant_id, i.roles
    FROM tenant_invites i
   WHERE lower(i.email) = lower(p_email)
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL
$fn$;

REVOKE ALL ON FUNCTION accept_invites_lookup(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invites_lookup(citext) TO app;

-- =========================================================================
-- Tear down the old ENUM-based membership column and PIN-approval column.
-- After this point, membership roles are tracked exclusively through
-- tenant_member_roles → roles → role_permissions.
-- =========================================================================

ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_roles_nonempty;
ALTER TABLE tenant_members DROP COLUMN IF EXISTS roles;
ALTER TABLE tenant_members DROP COLUMN IF EXISTS pin_hash;
-- CASCADE here cleans up any lingering implicit dependencies (the
-- tenant_role[] array type, stale column defaults). All real consumers
-- (tenant_members.roles, tenant_invites.roles, accept_invites_lookup)
-- have already been migrated to text-based shapes above, so CASCADE has
-- nothing meaningful left to drop.
DROP TYPE IF EXISTS tenant_role CASCADE;

-- =========================================================================
-- Invariant: every tenant has ≥1 active user holding the owner role.
-- Implemented as a constraint trigger so callers can rearrange grants in
-- a single transaction (e.g. promote-then-demote) and only fail on commit
-- if the tenant would end up with zero owners.
-- =========================================================================

CREATE OR REPLACE FUNCTION rbac_assert_owner_present() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  t uuid;
  cnt int;
BEGIN
  t := COALESCE(NEW.tenant_id, OLD.tenant_id);
  IF t IS NULL THEN
    RETURN NULL;
  END IF;
  -- If the tenant itself was deleted in this tx the row is gone — skip.
  PERFORM 1 FROM tenants WHERE id = t;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO cnt
    FROM tenant_member_roles tmr
    JOIN roles r ON r.id = tmr.role_id
    JOIN tenant_members tm
      ON tm.tenant_id = tmr.tenant_id AND tm.user_id = tmr.user_id
    WHERE tmr.tenant_id = t
      AND r.is_system AND r.key = 'owner'
      AND tm.status = 'active';
  IF cnt = 0 THEN
    RAISE EXCEPTION 'tenant % must have at least one active owner', t
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER tenant_member_roles_owner_present
  AFTER DELETE OR UPDATE ON tenant_member_roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rbac_assert_owner_present();

-- Grant baseline privileges to the runtime DB role (CRUD via the `app`
-- group role inherited by app_user).
GRANT SELECT, INSERT, UPDATE, DELETE ON roles, role_permissions, tenant_member_roles TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Reverse the schema. Best-effort: a clean down here recreates the ENUM
-- column from tenant_member_roles so existing handler/test code keeps
-- working.
ALTER TABLE tenant_members ADD COLUMN IF NOT EXISTS pin_hash text;

DO $down_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_role') THEN
    CREATE TYPE tenant_role AS ENUM ('owner', 'manager', 'waiter', 'kitchen');
  END IF;
END
$down_enum$;

ALTER TABLE tenant_members ADD COLUMN IF NOT EXISTS roles tenant_role[];

UPDATE tenant_members tm
SET roles = sub.role_keys
FROM (
  SELECT tmr.tenant_id, tmr.user_id,
         array_agg(DISTINCT r.key::tenant_role) AS role_keys
    FROM tenant_member_roles tmr
    JOIN roles r ON r.id = tmr.role_id
   GROUP BY tmr.tenant_id, tmr.user_id
) AS sub
WHERE tm.tenant_id = sub.tenant_id AND tm.user_id = sub.user_id;

UPDATE tenant_members SET roles = '{owner}'::tenant_role[] WHERE roles IS NULL;
ALTER TABLE tenant_members ALTER COLUMN roles SET NOT NULL;
ALTER TABLE tenant_members
  ADD CONSTRAINT tenant_members_roles_nonempty CHECK (array_length(roles, 1) >= 1);

DROP TRIGGER IF EXISTS tenant_member_roles_owner_present ON tenant_member_roles;
DROP TRIGGER IF EXISTS tenant_member_roles_bump_version ON tenant_member_roles;
DROP TRIGGER IF EXISTS role_permissions_bump_version ON role_permissions;
DROP TRIGGER IF EXISTS roles_bump_version ON roles;
DROP TRIGGER IF EXISTS role_permissions_protect_owner ON role_permissions;
DROP TRIGGER IF EXISTS roles_protect_owner ON roles;
DROP TRIGGER IF EXISTS roles_updated_at ON roles;
DROP FUNCTION IF EXISTS rbac_assert_owner_present();
DROP FUNCTION IF EXISTS rbac_bump_roles_version();
DROP FUNCTION IF EXISTS rbac_block_owner_perm_change();
DROP FUNCTION IF EXISTS rbac_block_owner_role_mutation();

DROP TABLE IF EXISTS tenant_member_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;

ALTER TABLE tenants DROP COLUMN IF EXISTS roles_version;

-- +goose StatementEnd
