-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- PLATFORM_ADMINS — site-wide super admins who operate ACROSS tenants.
--
-- Global, NOT RLS-scoped (there is no tenant context for these users). A
-- user is a super admin iff they appear here. Rows are seeded at login from
-- the PLATFORM_ADMIN_EMAILS env allowlist (source='env_allowlist') and may
-- also be added in-console (source='manual').
-- =========================================================================

CREATE TABLE platform_admins (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','env_allowlist')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON platform_admins TO app;

-- =========================================================================
-- PLATFORM_AUDIT — append-only log of super-admin actions. NOT tenant-scoped
-- (target_tenant_id is nullable: plan CRUD, request review, admin changes
-- have no tenant until provisioned). Distinct from audit_log (FORCE RLS,
-- tenant NOT NULL).
-- =========================================================================

CREATE TABLE platform_audit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email      text NOT NULL,
  action           text NOT NULL,          -- plan.create|tenant.change_plan|request.approve|admin.add|...
  target_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  target_id        text NOT NULL DEFAULT '', -- free-form (plan key, request id, email)
  summary          text NOT NULL DEFAULT '',
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip               inet,
  request_id       text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_time_idx   ON platform_audit(created_at DESC);
CREATE INDEX platform_audit_tenant_idx ON platform_audit(target_tenant_id, created_at DESC);

GRANT SELECT, INSERT ON platform_audit TO app;

-- =========================================================================
-- is_platform_admin(uuid) — STABLE helper. platform_admins is global (no
-- RLS) so app_user can read it directly; this wraps it for a single clean
-- call site from /v1/me and RequirePlatformAdmin.
-- =========================================================================

CREATE OR REPLACE FUNCTION is_platform_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = p_user)
$fn$;

-- =========================================================================
-- platform_tenant_summaries() — SECURITY DEFINER. The super-admin tenant
-- list needs cross-tenant aggregates (active member count, pending invite
-- count, owner contact) that app_user CANNOT read directly: tenant_members,
-- tenant_invites, tenant_member_roles and roles are all FORCE RLS scoped to
-- current_tenant_id(). Running as the function owner (BYPASSRLS) lets this
-- one bounded read cross tenants. Callers MUST be gated by
-- RequirePlatformAdmin in Go before invoking this.
-- =========================================================================

CREATE OR REPLACE FUNCTION platform_tenant_summaries()
RETURNS TABLE (
  tenant_id        uuid,
  slug             text,
  name             text,
  status           text,
  billing_state    text,
  plan_key         text,
  plan_name        text,
  member_limit     int,            -- effective (override ?? plan)
  trial_ends_at    timestamptz,
  active_members   int,
  pending_invites  int,
  owner_email      text,
  created_at       timestamptz,
  last_activity    timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT
    t.id, t.slug, t.name, t.status, t.billing_state,
    p.key, p.name,
    COALESCE(t.member_limit_override, p.member_limit),
    t.trial_ends_at,
    (SELECT count(*)::int FROM tenant_members tm
      WHERE tm.tenant_id = t.id AND tm.status = 'active'),
    (SELECT count(*)::int FROM tenant_invites ti
      WHERE ti.tenant_id = t.id AND ti.accepted_at IS NULL AND ti.revoked_at IS NULL),
    (SELECT u.email::text FROM tenant_members tm
       JOIN tenant_member_roles tmr ON tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id
       JOIN roles r ON r.id = tmr.role_id AND r.is_system AND r.key = 'owner'
       JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = t.id AND tm.status = 'active'
      ORDER BY tm.joined_at LIMIT 1),
    t.created_at,
    (SELECT max(al.created_at) FROM audit_log al WHERE al.tenant_id = t.id)
  FROM tenants t
  LEFT JOIN plans p ON p.id = t.plan_id
  WHERE t.deleted_at IS NULL
  ORDER BY t.created_at DESC
$fn$;

REVOKE ALL ON FUNCTION platform_tenant_summaries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_summaries() TO app;

-- =========================================================================
-- tenant_seat_usage(uuid) — SECURITY DEFINER. Used by the login-time invite
-- acceptance path (AcceptPendingInvites), which runs with NO stable tenant
-- context, to count seats for a specific tenant without tripping RLS.
-- =========================================================================

CREATE OR REPLACE FUNCTION tenant_seat_usage(p_tenant uuid)
RETURNS TABLE (active_members int, pending_invites int)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT
    (SELECT count(*)::int FROM tenant_members
      WHERE tenant_id = p_tenant AND status = 'active'),
    (SELECT count(*)::int FROM tenant_invites
      WHERE tenant_id = p_tenant AND accepted_at IS NULL AND revoked_at IS NULL)
$fn$;

REVOKE ALL ON FUNCTION tenant_seat_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_seat_usage(uuid) TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS tenant_seat_usage(uuid);
DROP FUNCTION IF EXISTS platform_tenant_summaries();
DROP FUNCTION IF EXISTS is_platform_admin(uuid);
DROP TABLE IF EXISTS platform_audit CASCADE;
DROP TABLE IF EXISTS platform_admins CASCADE;
-- +goose StatementEnd
