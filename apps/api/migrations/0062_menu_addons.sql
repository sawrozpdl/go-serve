-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0062: MENU ADD-ONS (reusable modifier groups)
--
-- THE PROBLEM
--
-- Add-ons were being created as ordinary menu_items ("Add-on cheese", priced
-- Rs 50). That is wrong in three visible places:
--   * the tab panel lists the add-on as a PEER of the sandwich it belongs to,
--     with its own IN PROGRESS chip, so a 2-item order reads as 3 items;
--   * the KDS shows it as a separate ticket the cook has to mentally re-attach;
--   * the public QR menu lists it as something a customer can order on its own.
--
-- THE MODEL (Square / Toast / Lightspeed)
--
-- Add-ons live in their OWN catalog, never in menu_items:
--
--   menu_modifier_groups   "Sandwich extras"  (min/max selectable)
--     └─ menu_modifiers    "Extra cheese" +50, "No onion" +0
--
-- A group attaches to any number of items AND/OR whole categories, so
-- "Extra shot" is defined once and reused. The effective set for an item is
-- the UNION of its own attachments and its category's — groups compose rather
-- than override, which is the difference from kitchen_behavior (0040) and
-- outlet (0045) resolution, both of which pick a single winner.
--
-- ON THE ORDER: FOLDED PRICE + ITEMISED ROWS
--
-- A chosen add-on is a property of an order LINE, not a line of its own. Two
-- things record it:
--
--   1. order_items.unit_price_cents is the FOLDED price — the item's own price
--      plus every chosen add-on. base_price_cents (new) keeps the item's own
--      price so the two can be separated again.
--   2. order_item_modifiers holds one row per chosen add-on, snapshotting name
--      and price at add time.
--
-- Folding is the load-bearing decision. ~30 queries across reports,
-- profitability, analytics, shift summaries, discounts, settle quotes and
-- platform_accuracy_check() compute money as `qty * unit_price_cents` over a
-- flat order_items. Folding keeps every one of them correct with NO edits, and
-- keeps the KDS ticket DTO (one card per order_item) honest. Child order_items
-- would have required auditing all of them and suppressing phantom cards.
--
-- The itemised rows are what folding alone would have cost us: per-add-on
-- inventory depletion, per-add-on cost, and a receipt/docket that can print
-- "+ Extra cheese" under its parent.
--
-- The denormalisation is checked, not trusted: platform_accuracy_check() gains
-- an invariant that unit_price_cents = base_price_cents + SUM(add-on prices),
-- and the same for cost.
--
-- NOTE ON menu_items.modifiers / order_items.modifiers: those jsonb columns
-- (0002/0003) were speculative and NEVER written by any client. They are
-- superseded by this migration and left in place only to avoid a rewrite of
-- unrelated INSERTs; drop them in a later migration once nothing reads them.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Catalog
-- -------------------------------------------------------------------------

CREATE TABLE menu_modifier_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Selection bounds. min_select >= 1 makes the group REQUIRED (the POS must
  -- not let the line be added without a choice); max_select NULL = unlimited.
  -- min 0 / max 1 is the classic optional single-pick; min 1 / max 1 is
  -- "choose a size".
  min_select  int NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select  int CHECK (max_select IS NULL OR max_select >= 1),
  sort        int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT menu_modifier_groups_bounds_sane
    CHECK (max_select IS NULL OR max_select >= min_select)
);

