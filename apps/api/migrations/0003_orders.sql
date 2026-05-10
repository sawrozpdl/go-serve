-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- ORDERS  (the "tab")
--
-- One open order per service_table at any time (enforced by partial unique
-- index). Money columns stay at 0 while open; finalized at close-time (M5).
-- =========================================================================

CREATE TYPE order_status AS ENUM ('open', 'closed', 'cancelled');

CREATE TABLE orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_table_id       uuid REFERENCES service_tables(id) ON DELETE RESTRICT,
  status                 order_status NOT NULL DEFAULT 'open',
  opened_by_user_id      uuid NOT NULL REFERENCES users(id),
  opened_at              timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz,
  cancelled_at           timestamptz,
  notes                  text NOT NULL DEFAULT '',
  -- Totals are populated at close (M5). For open tabs the live total
  -- is computed by summing order_items at read time.
  subtotal_cents         bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents         bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents              bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  service_charge_cents   bigint NOT NULL DEFAULT 0 CHECK (service_charge_cents >= 0),
  total_cents            bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_tenant_status_idx ON orders(tenant_id, status);
CREATE INDEX orders_service_table_idx ON orders(service_table_id) WHERE status = 'open';

-- One open tab per table (when service_table_id is set).
CREATE UNIQUE INDEX orders_one_open_per_table
  ON orders(service_table_id)
  WHERE status = 'open' AND service_table_id IS NOT NULL;

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_isolation ON orders
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- ORDER_ITEMS
--
-- unit_price_cents is captured at add-time so price changes on menu_items
-- don't retroactively affect open tabs.
-- =========================================================================

CREATE TYPE kitchen_status AS ENUM ('pending', 'in_progress', 'ready', 'served');

CREATE TABLE order_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id                 uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id             uuid NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  qty                      int NOT NULL CHECK (qty > 0),
  unit_price_cents         bigint NOT NULL CHECK (unit_price_cents >= 0),
  -- Per-unit cost captured at add-time, mirror of unit_price_cents.
  -- 0 = unknown; profitability uses this for per-sale COGS.
  unit_cost_cents          bigint NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  modifiers                jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                    text NOT NULL DEFAULT '',
  kitchen_status           kitchen_status NOT NULL DEFAULT 'pending',
  sent_to_kitchen_at       timestamptz,
  ready_at                 timestamptz,
  served_at                timestamptz,
  voided_at                timestamptz,
  voided_by_user_id        uuid REFERENCES users(id),
  void_reason              text,
  void_approved_by_user_id uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE INDEX order_items_kitchen_idx ON order_items(tenant_id, kitchen_status)
  WHERE voided_at IS NULL AND kitchen_status IN ('in_progress', 'ready');

CREATE TRIGGER order_items_updated_at BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY order_items_isolation ON order_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- ORDER_ADJUSTMENTS
-- Discounts, service charge overrides, tax overrides applied to a tab.
-- =========================================================================

CREATE TYPE order_adjustment_type AS ENUM ('discount', 'service_charge', 'tax_override');

CREATE TABLE order_adjustments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type                order_adjustment_type NOT NULL,
  amount_cents        bigint NOT NULL,
  reason              text NOT NULL DEFAULT '',
  applied_by_user_id  uuid REFERENCES users(id),
  approved_by_user_id uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_adjustments_order_idx ON order_adjustments(order_id);

ALTER TABLE order_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY order_adjustments_isolation ON order_adjustments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Grants for the runtime app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON orders, order_items, order_adjustments TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS order_adjustments CASCADE;
DROP TYPE  IF EXISTS order_adjustment_type;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TYPE  IF EXISTS kitchen_status;
DROP TABLE IF EXISTS orders CASCADE;
DROP TYPE  IF EXISTS order_status;
-- +goose StatementEnd
