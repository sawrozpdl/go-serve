-- +goose Up

-- =========================================================================
-- 0063 — TENANT CLONE (a QA sandbox copied from a real café)
--
-- WHY
--
-- Reproducing a production bug meant hand-building a tenant that looked a bit
-- like the café reporting it. This copies the real one instead: same menu, same
-- history, same balances, in a throwaway workspace.
--
-- The industry shape for a single-database multi-tenant app is a logical copy
-- with id remapping inside the same database — a "tenant fork" / sandbox, the
-- same idea as a Salesforce sandbox or a Stripe test-mode account. (Restoring a
-- PITR snapshot into a separate environment is the answer for whole-database
-- disasters, not for one café's bug.)
--
-- HOW: CATALOG-DRIVEN, NOT HAND-WRITTEN
--
-- The obvious implementation is ~30 hand-written INSERT … SELECT statements with
-- explicit column lists. That would be wrong here: this schema gains columns
-- constantly (0002 → 0062), and a hand-written list silently stops copying
-- anything added later. A clone that quietly drops a new column is worse than no
-- clone, because the QA tenant then differs from prod in a way nobody sees.
--
-- So the column lists and the FK remapping are derived from the catalogue
-- (pg_attribute / pg_constraint) at run time:
--
--   * tenant_id            -> the destination tenant
--   * the table's own id   -> its pre-generated new id
--   * an FK to a table we are also cloning -> that table's new id
--   * an FK to a SHARED table (users, plans, …) -> copied through untouched
--   * anything else        -> copied verbatim
--
-- Every id map is populated BEFORE any row is copied, which is what lets
-- self-references (owner_ledger.parent_loan_id, .corrects_id) and any
-- forward-reference resolve in a single pass.
--
-- The one thing the catalogue cannot tell us is a POLYMORPHIC reference —
-- stock_movements.ref_id, whose target depends on ref_type and which carries no
-- FK. It is remapped explicitly at the end.
--
-- WHAT IS DELIBERATELY NOT COPIED
--
--   sessions, ws_tickets      cloning live auth would hand out working sessions
--   tenant_invites            someone could accept an invite into the clone
--   audit_log, audit_events   noise, and entity_id is polymorphic
--   bug_reports (+attachments) reports belong to the café that filed them
--   tenant_payments/notes/health  platform bookkeeping, not café data
--
-- `users` are SHARED and never cloned; tenant_members / tenant_member_roles are
-- copied so the same people keep access and the clone behaves like the original.
-- =========================================================================

-- +goose StatementBegin

-- Marks a clone as a clone, so it can never be mistaken for a real café — the
-- super console excludes them from its counts, and the app can badge them.
ALTER TABLE tenants
  ADD COLUMN cloned_from_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  ADD COLUMN cloned_at timestamptz;

CREATE INDEX tenants_cloned_from_idx ON tenants(cloned_from_tenant_id)
  WHERE cloned_from_tenant_id IS NOT NULL;

-- +goose StatementEnd

-- +goose StatementBegin
-- Does this table have this column? Used to tell an id-keyed table from a
-- composite-key link table, and a tenant-scoped table from one scoped only
-- through its parent.
CREATE OR REPLACE FUNCTION clone_has_column(p_table text, p_column text)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relname = p_table
      AND a.attname = p_column AND a.attnum > 0 AND NOT a.attisdropped
  )
$fn$;
-- +goose StatementEnd

-- +goose StatementBegin
-- The WHERE clause that selects one tenant's rows from p_table, as `s`.
--
-- Most tables carry tenant_id. A few (role_permissions) are tenant-scoped only
-- through a parent — for those, scope through the parent's FK instead of
-- assuming a column that isn't there.
CREATE OR REPLACE FUNCTION clone_scope_sql(p_table text, p_tables text[])
RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public AS $fn$
DECLARE
  parent_col text;
  parent_tbl text;
