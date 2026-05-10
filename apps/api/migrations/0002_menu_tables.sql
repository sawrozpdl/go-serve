-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- MENU_CATEGORIES
-- Per-tenant catalog grouping. Doubles as the "cost center" for profitability
-- reports (M9): expense_allocations.menu_category_id roll-up.
-- =========================================================================

CREATE TABLE menu_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort        int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  color       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX menu_categories_tenant_idx ON menu_categories(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX menu_categories_tenant_name_uniq
  ON menu_categories(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER menu_categories_updated_at BEFORE UPDATE ON menu_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_categories_isolation ON menu_categories
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- MENU_ITEMS
-- modifiers jsonb is intentional looseness — cafe modifiers vary widely
-- (size, sugar, hookah flavor). Tighten in v2 when shape is known.
-- =========================================================================

CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  price_cents   bigint NOT NULL CHECK (price_cents >= 0),
  -- The cafe's own cost to make/buy one unit. Nullable = "cost unknown";
  -- profitability reports treat NULL as 0. Captured onto order_items at
  -- add-time so changes here don't rewrite history.
  cost_cents    bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  sku           text,
  image_url     text,
  is_active     boolean NOT NULL DEFAULT true,
  modifiers     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort          int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX menu_items_tenant_idx ON menu_items(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX menu_items_category_idx ON menu_items(category_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX menu_items_tenant_sku_uniq
  ON menu_items(tenant_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER menu_items_updated_at BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_items_isolation ON menu_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- SERVICE_TABLES
-- Physical cafe tables. "service_tables" not "tables" to avoid SQL keyword
-- friction.
-- =========================================================================

CREATE TYPE service_table_status AS ENUM ('free', 'occupied', 'reserved', 'dirty');

CREATE TABLE service_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  capacity    int NOT NULL DEFAULT 2 CHECK (capacity > 0),
  area        text NOT NULL DEFAULT '',
  status      service_table_status NOT NULL DEFAULT 'free',
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX service_tables_tenant_idx ON service_tables(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX service_tables_tenant_name_uniq
  ON service_tables(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER service_tables_updated_at BEFORE UPDATE ON service_tables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE service_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY service_tables_isolation ON service_tables
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Grants for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_categories, menu_items, service_tables TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS service_tables CASCADE;
DROP TYPE  IF EXISTS service_table_status;
DROP TABLE IF EXISTS menu_items CASCADE;
DROP TABLE IF EXISTS menu_categories CASCADE;
-- +goose StatementEnd
