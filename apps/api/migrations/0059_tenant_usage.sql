-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0059 — Is this cafe actually using the app?
--
-- The console's only answer to that was platform_tenant_summaries().
-- last_activity, which reads max(audit_log.created_at). But audit.Log
-- short-circuits when the tenant lacks the audit_logs feature, and 0051 made
-- that feature default-off for every plan. So the column is NULL for
-- essentially every tenant provisioned since, and a blank there means "not
-- recording", NOT "not using the app". The signal was dead on arrival.
--
-- The real signals were there the whole time — orders and shifts — just never
-- rolled up across tenants. Both are FORCE-RLS, so /super (which sets only
-- app.user_id) sees nothing; hence a SECURITY DEFINER function, self-gated on
-- is_platform_admin exactly like platform_accuracy_check() in 0056.
--
-- Two pieces:
--
--   platform_tenant_usage()  — live rollup, one row per tenant. Cheap: it
--     rides orders_tenant_closed_at_idx (0055) and shifts_tenant_opened_idx.
--     Windows are half-open [from, to) to match closedOrdersInWindow in
--     money.go, so per-day figures sum to the range figure.
--
--   tenant_health_daily      — nightly snapshot. Needed for two things the
--     live rollup can't give: a trend line, and a DIFF so the daily digest can
--     say "these three cafes went quiet since yesterday" rather than re-listing
--     everyone who is currently quiet.
--
-- Also: tenant_members.last_seen_at. sessions.last_seen_at has existed since
-- 0001 and nothing in Go has ever written it, and it's user-global rather than
-- per-tenant anyway. Without a per-member heartbeat there is no way to tell
-- "only the owner ever logs in" from "the whole team is in here daily".
-- =========================================================================

ALTER TABLE tenant_members ADD COLUMN last_seen_at timestamptz;
-- Supports the "who was active in this tenant lately" count. Partial: a member
-- who has never been seen is not interesting to this query.
CREATE INDEX tenant_members_last_seen_idx
  ON tenant_members (tenant_id, last_seen_at DESC) WHERE last_seen_at IS NOT NULL;

