-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0045: OUTLETS (prep destinations: Kitchen, Bar, Bar2, …)
--
-- Adds the missing *destination* axis to order routing. Until now every prep
-- item went to a single implicit "kitchen": one global KDS board per tenant
-- and flat printer arrays in tenants.preferences. An outlet is a named prep
-- station with its own KDS view and its own (single) network printer.
--
-- Routing is orthogonal to kitchen_behavior (0040): kitchen_behavior decides
-- WHETHER an item hits prep and its landing status (cook/ready/serve); the
-- outlet decides WHERE. Effective outlet resolves item → category → the
-- tenant's default outlet, mirroring the kitchen_behavior resolution shape.
--
-- The FK columns on menu_categories / menu_items / order_items need NO new
-- GRANT: app already holds SELECT/INSERT/UPDATE on those tables and adding a
-- column doesn't change table-level privileges (same as 0040).
-- =========================================================================

CREATE TABLE outlets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  sort          int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  is_default    boolean NOT NULL DEFAULT false,   -- the fallback outlet (seeded "Kitchen")
  printer_ip    text,                             -- network ESC/POS printer (nullable = none yet)
  printer_port  int NOT NULL DEFAULT 9100,
  printer_width text NOT NULL DEFAULT '80' CHECK (printer_width IN ('58', '80')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX outlets_tenant_idx ON outlets(tenant_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX outlets_tenant_name_uniq
  ON outlets(tenant_id, lower(name)) WHERE deleted_at IS NULL;

-- Exactly one default outlet per tenant.
CREATE UNIQUE INDEX outlets_tenant_default_uniq
  ON outlets(tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TRIGGER outlets_updated_at BEFORE UPDATE ON outlets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlets FORCE ROW LEVEL SECURITY;
CREATE POLICY outlets_isolation ON outlets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON outlets TO app;

-- Routing FKs. NULL = inherit (item → category → tenant default). ON DELETE
-- SET NULL so removing an outlet gracefully falls categories/items back to
-- the default rather than blocking the delete.
ALTER TABLE menu_categories
  ADD COLUMN outlet_id uuid REFERENCES outlets(id) ON DELETE SET NULL;

ALTER TABLE menu_items
  ADD COLUMN outlet_id uuid REFERENCES outlets(id) ON DELETE SET NULL;

-- Denormalised destination stamped onto the order item at send-to-kitchen so
-- the KDS board is stable even if a category is later re-pointed. Kept even
-- if the outlet is later deleted (RESTRICT), preserving history on live tickets.
ALTER TABLE order_items
  ADD COLUMN outlet_id uuid REFERENCES outlets(id);

CREATE INDEX order_items_outlet_idx
  ON order_items(tenant_id, outlet_id, kitchen_status)
  WHERE voided_at IS NULL AND kitchen_status IN ('in_progress', 'ready');

-- Seed one default "Kitchen" outlet per existing tenant, importing the first
-- configured kitchen printer (if any) so current setups keep printing.
INSERT INTO outlets (tenant_id, name, is_default, printer_ip, printer_port, printer_width)
SELECT
  t.id,
  'Kitchen',
  true,
  NULLIF(t.preferences->'kitchenPrinters'->0->>'ip', ''),
  COALESCE((t.preferences->'kitchenPrinters'->0->>'port')::int, 9100),
  CASE WHEN t.preferences->'kitchenPrinters'->0->>'width' IN ('58', '80')
       THEN t.preferences->'kitchenPrinters'->0->>'width'
       ELSE '80' END
FROM tenants t;

-- Preserve receipt printing for cafes that used the (now-removed) "receipt same
-- as kitchen" toggle: those printed receipts to the kitchen list, so copy it into
-- receiptPrinters. Without this, dropping the flag would silently stop their
-- receipts from printing. Then drop the orphaned flag.
UPDATE tenants
SET preferences = preferences || jsonb_build_object('receiptPrinters', preferences->'kitchenPrinters')
WHERE COALESCE((preferences->>'receiptSameAsKitchen')::boolean, false)
  AND jsonb_typeof(preferences->'kitchenPrinters') = 'array';

UPDATE tenants
SET preferences = preferences - 'receiptSameAsKitchen'
WHERE preferences ? 'receiptSameAsKitchen';

-- Backfill the new outlet:* grant onto existing manager roles (owners hold *:*).
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'outlet:*' FROM roles WHERE key = 'manager'
ON CONFLICT DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions WHERE permission = 'outlet:*';
ALTER TABLE order_items DROP COLUMN IF EXISTS outlet_id;
ALTER TABLE menu_items DROP COLUMN IF EXISTS outlet_id;
ALTER TABLE menu_categories DROP COLUMN IF EXISTS outlet_id;
DROP TABLE IF EXISTS outlets CASCADE;
-- +goose StatementEnd
