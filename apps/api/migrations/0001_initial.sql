-- +goose Up
-- +goose StatementBegin

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- =========================================================================
-- App roles
--
-- The DB owner (set by POSTGRES_USER in the Docker image) is a superuser
-- with BYPASSRLS, so RLS does NOT apply when connecting as that role.
-- Migrations and seed scripts run as the owner; runtime traffic must
-- connect as `app_user` (which is non-superuser, NOBYPASSRLS, member of
-- group role `app` which has CRUD privileges).
-- =========================================================================

DO $do$ BEGIN
  CREATE ROLE app NOLOGIN NOBYPASSRLS NOSUPERUSER;
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;

DO $do$ BEGIN
  CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user' NOBYPASSRLS NOSUPERUSER;
  GRANT app TO app_user;
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;

GRANT USAGE ON SCHEMA public TO app;

-- =========================================================================
-- Helpers: read tenant + user context set by middleware via SET LOCAL.
-- A NULL return means "no context set" — policies treat this as "deny all
-- tenant-scoped access" (callers must opt-in to user-scoped paths).
-- =========================================================================

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$fn$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$fn$;

-- =========================================================================
-- Updated_at trigger function (shared).
-- =========================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$fn$;

-- =========================================================================
-- TENANTS
-- Not RLS-scoped (each row IS a tenant; lookups by slug must work pre-context).
-- =========================================================================

CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name                text NOT NULL,
  branding            jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan                text NOT NULL DEFAULT 'free',
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  timezone            text NOT NULL DEFAULT 'Asia/Kathmandu',
  service_charge_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (service_charge_pct >= 0 AND service_charge_pct <= 100),
  vat_pct             numeric(5,2) NOT NULL DEFAULT 13 CHECK (vat_pct >= 0 AND vat_pct <= 100),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- USERS
-- Global (not tenant-scoped). Auth flows look up by google_sub before any
-- tenant context exists.
-- =========================================================================

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext NOT NULL UNIQUE,
  name        text NOT NULL DEFAULT '',
  avatar_url  text,
  google_sub  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- TENANT_MEMBERS
-- M:N between users and tenants with roles[] + status. RLS-scoped: a row is
-- visible if (tenant context matches) OR (user context matches and no tenant
-- set). The user-scoped branch supports the post-login workspace-pick flow.
-- =========================================================================

CREATE TYPE tenant_role AS ENUM ('owner', 'manager', 'waiter', 'kitchen');
CREATE TYPE tenant_member_status AS ENUM ('active', 'pending', 'suspended');

-- One person can wear multiple hats on the same tenant (e.g. waiter+kitchen),
-- so membership is keyed by a non-empty `roles` array.
CREATE TABLE tenant_members (
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles               tenant_role[] NOT NULL,
  status              tenant_member_status NOT NULL DEFAULT 'active',
  invited_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT tenant_members_roles_nonempty CHECK (array_length(roles, 1) >= 1)
);

CREATE INDEX tenant_members_user_idx ON tenant_members(user_id);

ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_members_isolation ON tenant_members
  USING (
    (current_tenant_id() IS NOT NULL AND tenant_id = current_tenant_id())
    OR
    (current_tenant_id() IS NULL AND current_user_id() IS NOT NULL AND user_id = current_user_id())
  )
  WITH CHECK (
    tenant_id = current_tenant_id()
  );
-- =========================================================================
-- SESSIONS
-- Server-side session store. Not RLS-scoped: lookup by token_hash is the
-- auth check itself. tenant_id is NULL until the user picks a workspace.
-- =========================================================================

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  ip            text,
  ua            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_active_expires_idx ON sessions(expires_at) WHERE revoked_at IS NULL;

-- =========================================================================
-- AUDIT_EVENTS
-- Append-only log. RLS-scoped — can only be read within a tenant context.
-- =========================================================================

CREATE TABLE audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip              text,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_at_idx ON audit_events(tenant_id, at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_isolation ON audit_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- Grant CRUD privileges on app data to the `app` group role.
-- Future migrations should `GRANT ... TO app` for any new tables.
-- =========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, tenant_members, sessions, audit_events TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS audit_events CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS tenant_members CASCADE;
DROP TYPE  IF EXISTS tenant_member_status;
DROP TYPE  IF EXISTS tenant_role;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS current_user_id();
DROP FUNCTION IF EXISTS current_tenant_id();
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app;
REVOKE USAGE ON SCHEMA public FROM app;
DROP USER IF EXISTS app_user;
DROP ROLE IF EXISTS app;
-- +goose StatementEnd