CREATE UNIQUE INDEX menu_modifier_groups_tenant_name_uniq
  ON menu_modifier_groups(tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX menu_modifier_groups_tenant_idx
  ON menu_modifier_groups(tenant_id) WHERE deleted_at IS NULL;

CREATE TRIGGER menu_modifier_groups_updated_at BEFORE UPDATE ON menu_modifier_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_modifier_groups_isolation ON menu_modifier_groups
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_modifier_groups TO app;

CREATE TABLE menu_modifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES menu_modifier_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Zero IS legal here, unlike menu_items (CreateMenuItem rejects <= 0): a
  -- free choice ("No sugar", "Regular size") is a normal modifier.
  price_cents bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  -- NULL = unknown, matching menu_items.cost_cents (0002): an unknown cost
  -- contributes 0 to COGS rather than pretending the add-on is free to make.
  cost_cents  bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  sort        int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE UNIQUE INDEX menu_modifiers_group_name_uniq
  ON menu_modifiers(group_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX menu_modifiers_group_idx
  ON menu_modifiers(group_id, sort) WHERE deleted_at IS NULL;
CREATE INDEX menu_modifiers_tenant_idx
  ON menu_modifiers(tenant_id) WHERE deleted_at IS NULL;

CREATE TRIGGER menu_modifiers_updated_at BEFORE UPDATE ON menu_modifiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_modifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_modifiers_isolation ON menu_modifiers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_modifiers TO app;

-- -------------------------------------------------------------------------
-- Attachment: a group applies to specific items and/or whole categories.
-- RESTRICT on group_id so deleting a group in use is refused rather than
-- silently stripping add-ons off a live menu.
-- -------------------------------------------------------------------------

CREATE TABLE menu_item_modifier_groups (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id     uuid NOT NULL REFERENCES menu_modifier_groups(id) ON DELETE RESTRICT,
  sort         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (menu_item_id, group_id)
);

CREATE INDEX menu_item_modifier_groups_group_idx ON menu_item_modifier_groups(group_id);
CREATE INDEX menu_item_modifier_groups_tenant_idx ON menu_item_modifier_groups(tenant_id);

ALTER TABLE menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_item_modifier_groups_isolation ON menu_item_modifier_groups
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_item_modifier_groups TO app;

CREATE TABLE menu_category_modifier_groups (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES menu_modifier_groups(id) ON DELETE RESTRICT,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, group_id)
);

CREATE INDEX menu_category_modifier_groups_group_idx ON menu_category_modifier_groups(group_id);
CREATE INDEX menu_category_modifier_groups_tenant_idx ON menu_category_modifier_groups(tenant_id);

ALTER TABLE menu_category_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_category_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_category_modifier_groups_isolation ON menu_category_modifier_groups
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_category_modifier_groups TO app;

-- -------------------------------------------------------------------------
-- Add-on stock consumption. Mirrors menu_item_inventory_link (0005/0032):
-- N inventory items per modifier, RESTRICT on the inventory side so an
-- ingredient still in use can't be deleted out from under a live menu.
-- -------------------------------------------------------------------------

-- Column name matches menu_item_inventory_link's so the depletion query can
-- UNION the two paths and the admin UI can reuse one link editor.
CREATE TABLE modifier_inventory_link (
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  modifier_id           uuid NOT NULL REFERENCES menu_modifiers(id) ON DELETE CASCADE,
  inventory_item_id     uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  qty_consumed_per_sale numeric NOT NULL CHECK (qty_consumed_per_sale > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (modifier_id, inventory_item_id)
);

CREATE INDEX modifier_inventory_link_inv_idx ON modifier_inventory_link(inventory_item_id);
CREATE INDEX modifier_inventory_link_tenant_idx ON modifier_inventory_link(tenant_id);

ALTER TABLE modifier_inventory_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_inventory_link FORCE ROW LEVEL SECURITY;
CREATE POLICY modifier_inventory_link_isolation ON modifier_inventory_link
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON modifier_inventory_link TO app;

-- -------------------------------------------------------------------------
-- The order side.
-- -------------------------------------------------------------------------

-- The line's OWN price/cost, before add-ons are folded in. Backfilled from the
-- current values: every existing line has no add-ons, so base == unit.
ALTER TABLE order_items
  ADD COLUMN base_price_cents bigint,
  ADD COLUMN base_cost_cents  bigint;

UPDATE order_items SET base_price_cents = unit_price_cents,
                       base_cost_cents  = unit_cost_cents;

-- Deliberately NO column default. An omitted column arrives as NULL, which the
-- trigger below reads as "this line has no add-ons" and fills from the unit
-- price. A DEFAULT 0 would instead insert a real zero and silently break the
-- fold invariant.
--
-- The point is to make "no add-ons → base == unit" structurally true for EVERY
-- insert path — the seed generator, the ~5 direct INSERTs in the test suite, and
-- any future writer — instead of relying on each of them to remember. The
-- handler that does have add-ons passes both columns explicitly, and an explicit
-- value always wins.
--
-- INSERT only: on UPDATE the two columns must move together deliberately (see
-- UpdateOrderItem's re-fold), and quietly rewriting base on any unit-price
-- update would mask exactly the drift platform_accuracy_check_addons exists to
-- catch.
-- +goose StatementEnd
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION order_items_default_base_price() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.base_price_cents := COALESCE(NEW.base_price_cents, NEW.unit_price_cents);
  NEW.base_cost_cents  := COALESCE(NEW.base_cost_cents,  NEW.unit_cost_cents);
  RETURN NEW;
END;
$fn$;
-- +goose StatementEnd
-- +goose StatementBegin

CREATE TRIGGER order_items_base_price_default
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_default_base_price();

-- NOT NULL is validated after BEFORE triggers run, so the trigger's fill
-- satisfies it.
ALTER TABLE order_items
  ALTER COLUMN base_price_cents SET NOT NULL,
  ALTER COLUMN base_cost_cents  SET NOT NULL;

CREATE TABLE order_item_modifiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  -- RESTRICT, like order_items -> menu_items: a modifier that has been sold
  -- is history and must not be hard-deleted (the catalog soft-deletes).
  modifier_id   uuid NOT NULL REFERENCES menu_modifiers(id) ON DELETE RESTRICT,
  -- Snapshots taken at add time, so renaming or repricing a modifier never
  -- rewrites an old receipt. Same discipline as order_items.unit_price_cents.
  group_name    text NOT NULL,
  name          text NOT NULL,
  price_cents   bigint NOT NULL CHECK (price_cents >= 0),
  cost_cents    bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  -- How many of this add-on ON ONE UNIT of the parent (double cheese = 2).
  -- The parent's qty multiplies through unit_price_cents, so this stays
  -- per-unit. numeric to match order_items.qty (0044 half-plates).
  qty           numeric NOT NULL DEFAULT 1 CHECK (qty > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_item_modifiers_line_idx ON order_item_modifiers(order_item_id);
CREATE INDEX order_item_modifiers_modifier_idx ON order_item_modifiers(modifier_id);
CREATE INDEX order_item_modifiers_tenant_idx ON order_item_modifiers(tenant_id);

ALTER TABLE order_item_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_modifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY order_item_modifiers_isolation ON order_item_modifiers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON order_item_modifiers TO app;

-- +goose StatementEnd

-- -------------------------------------------------------------------------
-- Keep the accuracy checker honest about the folded price.
--
-- Folding add-on money into unit_price_cents is a denormalisation, so it gets
-- checked rather than trusted: a line's unit price must equal its base price
-- plus its add-ons, and the same for cost.
--
-- This is a SEPARATE function rather than an edit to platform_accuracy_check()
-- (0056) because that function is one 120-line UNION ALL — re-declaring it here
-- would duplicate every unrelated check and guarantee the two copies drift. It
-- returns platform_accuracy_check's EXACT column shape, including the same
-- is_platform_admin gating, so the /super/accuracy-check handler simply UNIONs
-- the two. That means the e2e harness's assertClean() covers it for free.
-- -------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION platform_accuracy_check_addons(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  tenant_id   uuid,
  slug        text,
  check_key   text,
  entity      text,
  entity_id   uuid,
  detail      text,
  delta_cents bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
  WITH allowed AS (
    -- Platform admins only; a non-admin caller gets an empty set rather than an
    -- error, exactly as in 0056.
    SELECT t.id, t.slug
    FROM tenants t
    WHERE is_platform_admin(current_user_id())
      AND (p_tenant IS NULL OR t.id = p_tenant)
  ),
  -- Aggregate over order_item_modifiers, NOT over order_items. Almost every
  -- line has no add-ons at all, so grouping the (large) order_items table would
  -- make this check scale with total order history instead of with add-on usage.
  -- Driving from the small table and LEFT JOINing back on the primary key keeps
  -- it proportional to the add-ons actually sold.
  folded AS (
    SELECT order_item_id,
           SUM(round(qty * price_cents))::bigint AS add_price,
           SUM(round(qty * cost_cents))::bigint  AS add_cost
    FROM order_item_modifiers
    GROUP BY order_item_id
  )

  SELECT a.id, a.slug, 'addon_price_fold', 'order_item', oi.id,
         format('unit_price %s <> base %s + add-ons %s',
                oi.unit_price_cents, oi.base_price_cents, COALESCE(f.add_price, 0)),
         (oi.unit_price_cents - (oi.base_price_cents + COALESCE(f.add_price, 0)))::bigint
  FROM allowed a
  JOIN order_items oi ON oi.tenant_id = a.id
  LEFT JOIN folded f ON f.order_item_id = oi.id
  WHERE oi.unit_price_cents <> oi.base_price_cents + COALESCE(f.add_price, 0)

  UNION ALL

  SELECT a.id, a.slug, 'addon_cost_fold', 'order_item', oi.id,
         format('unit_cost %s <> base %s + add-ons %s',
                oi.unit_cost_cents, oi.base_cost_cents, COALESCE(f.add_cost, 0)),
         (oi.unit_cost_cents - (oi.base_cost_cents + COALESCE(f.add_cost, 0)))::bigint
  FROM allowed a
  JOIN order_items oi ON oi.tenant_id = a.id
  LEFT JOIN folded f ON f.order_item_id = oi.id
  WHERE oi.unit_cost_cents <> oi.base_cost_cents + COALESCE(f.add_cost, 0)

  ORDER BY 3, 1, 5
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION platform_accuracy_check_addons(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_accuracy_check_addons(uuid) TO app;

-- -------------------------------------------------------------------------
-- Fold the six new tables into the purge/count inventory (0036).
--
-- Cascade coverage means only three need explicit handling:
--   * menu_item_modifier_groups / menu_category_modifier_groups cascade from
--     menu_items / menu_categories, but hold a RESTRICT ref to
--     menu_modifier_groups — so groups must be deleted AFTER them.
--   * modifier_inventory_link holds a RESTRICT ref to inventory_items, so it
--     must be cleared before the 'inventory' scope drops those (exactly the
--     reason menu_item_inventory_link is already deleted explicitly there).
--   * order_item_modifiers cascades from order_items, but its RESTRICT ref to
--     menu_modifiers means the 'transactions' scope must run before 'menu' —
--     which the existing forced-dependency rule already guarantees.
-- -------------------------------------------------------------------------
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
    + (SELECT count(*) FROM order_item_modifiers WHERE tenant_id = p_tenant)
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
      (SELECT count(*) FROM menu_items                    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_categories               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_modifier_groups          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_modifiers                WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_modifier_groups     WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_category_modifier_groups WHERE tenant_id = p_tenant),
    'tables',      (SELECT count(*) FROM service_tables WHERE tenant_id = p_tenant),
    'house_tabs',  (SELECT count(*) FROM house_tabs     WHERE tenant_id = p_tenant),
    'owners',      (SELECT count(*) FROM cafe_owners    WHERE tenant_id = p_tenant),
    'inventory',
      (SELECT count(*) FROM inventory_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM pack_rules               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM stock_movements          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_inventory_link WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM modifier_inventory_link  WHERE tenant_id = p_tenant),
    'staff',
      (SELECT count(*) FROM staff           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_documents WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_pay       WHERE tenant_id = p_tenant)
  )
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION tenant_data_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data_counts(uuid) TO app;

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
    DELETE FROM orders WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades order_items (-> order_item_modifiers), order_adjustments, payments
    DELETE FROM expenses WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades expense_allocations
    DELETE FROM account_transfers WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM cash_drops WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM shifts WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'menu' = ANY(s) THEN
    DELETE FROM menu_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_item_inventory_link, menu_item_modifier_groups
    DELETE FROM menu_categories WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_category_modifier_groups
    -- Now that nothing RESTRICT-references the groups, the add-on catalog goes.
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

-- The two purge functions must be rolled back to their 0036 bodies BEFORE the
-- tables go, or they would be left referencing relations that no longer exist
-- and every super-admin delete would fail at call time.
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

-- +goose StatementBegin

DROP FUNCTION IF EXISTS platform_accuracy_check_addons(uuid);

DROP TABLE IF EXISTS order_item_modifiers;
DROP TRIGGER IF EXISTS order_items_base_price_default ON order_items;
DROP FUNCTION IF EXISTS order_items_default_base_price();
ALTER TABLE order_items DROP COLUMN IF EXISTS base_cost_cents;
ALTER TABLE order_items DROP COLUMN IF EXISTS base_price_cents;
DROP TABLE IF EXISTS modifier_inventory_link;
DROP TABLE IF EXISTS menu_category_modifier_groups;
DROP TABLE IF EXISTS menu_item_modifier_groups;
DROP TABLE IF EXISTS menu_modifiers;
DROP TABLE IF EXISTS menu_modifier_groups;

-- +goose StatementEnd