BEGIN
  IF clone_has_column(p_table, 'tenant_id') THEN
    RETURN 's.tenant_id = $1';
  END IF;

  -- First single-column FK pointing at a table we are also cloning.
  SELECT a.attname, tgt.relname INTO parent_col, parent_tbl
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_class tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE ns.nspname = 'public' AND src.relname = p_table AND con.contype = 'f'
    AND array_length(con.conkey, 1) = 1
    AND tgt.relname = ANY(p_tables)
  ORDER BY a.attnum
  LIMIT 1;

  IF parent_col IS NULL THEN
    RAISE EXCEPTION 'clone: % has no tenant_id and no FK to a cloned table — cannot scope it', p_table;
  END IF;

  RETURN format('s.%I IN (SELECT old FROM %I)', parent_col, '_clonemap_' || parent_tbl);
END;
$fn$;
-- +goose StatementEnd

-- clone_tenant_data — copies every café-owned row from one tenant to another.
--
-- Returns a jsonb of {table: rows copied} so the caller can show what happened.
-- The destination is expected to be a freshly provisioned tenant; its seeded
-- roles and default outlet are cleared first, because both carry per-tenant
-- unique indexes that the incoming rows would collide with.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION clone_tenant_data(p_src uuid, p_dst uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  -- Parents before children. Order matters for the INSERTs (a real FK has to
  -- find its parent row); it does NOT matter for the id maps, which are all
  -- built up front.
  tbls text[] := ARRAY[
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
    'house_tabs',
    'cafe_owners',
    'expense_categories',
    'staff',
    'staff_documents',
    'roles',
    'role_permissions',
    'tenant_members',
    'tenant_member_roles',
    'shifts',
    'orders',
    'order_items',
    'order_item_modifiers',
    'order_adjustments',
    'expenses',
    'expense_allocations',
    'payments',
    'house_tab_settlements',
    'stock_movements',
    'cash_drops',
    'account_transfers',
    'owner_ledger',
    'owner_cash_entries',
    'staff_pay'
  ];
  t          text;
  col        record;
  sel_parts  text[];
  col_parts  text[];
  counts     jsonb := '{}'::jsonb;
  n          bigint;
  has_id     boolean;
  has_tenant boolean;
  scope      text;   -- the WHERE that selects the source tenant's rows
  parent     text;   -- for tenant_id-less tables, the parent we scope through
BEGIN
  IF p_src = p_dst THEN
    RAISE EXCEPTION 'clone_tenant_data: source and destination are the same tenant';
  END IF;

  -- The destination must be empty of café data, or ids collide and the result is
  -- a mix of two cafés. Checked on the busiest table rather than all of them.
  IF EXISTS (SELECT 1 FROM orders WHERE tenant_id = p_dst)
     OR EXISTS (SELECT 1 FROM menu_items WHERE tenant_id = p_dst) THEN
    RAISE EXCEPTION 'clone_tenant_data: destination tenant already has menu or order data';
  END IF;

  -- Clear what provisioning seeded and we are about to replace. The default
  -- outlet has a one-per-tenant unique index the incoming rows would collide
  -- with; the invite-time membership would collide with the source's.
  --
  -- SYSTEM roles are deliberately NOT cleared. They are defined by the
  -- application (owner/manager/waiter/kitchen), not by the café, so provisioning
  -- has already created the right ones — and the owner role's permissions are
  -- guarded by a trigger that refuses any change except inserting '*:*', so
  -- deleting them would abort the whole clone. They are matched by KEY below
  -- instead; only CUSTOM roles are copied.
  DELETE FROM tenant_member_roles WHERE tenant_id = p_dst;
  DELETE FROM tenant_members WHERE tenant_id = p_dst;
  DELETE FROM outlets WHERE tenant_id = p_dst;

  -- ---------------------------------------------------------------------
  -- Pass 1: an id map per table, ALL of them before anything is copied. This
  -- is what makes self-references and forward references resolve in one pass.
  -- ---------------------------------------------------------------------
  FOREACH t IN ARRAY tbls LOOP
    IF clone_has_column(t, 'id') THEN
      EXECUTE format('CREATE TEMP TABLE %I (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP',
                     '_clonemap_' || t);
      EXECUTE format('INSERT INTO %I (old, new) SELECT id, gen_random_uuid() FROM %I s WHERE %s',
                     '_clonemap_' || t, t, clone_scope_sql(t, tbls)) USING p_src;
    END IF;
  END LOOP;

  -- System roles map onto the destination's OWN seeded role of the same key
  -- rather than being copied. Everything that references a role
  -- (tenant_member_roles, role_permissions) then resolves through the same map
  -- and lands on the right row either way.
  UPDATE _clonemap_roles m
     SET new = d.id
    FROM roles srcr, roles d
   WHERE srcr.id = m.old
     AND srcr.tenant_id = p_src AND srcr.is_system
     AND d.tenant_id = p_dst AND d.key = srcr.key;

  -- ---------------------------------------------------------------------
  -- Pass 2: copy, remapping ids as we go.
  -- ---------------------------------------------------------------------
  FOREACH t IN ARRAY tbls LOOP
    col_parts := ARRAY[]::text[];
    sel_parts := ARRAY[]::text[];

    FOR col IN
      SELECT a.attname AS name,
             -- The table this column points at, when it is a single-column FK.
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
        -- Skip generated columns: the database computes them.
        AND a.attgenerated = ''
      ORDER BY a.attnum
    LOOP
      col_parts := col_parts || quote_ident(col.name);

      IF col.name = 'tenant_id' THEN
        sel_parts := sel_parts || '$2'::text;
      ELSIF col.name = 'id' THEN
        sel_parts := sel_parts || format('(SELECT new FROM %I WHERE old = s.id)', '_clonemap_' || t);
      ELSIF col.fk_target IS NOT NULL AND col.fk_target = ANY(tbls) THEN
        -- Points at a table we are also cloning → follow its map. A scalar
        -- subquery yields NULL for a NULL source value, which is what we want;
        -- a non-NULL value that fails to map would mean the row referenced
        -- another tenant, and the NOT NULL / FK check will (correctly) fail
        -- loudly rather than silently pointing at the source café.
        sel_parts := sel_parts ||
          format('(SELECT new FROM %I WHERE old = s.%I)', '_clonemap_' || col.fk_target, col.name);
      ELSE
        -- Shared table (users, plans…) or a plain value: copy through.
        sel_parts := sel_parts || format('s.%I', col.name);
      END IF;
    END LOOP;

    -- System roles already exist in the destination (see above), so copying
    -- them would violate roles(tenant_id, key) — and copying the owner role's
    -- permissions trips the guard trigger that pins it to '*:*'.
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

  -- ---------------------------------------------------------------------
  -- Polymorphic references the catalogue cannot describe.
  --
  -- stock_movements.ref_id points at an order_item or an expense depending on
  -- ref_type, with no FK to derive it from. Left alone it would point into the
  -- SOURCE café — traceability that silently crosses tenants.
  -- ---------------------------------------------------------------------
  UPDATE stock_movements sm
     SET ref_id = m.new
    FROM _clonemap_order_items m
   WHERE sm.tenant_id = p_dst AND sm.ref_type = 'order_item' AND sm.ref_id = m.old;

  UPDATE stock_movements sm
     SET ref_id = m.new
    FROM _clonemap_expenses m
   WHERE sm.tenant_id = p_dst AND sm.ref_type = 'expense' AND sm.ref_id = m.old;

  RETURN counts;
END;
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION clone_tenant_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clone_tenant_data(uuid, uuid) TO app;

-- +goose Down
-- +goose StatementBegin

DROP FUNCTION IF EXISTS clone_tenant_data(uuid, uuid);
DROP FUNCTION IF EXISTS clone_scope_sql(text, text[]);
DROP FUNCTION IF EXISTS clone_has_column(text, text);
DROP INDEX IF EXISTS tenants_cloned_from_idx;
ALTER TABLE tenants
  DROP COLUMN IF EXISTS cloned_at,
  DROP COLUMN IF EXISTS cloned_from_tenant_id;

-- +goose StatementEnd
