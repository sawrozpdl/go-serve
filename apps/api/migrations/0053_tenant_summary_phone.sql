-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0053: surface tenants.contact_phone (added in 0046) in the super console
-- tenant list. New column is APPENDED to the RETURNS TABLE so the Go scan
-- order only grows at the tail. Adding to RETURNS TABLE changes the return
-- type, so DROP first (CREATE OR REPLACE cannot change the signature).
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
  last_payment_at  timestamptz,
  contact_phone    text            -- appended in 0053
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
    (SELECT max(tp.created_at) FROM tenant_payments tp WHERE tp.tenant_id = t.id),
    t.contact_phone
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
