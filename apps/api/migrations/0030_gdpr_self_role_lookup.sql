-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- GDPR self-service role lookups — SECURITY DEFINER.
--
-- The /v1/me/export and DELETE /v1/me handlers run with NO tenant context
-- (they are intentionally cross-tenant: a user touches every workspace they
-- belong to). The tenant_member_roles RLS policy has a user-scoped branch
-- that lets a user read their OWN grants with no tenant set, but the `roles`
-- table is tenant-scoped ONLY — so a plain tenant_member_roles -> roles join
-- returns nothing without a current_tenant_id(). (Same root cause that broke
-- SelectTenant.) These two functions run as the owner (BYPASSRLS) to resolve
-- role keys across tenants.
--
-- SAFETY: neither takes a user-id parameter — both filter on current_user_id()
-- internally, so they can ONLY ever return the CALLING user's own data even if
-- invoked directly. That is what makes them safe to GRANT to app. They replace
-- the dropped tenant_members.role column the handlers still referenced (which
-- made both endpoints return 500 unconditionally).
-- =========================================================================

-- my_memberships() — every workspace the caller belongs to, with their role
-- keys (empty array when a membership somehow has no role grant).
CREATE OR REPLACE FUNCTION my_memberships()
RETURNS TABLE (
  tenant_id  uuid,
  slug       text,
  name       text,
  roles      text[],
  status     text,
  joined_at  timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT
    tm.tenant_id,
    t.slug,
    t.name,
    COALESCE(
      (SELECT array_agg(r.key ORDER BY r.key)
         FROM tenant_member_roles tmr
         JOIN roles r ON r.id = tmr.role_id
        WHERE tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id),
      ARRAY[]::text[]
    ),
    tm.status::text,
    tm.joined_at
  FROM tenant_members tm
  JOIN tenants t ON t.id = tm.tenant_id
  WHERE tm.user_id = current_user_id()
  ORDER BY tm.joined_at
$fn$;

REVOKE ALL ON FUNCTION my_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_memberships() TO app;

-- my_sole_owner_workspaces() — slugs of workspaces where the caller is an
-- active owner AND the only active owner. The account-deletion guard uses
-- this to refuse leaving a workspace ownerless.
CREATE OR REPLACE FUNCTION my_sole_owner_workspaces()
RETURNS TABLE (slug text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  WITH my_owner AS (
    SELECT tm.tenant_id
    FROM tenant_members tm
    JOIN tenant_member_roles tmr
      ON tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id
    JOIN roles r ON r.id = tmr.role_id AND r.is_system AND r.key = 'owner'
    WHERE tm.user_id = current_user_id() AND tm.status = 'active'
  ),
  counts AS (
    SELECT mo.tenant_id, count(*) AS active_owner_count
    FROM my_owner mo
    JOIN tenant_members tm
      ON tm.tenant_id = mo.tenant_id AND tm.status = 'active'
    JOIN tenant_member_roles tmr
      ON tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id
    JOIN roles r ON r.id = tmr.role_id AND r.is_system AND r.key = 'owner'
    GROUP BY mo.tenant_id
  )
  SELECT t.slug
  FROM counts c
  JOIN tenants t ON t.id = c.tenant_id
  WHERE c.active_owner_count <= 1
$fn$;

REVOKE ALL ON FUNCTION my_sole_owner_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_sole_owner_workspaces() TO app;

-- =========================================================================
-- Fix the owner-present invariant trigger so it evaluates GROUND TRUTH.
--
-- rbac_assert_owner_present() (migration 0019) was SECURITY INVOKER, so its
-- owner-count query ran under the committing session's RLS. That is fine when
-- the mutation happens WITH a tenant context, but account deletion (DELETE
-- /v1/me) drops a member's row with NO tenant context — the cascade fires this
-- deferred trigger at commit, and under no-tenant RLS the tenant-scoped `roles`
-- table is invisible, so the count comes back 0 even when other active owners
-- exist. The trigger then wrongly aborts the commit, silently rolling back the
-- membership delete while the out-of-band users/sessions writes already
-- committed — a partial, inconsistent deletion.
--
-- The owner-present invariant is a GLOBAL fact about a tenant, not a per-RLS
-- view, so the check must not be subject to RLS at all. SECURITY DEFINER (owned
-- by the BYPASSRLS migration role) makes it count the real rows. Body is
-- otherwise byte-for-byte identical to 0019. Reads + RAISE only.
-- =========================================================================

CREATE OR REPLACE FUNCTION rbac_assert_owner_present() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
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

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS my_sole_owner_workspaces();
DROP FUNCTION IF EXISTS my_memberships();

-- Restore the original SECURITY INVOKER owner-present trigger from 0019.
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
-- +goose StatementEnd
