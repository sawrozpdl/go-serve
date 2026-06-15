-- +goose Up

-- =========================================================================
-- 0036 — Scoped tenant purge (super-admin "deep delete" by category).
--
-- The blunt delete_tenant_cascade (0035) removes the whole tenant. This adds a
-- category-scoped purge so a super admin can wipe just part of a tenant's data
-- (e.g. demo transaction history) while keeping config (menu, tables, owners).
--
-- Two SECURITY DEFINER functions (owned by the superuser, BYPASSRLS) so the
-- /super route — app_user, no tenant context — can read/delete across the RLS
-- boundary in one bounded call. Callers MUST be gated by RequirePlatformAdmin.
--
-- SCOPES (category -> tables it deletes, cascade children folded in):
--   logs          audit_log, audit_events
--   transactions  orders(+items,adjustments,payments), shifts, cash_drops,
--                 account_transfers, house_tab_settlements,
--                 expenses(+allocations), owner_ledger, owner_cash_entries
--   menu          menu_items(+inventory_link), menu_categories
--   tables        service_tables
--   house_tabs    house_tabs
--   owners        cafe_owners
--   inventory     menu_item_inventory_link, inventory_items(+pack_rules,
--                 stock_movements)
--   staff         staff(+documents, pay)
--   everything    all of the above + team/roles/invites/config + the tenant row
--
-- DEPENDENCY: menu/tables/house_tabs/owners RESTRICT-reference transaction rows
-- (order_items->menu_items, orders->service_tables, payments->house_tabs,
-- owner_ledger->cafe_owners, …), so selecting any of them forces 'transactions'
-- too. The ordered deletes below are child-first so no RESTRICT FK ever fires.
-- =========================================================================

-- tenant_data_counts — rows that WOULD be deleted, per category. Powers the
-- "what will be removed" preview in the super console before confirming.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION tenant_data_counts(p_tenant uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT jsonb_build_object(
    'logs',
      (SELECT count(*) FROM audit_log    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM audit_events WHERE tenant_id = p_tenant),
    'transactions',
      (SELECT count(*) FROM orders               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_adjustments    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM payments             WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM shifts               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM cash_drops           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM account_transfers    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM house_tab_settlements WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM expenses             WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM expense_allocations  WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM owner_ledger         WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM owner_cash_entries   WHERE tenant_id = p_tenant),
    'menu',
      (SELECT count(*) FROM menu_items      WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_categories WHERE tenant_id = p_tenant),
    'tables',      (SELECT count(*) FROM service_tables WHERE tenant_id = p_tenant),
    'house_tabs',  (SELECT count(*) FROM house_tabs     WHERE tenant_id = p_tenant),
    'owners',      (SELECT count(*) FROM cafe_owners    WHERE tenant_id = p_tenant),
    'inventory',
      (SELECT count(*) FROM inventory_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM pack_rules               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM stock_movements          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_inventory_link WHERE tenant_id = p_tenant),
    'staff',
      (SELECT count(*) FROM staff           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_documents WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_pay       WHERE tenant_id = p_tenant)
  )
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION tenant_data_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data_counts(uuid) TO app;

-- purge_tenant_data — deletes the selected scopes child-first, returns the
-- total rows removed. 'everything' expands to all scopes + the tenant row.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION purge_tenant_data(p_tenant uuid, p_scopes text[])
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  total bigint := 0;
  n     bigint;
  s     text[] := p_scopes;
  drop_tenant boolean := 'everything' = ANY(p_scopes);
BEGIN
  IF drop_tenant THEN
    s := ARRAY['logs','transactions','menu','tables','house_tabs','owners','inventory','staff'];
  END IF;

  -- Catalog scopes RESTRICT-reference transaction rows; force 'transactions'.
  IF ('menu' = ANY(s) OR 'tables' = ANY(s) OR 'house_tabs' = ANY(s) OR 'owners' = ANY(s))
     AND NOT ('transactions' = ANY(s)) THEN
    s := array_append(s, 'transactions');
  END IF;

  IF 'logs' = ANY(s) THEN
    DELETE FROM audit_events WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM audit_log    WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'transactions' = ANY(s) THEN
    -- Children first so no RESTRICT fires (owner_* -> shifts/expenses/owners;
    -- owner_ledger self-refs corrects_id/parent_loan_id; payments -> shifts).
    DELETE FROM owner_cash_entries WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant AND (is_correction OR parent_loan_id IS NOT NULL); GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM house_tab_settlements WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM orders WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades order_items, order_adjustments, payments
    DELETE FROM expenses WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades expense_allocations
    DELETE FROM account_transfers WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM cash_drops WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM shifts WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'menu' = ANY(s) THEN
    DELETE FROM menu_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_item_inventory_link
    DELETE FROM menu_categories WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'tables' = ANY(s) THEN
    DELETE FROM service_tables WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'house_tabs' = ANY(s) THEN
    DELETE FROM house_tabs WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'owners' = ANY(s) THEN
    DELETE FROM cafe_owners WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'inventory' = ANY(s) THEN
    DELETE FROM menu_item_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM inventory_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades pack_rules, stock_movements
  END IF;

  IF 'staff' = ANY(s) THEN
    DELETE FROM staff WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades staff_documents, staff_pay
  END IF;

  IF drop_tenant THEN
    -- Remaining tenant-scoped rows (members, roles, invites, expense_categories,
    -- sessions, …) clear via the tenant_id ON DELETE CASCADE.
    DELETE FROM tenants WHERE id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  RETURN total;
END;
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION purge_tenant_data(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tenant_data(uuid, text[]) TO app;

-- +goose Down

DROP FUNCTION IF EXISTS purge_tenant_data(uuid, text[]);
DROP FUNCTION IF EXISTS tenant_data_counts(uuid);