CREATE FUNCTION platform_tenant_usage(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  tenant_id             uuid,
  last_order_closed_at  timestamptz,
  orders_7d             int,
  orders_prev_28d       int,     -- the four preceding 7d buckets, for a baseline
  gross_7d_cents        bigint,
  last_shift_closed_at  timestamptz,
  open_shift_since      timestamptz,
  operating_days_7d     int,     -- distinct local days with >=1 closed order
  shift_closed_days_7d  int,     -- distinct local days with >=1 closed shift
  active_members_7d     int,
  menu_item_count       int,
  adoption              jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH allowed AS (
    -- Self-gate: a non-admin caller gets an empty set rather than an error,
    -- matching platform_accuracy_check(). Belt and braces on top of
    -- RequirePlatformAdmin, since a DEFINER function bypasses RLS.
    SELECT 1 WHERE is_platform_admin(current_user_id())
  ),
  scope AS (
    SELECT t.id, t.timezone
    FROM tenants t, allowed
    WHERE t.deleted_at IS NULL AND (p_tenant IS NULL OR t.id = p_tenant)
  )
  SELECT
    s.id,
    (SELECT max(o.closed_at) FROM orders o
      WHERE o.tenant_id = s.id AND o.status = 'closed'),
    (SELECT count(*)::int FROM orders o
      WHERE o.tenant_id = s.id AND o.status = 'closed'
        AND o.closed_at >= now() - interval '7 days' AND o.closed_at < now()),
    (SELECT count(*)::int FROM orders o
      WHERE o.tenant_id = s.id AND o.status = 'closed'
        AND o.closed_at >= now() - interval '35 days' AND o.closed_at < now() - interval '7 days'),
    -- Net revenue basis (total - tax), matching netRevenueExpr in money.go, so
    -- this figure means the same thing as every other revenue number we show.
    (SELECT COALESCE(SUM(o.total_cents - o.tax_cents), 0)::bigint FROM orders o
      WHERE o.tenant_id = s.id AND o.status = 'closed'
        AND o.closed_at >= now() - interval '7 days' AND o.closed_at < now()),
    (SELECT max(sh.closed_at) FROM shifts sh WHERE sh.tenant_id = s.id),
    (SELECT sh.opened_at FROM shifts sh
      WHERE sh.tenant_id = s.id AND sh.closed_at IS NULL LIMIT 1),
    -- Days are counted in the CAFE's timezone, not UTC. A cafe closing at
    -- 01:00 NPT would otherwise have its late trade attributed to the next
    -- day and look like it operated on a day it was shut.
    (SELECT count(DISTINCT (o.closed_at AT TIME ZONE s.timezone)::date)::int FROM orders o
      WHERE o.tenant_id = s.id AND o.status = 'closed'
        AND o.closed_at >= now() - interval '7 days' AND o.closed_at < now()),
    (SELECT count(DISTINCT (sh.closed_at AT TIME ZONE s.timezone)::date)::int FROM shifts sh
      WHERE sh.tenant_id = s.id AND sh.closed_at IS NOT NULL
        AND sh.closed_at >= now() - interval '7 days' AND sh.closed_at < now()),
    (SELECT count(*)::int FROM tenant_members tm
      WHERE tm.tenant_id = s.id AND tm.status = 'active'
        AND tm.last_seen_at >= now() - interval '7 days'),
    (SELECT count(*)::int FROM menu_items mi WHERE mi.tenant_id = s.id AND mi.deleted_at IS NULL),
    jsonb_build_object(
      'inventory', EXISTS(SELECT 1 FROM inventory_items i WHERE i.tenant_id = s.id AND i.deleted_at IS NULL),
      'expenses',  EXISTS(SELECT 1 FROM expenses e      WHERE e.tenant_id = s.id AND e.deleted_at IS NULL),
      'credit',    EXISTS(SELECT 1 FROM house_tabs h    WHERE h.tenant_id = s.id),
      'staff',     (SELECT count(*)::int FROM staff st  WHERE st.tenant_id = s.id AND st.deleted_at IS NULL),
      'outlets',   (SELECT count(*)::int FROM outlets ou WHERE ou.tenant_id = s.id)
    )
  FROM scope s
$fn$;

REVOKE ALL ON FUNCTION platform_tenant_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_usage(uuid) TO app;

-- The evidence behind a red shift_discipline grade. Same DEFINER + self-gate
-- treatment, because shifts is FORCE-RLS and /super has no tenant context: a
-- status the console can't justify is a status nobody trusts.
CREATE FUNCTION platform_tenant_shift_log(p_tenant uuid, p_days int DEFAULT 14)
RETURNS TABLE (
  id             uuid,
  opened_at      timestamptz,
  closed_at      timestamptz,
  closed_by_name text,
  variance_cents bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT sh.id, sh.opened_at, sh.closed_at,
         COALESCE(NULLIF(btrim(u.name), ''), u.email::text),
         sh.variance_cents
  FROM shifts sh
  LEFT JOIN users u ON u.id = sh.closed_by_user_id
  WHERE is_platform_admin(current_user_id())
    AND sh.tenant_id = p_tenant
    AND sh.opened_at >= now() - make_interval(days => p_days)
  ORDER BY sh.opened_at DESC
$fn$;

REVOKE ALL ON FUNCTION platform_tenant_shift_log(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_shift_log(uuid, int) TO app;

-- Nightly snapshot. Platform-owned (no RLS) like the rest of the console's
-- tables; CASCADE so a deleted tenant takes its history with it.
CREATE TABLE tenant_health_daily (
  tenant_id       uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day             date   NOT NULL,
  orders          int    NOT NULL DEFAULT 0,
  gross_cents     bigint NOT NULL DEFAULT 0,
  shifts_opened   int    NOT NULL DEFAULT 0,
  shifts_closed   int    NOT NULL DEFAULT 0,
  active_members  int    NOT NULL DEFAULT 0,
  -- The graded status AS OF that day, plus the signal detail behind it, so the
  -- digest can diff yesterday against today without recomputing history.
  status          text   NOT NULL,
  signals         jsonb  NOT NULL DEFAULT '{}',
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
CREATE INDEX tenant_health_daily_day_idx ON tenant_health_daily (day DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_health_daily TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE IF EXISTS tenant_health_daily;
DROP FUNCTION IF EXISTS platform_tenant_shift_log(uuid, int);
DROP FUNCTION IF EXISTS platform_tenant_usage(uuid);
DROP INDEX IF EXISTS tenant_members_last_seen_idx;
ALTER TABLE tenant_members DROP COLUMN IF EXISTS last_seen_at;

-- +goose StatementEnd
