-- +goose Up

-- =========================================================================
-- 0064 — Fix the delete ORDER inside purge_tenant_data's 'transactions' scope.
--
-- THE BUG (present since 0036)
--
-- The scope deleted `expenses` before `cash_drops`, but cash_drops.expense_id
-- RESTRICT-references expenses. So the purge aborted for ANY café that had ever
-- paid an expense from the drawer:
--
--   ERROR: update or delete on table "expenses" violates foreign key constraint
--          "cash_drops_expense_id_fkey" on table "cash_drops"
--
-- That is not a rare shape — it is the normal one. On this database sahan has 55
-- such rows, brews 19, plain-cafe 9. Which means the super-admin "delete
-- everything" and "purge transactions" actions have been failing on real cafés,
-- and 'everything' expands to include 'transactions', so tenant deletion was
-- broken too. Found by trying to purge a tenant clone.
--
-- `staff_pay.expense_id` is a second, quieter blocker: it also references
-- expenses (NO ACTION, i.e. effectively RESTRICT), and staff_pay was only ever
-- deleted by the 'staff' scope. Purging transactions WITHOUT staff therefore hit
-- the same wall. A salary payment is a transaction, so it now goes with them.
--
-- THE ORDER, and why each step is where it is
--
--   owner_cash_entries      -> cash_drops, expenses, shifts, owners
--   owner_ledger (2 passes) -> expenses, owners, and ITSELF
--   house_tab_settlements   -> house_tabs, shifts
--   orders                  cascades order_items (-> order_item_modifiers),
--                           order_adjustments, payments
--   staff_pay               -> expenses   (must precede it)
--   account_transfers       -> shifts, cash_drops
--   cash_drops              -> shifts, expenses  (must precede expenses)
--   expenses                cascades expense_allocations
--   shifts                  last: everything above referenced it
--
-- Only the 'transactions' branch changes; every other scope is carried over from
-- 0062 unchanged.
-- =========================================================================

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
    -- Child-first. See the header for why each line sits where it does; the
    -- cash_drops-before-expenses and staff_pay-before-expenses orderings are the
    -- two that were wrong.
    DELETE FROM owner_cash_entries WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant AND (is_correction OR parent_loan_id IS NOT NULL); GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM house_tab_settlements WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM orders WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades order_items (-> order_item_modifiers), order_adjustments, payments
    DELETE FROM staff_pay WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- references expenses
    DELETE FROM account_transfers WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM cash_drops WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- references expenses
    DELETE FROM expenses WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades expense_allocations
    DELETE FROM shifts WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'menu' = ANY(s) THEN
    DELETE FROM menu_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_item_inventory_link, menu_item_modifier_groups
    DELETE FROM menu_categories WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_category_modifier_groups
    DELETE FROM menu_modifier_groups WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_modifiers -> modifier_inventory_link
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
    -- Both link tables RESTRICT-reference inventory_items, so clear them first.
    DELETE FROM modifier_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
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

-- Restores 0062's body, bug and all — a Down that "helpfully" kept the fix would
-- make the migration non-reversible in effect.
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

  IF ('menu' = ANY(s) OR 'tables' = ANY(s) OR 'house_tabs' = ANY(s) OR 'owners' = ANY(s))
     AND NOT ('transactions' = ANY(s)) THEN
    s := array_append(s, 'transactions');
  END IF;

  IF 'logs' = ANY(s) THEN
    DELETE FROM audit_events WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM audit_log    WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'transactions' = ANY(s) THEN
    DELETE FROM owner_cash_entries WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant AND (is_correction OR parent_loan_id IS NOT NULL); GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM house_tab_settlements WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM orders WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM expenses WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM account_transfers WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM cash_drops WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM shifts WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'menu' = ANY(s) THEN
    DELETE FROM menu_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_categories WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_modifier_groups WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
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
    DELETE FROM modifier_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_item_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM inventory_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'staff' = ANY(s) THEN
    DELETE FROM staff WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF drop_tenant THEN
    DELETE FROM tenants WHERE id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  RETURN total;
END;
$fn$;
-- +goose StatementEnd
