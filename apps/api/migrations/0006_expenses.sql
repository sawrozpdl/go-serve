-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- EXPENSE_CATEGORIES
--
-- Operating cost buckets: Rent, Utilities, Salaries, Supplies, Equipment,
-- COGS, Other. SEPARATE from menu_categories (the revenue side). Allocations
-- bridge the two — see expense_allocations below.
-- =========================================================================

CREATE TABLE expense_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX expense_categories_tenant_idx ON expense_categories(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX expense_categories_tenant_name_uniq
  ON expense_categories(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER expense_categories_updated_at BEFORE UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_categories_isolation ON expense_categories
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- EXPENSES
--
-- linked_inventory_item_id ties a purchase expense to an inventory item.
-- When set on insert, the API also writes a stock_movements row with
-- reason='purchase' (single source of truth for inventory + cost basis).
-- =========================================================================

CREATE TABLE expenses (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expense_category_id      uuid REFERENCES expense_categories(id) ON DELETE SET NULL,
  vendor                   text NOT NULL DEFAULT '',
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0),
  paid_at                  timestamptz NOT NULL DEFAULT now(),
  payment_method           text NOT NULL DEFAULT 'cash',
  reference_no             text NOT NULL DEFAULT '',
  receipt_url              text,
  notes                    text NOT NULL DEFAULT '',
  linked_inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  recorded_by_user_id      uuid NOT NULL REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz
);

CREATE INDEX expenses_tenant_paid_idx ON expenses(tenant_id, paid_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX expenses_category_idx ON expenses(expense_category_id) WHERE deleted_at IS NULL;

CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_isolation ON expenses
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- EXPENSE_ALLOCATIONS  (cost-center accounting — the "momo profit" wiring)
--
-- Splits an expense across one or more menu_categories. share_pct is the
-- percentage of the expense attributed to that category (sum may be < 100;
-- the remainder is overhead/unallocated). amount_cents is denormalized for
-- fast roll-ups in the profitability report (M9).
-- =========================================================================

CREATE TABLE expense_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expense_id        uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  menu_category_id  uuid NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
  share_pct         numeric(6,3) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expense_allocations_expense_idx ON expense_allocations(expense_id);
CREATE INDEX expense_allocations_menu_cat_idx ON expense_allocations(menu_category_id);
CREATE UNIQUE INDEX expense_allocations_uniq
  ON expense_allocations(expense_id, menu_category_id);

ALTER TABLE expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_allocations_isolation ON expense_allocations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Grants for runtime app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_categories, expenses, expense_allocations TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS expense_allocations CASCADE;
DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS expense_categories CASCADE;
-- +goose StatementEnd
