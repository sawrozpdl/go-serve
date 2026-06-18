-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- MANUAL SUBSCRIPTIONS — configurable trial length + paid-through tracking +
-- a manual payments ledger. No payment integration: a platform admin records
-- payments by hand and the paid-through date advances.
--
-- Two distinct access dates on tenants, with DIFFERENT enforcement:
--   trial_ends_at  (existing) → the TRIAL gate. Auto-locks writes past grace
--                               (the trial's job is to force a decision).
--   paid_through_at (new)     → the PAID subscription's good-through date.
--                               Flag-only: a lapsed paid sub shows as
--                               "past due" in the super console but NEVER
--                               auto-locks. The admin locks manually if they
--                               choose. NULL = comped / perpetual (our own +
--                               enterprise tenants), never flagged.
-- At most one of the two is set at a time: trial plans carry trial_ends_at;
-- moving to a paid plan clears it and the admin records payments instead.
-- =========================================================================

-- Per-plan trial window. 0 = no trial (the plan starts gated only by payment).
-- The hardcoded 90-day constant in Go is replaced by reading this column.
ALTER TABLE plans
  ADD COLUMN trial_days int NOT NULL DEFAULT 0 CHECK (trial_days >= 0 AND trial_days <= 3650);

-- The trial plan keeps its 90-day window; everything else has no trial.
UPDATE plans SET trial_days = 90 WHERE key = 'trial';

-- Paid-subscription good-through date. NULL = not on a paid sub / comped.
ALTER TABLE tenants
  ADD COLUMN paid_through_at timestamptz;

-- =========================================================================
-- TENANT_PAYMENTS — append-only ledger of manually-recorded payments.
-- Global, NOT RLS-scoped (like plans / platform_audit): platform billing data
-- read & written only via the super console (RequirePlatformAdmin in Go).
-- Recording a payment also advances tenants.paid_through_at.
-- =========================================================================

CREATE TABLE tenant_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  currency      text NOT NULL DEFAULT 'NPR' CHECK (length(currency) BETWEEN 1 AND 8),
  method        text NOT NULL CHECK (method IN ('cash','bank','online','other')),
  period_start  date,                 -- informational; what the payment covers
  period_end    date NOT NULL,        -- paid through this date (drives paid_through_at)
  note          text NOT NULL DEFAULT '',
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_payments_tenant_idx ON tenant_payments(tenant_id, created_at DESC);

GRANT SELECT, INSERT ON tenant_payments TO app;

-- =========================================================================
-- platform_tenant_summaries() — extend with the two subscription fields the
-- console needs to render status without N+1 queries. New columns are
-- APPENDED so the Go scan order only grows at the tail. Adding to RETURNS TABLE
-- changes the return type, so DROP first (CREATE OR REPLACE cannot do that).
-- =========================================================================

DROP FUNCTION IF EXISTS platform_tenant_summaries();
CREATE FUNCTION platform_tenant_summaries()
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
  last_activity    timestamptz,
  paid_through_at  timestamptz,
  last_payment_at  timestamptz
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
    (SELECT max(al.created_at) FROM audit_log al WHERE al.tenant_id = t.id),
    t.paid_through_at,
    (SELECT max(tp.created_at) FROM tenant_payments tp WHERE tp.tenant_id = t.id)
  FROM tenants t
  LEFT JOIN plans p ON p.id = t.plan_id
  WHERE t.deleted_at IS NULL
  ORDER BY t.created_at DESC
$fn$;

REVOKE ALL ON FUNCTION platform_tenant_summaries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_summaries() TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Restore the pre-0039 summary function (without the subscription columns).
DROP FUNCTION IF EXISTS platform_tenant_summaries();
CREATE FUNCTION platform_tenant_summaries()
RETURNS TABLE (
  tenant_id        uuid,
  slug             text,
  name             text,
  status           text,
  billing_state    text,
  plan_key         text,
  plan_name        text,
  member_limit     int,
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

DROP TABLE IF EXISTS tenant_payments CASCADE;
ALTER TABLE tenants DROP COLUMN IF EXISTS paid_through_at;
ALTER TABLE plans   DROP COLUMN IF EXISTS trial_days;

-- +goose StatementEnd
