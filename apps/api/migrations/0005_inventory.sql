-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- INVENTORY_ITEMS
--
-- Master list of countable stuff. `qty_on_hand_units` is denormalized for
-- read speed; the source of truth is the stock_movements ledger. A trigger
-- below keeps the two in sync automatically.
--
-- kind:
--   retail     — sold directly (a stick of cigarette, a bottle of water)
--   ingredient — consumed by recipes (M6 doesn't deduct these; M-future BOM does)
-- =========================================================================

CREATE TYPE inventory_item_kind AS ENUM ('retail', 'ingredient');

CREATE TABLE inventory_items (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                          text NOT NULL,
  sku                           text,
  kind                          inventory_item_kind NOT NULL DEFAULT 'retail',
  sale_unit                     text NOT NULL DEFAULT 'unit',
  qty_on_hand_units             numeric(14,3) NOT NULL DEFAULT 0,
  par_low_units                 numeric(14,3) NOT NULL DEFAULT 0,
  last_purchase_unit_cost_cents bigint,
  notes                         text NOT NULL DEFAULT '',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  deleted_at                    timestamptz
);

CREATE INDEX inventory_items_tenant_idx ON inventory_items(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX inventory_items_tenant_sku_uniq
  ON inventory_items(tenant_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_items_isolation ON inventory_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- PACK_RULES
--
-- "1 carton = 200 sticks" — translates a purchase unit into a sale unit.
-- Multiple rules per item are allowed (e.g. "1 case = 10 cartons" too).
-- =========================================================================

CREATE TABLE pack_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_item_id        uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  container_unit           text NOT NULL,
  container_qty            int  NOT NULL DEFAULT 1 CHECK (container_qty > 0),
  sale_unit                text NOT NULL,
  sale_qty_per_container   int  NOT NULL CHECK (sale_qty_per_container > 0),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pack_rules_item_idx ON pack_rules(inventory_item_id);

ALTER TABLE pack_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY pack_rules_isolation ON pack_rules
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- STOCK_MOVEMENTS
--
-- Append-only ledger. delta_units is signed: +N for purchase/adjust-up,
-- -N for sale/waste. The trigger below keeps qty_on_hand_units in sync.
-- =========================================================================

CREATE TYPE stock_movement_reason AS ENUM ('purchase', 'sale', 'waste', 'adjust', 'transfer');

CREATE TABLE stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_item_id   uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  delta_units         numeric(14,3) NOT NULL CHECK (delta_units <> 0),
  reason              stock_movement_reason NOT NULL,
  ref_type            text,                  -- 'order_item' | 'expense' | 'manual'
  ref_id              uuid,
  unit_cost_cents     bigint,                -- captured for purchases (cost-basis)
  notes               text NOT NULL DEFAULT '',
  by_user_id          uuid REFERENCES users(id),
  at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_item_at_idx ON stock_movements(inventory_item_id, at DESC);
CREATE INDEX stock_movements_tenant_at_idx ON stock_movements(tenant_id, at DESC);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_isolation ON stock_movements
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Trigger: on any stock_movements insert, apply delta to inventory_items
-- and (for purchases) capture last unit cost.
CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE inventory_items
  SET qty_on_hand_units            = qty_on_hand_units + NEW.delta_units,
      last_purchase_unit_cost_cents = CASE
        WHEN NEW.reason = 'purchase' AND NEW.unit_cost_cents IS NOT NULL
          THEN NEW.unit_cost_cents
        ELSE last_purchase_unit_cost_cents
      END,
      updated_at = now()
  WHERE id = NEW.inventory_item_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- =========================================================================
-- MENU_ITEM_INVENTORY_LINK
--
-- Connects a sellable menu item to an inventory item. v1 = one row per
-- menu_item (no recipes). qty_consumed_per_sale is in the inventory item's
-- sale_unit (e.g., 1 stick consumed per "single cigarette" menu item).
-- =========================================================================

CREATE TABLE menu_item_inventory_link (
  menu_item_id           uuid PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_item_id      uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  qty_consumed_per_sale  numeric(14,3) NOT NULL CHECK (qty_consumed_per_sale > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX menu_item_inventory_link_inv_idx ON menu_item_inventory_link(inventory_item_id);

CREATE TRIGGER menu_item_inventory_link_updated_at BEFORE UPDATE ON menu_item_inventory_link
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_item_inventory_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_inventory_link FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_item_inventory_link_isolation ON menu_item_inventory_link
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Grants for runtime app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_items, pack_rules, stock_movements, menu_item_inventory_link TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS menu_item_inventory_link CASCADE;
DROP TRIGGER IF EXISTS stock_movements_apply ON stock_movements;
DROP FUNCTION IF EXISTS apply_stock_movement();
DROP TABLE IF EXISTS stock_movements CASCADE;
DROP TYPE  IF EXISTS stock_movement_reason;
DROP TABLE IF EXISTS pack_rules CASCADE;
DROP TABLE IF EXISTS inventory_items CASCADE;
DROP TYPE  IF EXISTS inventory_item_kind;
-- +goose StatementEnd
