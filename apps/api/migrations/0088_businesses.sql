-- +goose Up

-- =========================================================================
-- Multi-branch: a BUSINESS groups several tenants, each of which is a branch.
--
-- A branch is an ordinary tenant — same tables, same RLS, same money code —
-- so nothing tenant-scoped changes here. A business only adds:
--   * a name for the group,
--   * tenants.business_id (NULL = a standalone café, which is every tenant
--     until a platform admin creates a business),
--   * my_business_branches(): the sibling branches the CALLER may enter, used
--     by the branch switcher and the consolidated reports,
--   * a catalog-only clone to seed a new branch from an existing one.
--
-- "Outlets" (0045) are prep STATIONS inside one café (Kitchen, Bar). They are
-- unrelated to branches; the UI calls these Branches and those Stations.
-- =========================================================================

CREATE TABLE businesses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER businesses_set_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No RLS, like tenants and plans: the table holds no café data, tenant-facing
-- code reads it only through my_business_branches(), and the /super console
-- (which runs as app too) needs plain access.
GRANT SELECT, INSERT, UPDATE, DELETE ON businesses TO app;

ALTER TABLE tenants
  ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;

CREATE INDEX tenants_business_id_idx ON tenants (business_id) WHERE business_id IS NOT NULL;

-- -------------------------------------------------------------------------
-- my_business_branches() — every branch of the ACTIVE tenant's business that
-- the caller is an active member of, including the active tenant itself.
--
-- SAFETY: takes no parameters. The anchor is current_tenant_id() and the
-- caller is current_user_id(), both set by the request tx, so it can never be
-- used to probe a business the caller does not belong to. It returns nothing
-- unless the caller is an active member of the anchor, and nothing for a
-- standalone café (business_id IS NULL).
-- -------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION my_business_branches()
RETURNS TABLE (
  tenant_id     uuid,
  slug          text,
  name          text,
  timezone      text,
  business_id   uuid,
  business_name text,
  roles         text[],
  is_anchor     boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH anchor AS (
    SELECT t.business_id
    FROM tenants t
    JOIN tenant_members tm
      ON tm.tenant_id = t.id AND tm.user_id = current_user_id() AND tm.status = 'active'
    WHERE t.id = current_tenant_id() AND t.business_id IS NOT NULL
  )
  SELECT
    t.id,
    t.slug,
    t.name,
    COALESCE(t.timezone, 'Asia/Kathmandu'),
    b.id,
    b.name,
    COALESCE(
      (SELECT array_agg(r.key ORDER BY r.key)
         FROM tenant_member_roles tmr
         JOIN roles r ON r.id = tmr.role_id
        WHERE tmr.tenant_id = t.id AND tmr.user_id = tm.user_id),
      ARRAY[]::text[]
    ),
    t.id = current_tenant_id()
  FROM anchor a
  JOIN businesses b ON b.id = a.business_id
  JOIN tenants t ON t.business_id = a.business_id
               AND t.deleted_at IS NULL
               AND t.status = 'active'
  JOIN tenant_members tm
    ON tm.tenant_id = t.id AND tm.user_id = current_user_id() AND tm.status = 'active'
  ORDER BY t.name, t.slug
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION my_business_branches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_business_branches() TO app;

-- -------------------------------------------------------------------------
-- business_owner_ids(business) — active owners across a business's branches.
-- "Add branch" makes each of them an owner of the new branch. Platform admins
-- only: the /super console cannot read another tenant's members under RLS.
-- -------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION business_owner_ids(p_business uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT is_platform_admin(current_user_id()) THEN
    RAISE EXCEPTION 'business_owner_ids: platform admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT DISTINCT tm.user_id
    FROM tenants t
    JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.status = 'active'
    JOIN tenant_member_roles tmr ON tmr.tenant_id = tm.tenant_id AND tmr.user_id = tm.user_id
    JOIN roles r ON r.id = tmr.role_id AND r.is_system AND r.key = 'owner'
    WHERE t.business_id = p_business AND t.deleted_at IS NULL;
END;
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION business_owner_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_owner_ids(uuid) TO app;

-- -------------------------------------------------------------------------
-- clone_catalog_tables() / clone_tenant_catalog(src, dst)
--
-- Seeds a NEW branch with an existing branch's setup: stations, menu, add-ons,
-- inventory items (at zero stock), tables, expense categories, custom roles,
-- and the café's settings (tax, service charge, branding, preferences minus
-- printer addresses).
--
-- clone_tenant_data (0063/0065) is NOT usable for this: it is a full QA fork
-- that copies orders, payments, staff and members. This is the same id-remap
-- engine over a catalog-only list.
--
-- The list must be closed under foreign keys: a listed table whose FK points
-- at a tenant-scoped table that is NOT listed would be copied verbatim and
-- point into the SOURCE tenant. The pre-flight below refuses that, so adding a
-- tenant-scoped FK to a catalog table later fails loudly here instead of
-- leaking a cross-tenant pointer.
-- -------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION clone_catalog_tables()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'outlets',
    'menu_categories',
    'menu_items',
    'menu_modifier_groups',
    'menu_modifiers',
    'menu_item_modifier_groups',
    'menu_category_modifier_groups',
    'inventory_items',
    'pack_rules',
    'menu_item_inventory_link',
    'modifier_inventory_link',
    'service_tables',
    'expense_categories',
    'roles',
    'role_permissions'
  ]
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION clone_catalog_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clone_catalog_tables() TO app;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION clone_tenant_catalog(p_src uuid, p_dst uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  tbls      text[] := clone_catalog_tables();
  t         text;
  col       record;
  sel_parts text[];
  col_parts text[];
  counts    jsonb := '{}'::jsonb;
  n         bigint;
  scope     text;
  leak      text;
BEGIN
  IF NOT is_platform_admin(current_user_id()) THEN
    RAISE EXCEPTION 'clone_tenant_catalog: platform admin only' USING ERRCODE = '42501';
  END IF;
  IF p_src = p_dst THEN
    RAISE EXCEPTION 'clone_tenant_catalog: source and destination are the same tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE tenant_id = p_dst)
     OR EXISTS (SELECT 1 FROM menu_items WHERE tenant_id = p_dst) THEN
    RAISE EXCEPTION 'clone_tenant_catalog: destination tenant already has menu or order data';
  END IF;

  -- Pre-flight: every FK out of a listed table must land on tenants, a listed
  -- table, or a table with no tenant_id (global, e.g. users).
  SELECT src.relname || '.' || a.attname || ' -> ' || tgt.relname INTO leak
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_class tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE ns.nspname = 'public' AND con.contype = 'f'
    AND src.relname = ANY(tbls)
    AND tgt.relname <> 'tenants'
    AND NOT (tgt.relname = ANY(tbls))
    AND clone_has_column(tgt.relname, 'tenant_id')
  LIMIT 1;
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'clone_tenant_catalog: % is not in clone_catalog_tables()', leak;
  END IF;

  -- The fresh branch's seeded default station would collide with the copied
  -- one (one is_default per tenant). Members, invites and system roles stay.
  DELETE FROM outlets WHERE tenant_id = p_dst;

  FOREACH t IN ARRAY tbls LOOP
    IF clone_has_column(t, 'id') THEN
      EXECUTE format('CREATE TEMP TABLE %I (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP',
                     '_clonemap_' || t);
      EXECUTE format('INSERT INTO %I (old, new) SELECT id, gen_random_uuid() FROM %I s WHERE %s',
                     '_clonemap_' || t, t, clone_scope_sql(t, tbls)) USING p_src;
    END IF;
  END LOOP;

  -- System roles map onto the destination's own seeded role of the same key.
  UPDATE _clonemap_roles m
     SET new = d.id
    FROM roles srcr, roles d
   WHERE srcr.id = m.old
     AND srcr.tenant_id = p_src AND srcr.is_system
     AND d.tenant_id = p_dst AND d.key = srcr.key;

  FOREACH t IN ARRAY tbls LOOP
    col_parts := ARRAY[]::text[];
    sel_parts := ARRAY[]::text[];

    FOR col IN
      SELECT a.attname AS name,
             (SELECT tgt.relname
                FROM pg_constraint con
                JOIN pg_class tgt ON tgt.oid = con.confrelid
               WHERE con.conrelid = c.oid AND con.contype = 'f'
                 AND array_length(con.conkey, 1) = 1 AND con.conkey[1] = a.attnum
               LIMIT 1) AS fk_target
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = t
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
      ORDER BY a.attnum
    LOOP
      col_parts := col_parts || quote_ident(col.name);
      IF col.name = 'tenant_id' THEN
        sel_parts := sel_parts || '$2'::text;
      ELSIF col.name = 'id' THEN
        sel_parts := sel_parts || format('(SELECT new FROM %I WHERE old = s.id)', '_clonemap_' || t);
      ELSIF col.fk_target IS NOT NULL AND col.fk_target = ANY(tbls) THEN
        sel_parts := sel_parts ||
          format('(SELECT new FROM %I WHERE old = s.%I)', '_clonemap_' || col.fk_target, col.name);
      ELSE
        sel_parts := sel_parts || format('s.%I', col.name);
      END IF;
    END LOOP;

    IF t = 'roles' THEN
      scope := clone_scope_sql(t, tbls) || ' AND NOT s.is_system';
    ELSIF t = 'role_permissions' THEN
      scope := clone_scope_sql(t, tbls)
        || ' AND EXISTS (SELECT 1 FROM roles r WHERE r.id = s.role_id AND NOT r.is_system)';
    ELSE
      scope := clone_scope_sql(t, tbls);
    END IF;

    EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I s WHERE %s',
                   t,
                   array_to_string(col_parts, ', '),
                   array_to_string(sel_parts, ', '),
                   t,
                   scope)
      USING p_src, p_dst;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(t, n);
  END LOOP;

  -- Copied catalog rows carry the source branch's LIVE state. A new branch
  -- starts with nothing on the shelf, every table free, and its own printers.
  UPDATE inventory_items
     SET qty_on_hand_units = 0, last_purchase_unit_cost_cents = NULL
   WHERE tenant_id = p_dst;
  UPDATE service_tables SET status = 'free' WHERE tenant_id = p_dst;
  UPDATE outlets SET printer_ip = NULL WHERE tenant_id = p_dst;

  -- Settings. Printer addresses are per building, so they are not copied.
  UPDATE tenants d
     SET branding           = s.branding,
         preferences        = COALESCE(s.preferences, '{}'::jsonb) - 'kitchenPrinters' - 'receiptPrinters',
         vat_pct            = s.vat_pct,
         vat_mode           = s.vat_mode,
         service_charge_pct = s.service_charge_pct
    FROM tenants s
   WHERE s.id = p_src AND d.id = p_dst;

  RETURN counts;
END;
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION clone_tenant_catalog(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clone_tenant_catalog(uuid, uuid) TO app;

-- multi_branch: granted to every plan for now, like the 0047 catalog. Tiering
-- (per-branch pricing) is a later data change, not a code change.
INSERT INTO plan_features (plan_id, feature_key)
  SELECT p.id, 'multi_branch' FROM plans p
  ON CONFLICT DO NOTHING;

-- +goose Down
DELETE FROM plan_features WHERE feature_key = 'multi_branch';
DROP FUNCTION IF EXISTS clone_tenant_catalog(uuid, uuid);
DROP FUNCTION IF EXISTS clone_catalog_tables();
DROP FUNCTION IF EXISTS business_owner_ids(uuid);
DROP FUNCTION IF EXISTS my_business_branches();
DROP INDEX IF EXISTS tenants_business_id_idx;
ALTER TABLE tenants DROP COLUMN IF EXISTS business_id;
DROP TABLE IF EXISTS businesses;
