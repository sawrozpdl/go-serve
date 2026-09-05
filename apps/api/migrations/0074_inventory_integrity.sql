-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0074 — Inventory item integrity
--
-- Three related defects, all of which let the Inventory page accept data it
-- then could not manage:
--
--   1. Duplicate item names. Nothing stopped two "Coca-Cola" rows in one
--      tenant, so stock, sales and history silently split across them.
--      house_tabs has enforced the same rule since 0007; inventory never did.
--
--   2. Negative par-low. par_low_units is the level at which a low-stock alert
--      fires, so a negative threshold is meaningless — the alert can never
--      trigger. The handler validated only that the string parsed as a number.
--
--   3. Blank SKUs colliding. inventory_items_tenant_sku_uniq is partial on
--      `sku IS NOT NULL`, but '' is not NULL — so a second item saved with an
--      empty SKU raised 23505 and surfaced as an opaque 500. The web modal
--      sends `sku || null` and dodged this; the API and the bulk importer did
--      not.
--
-- Ordering matters: the data is repaired before the constraints that would
-- reject it are added, so this migration is safe on a populated database.
--
-- Adding indexes/constraints changes no table-level privileges, so no new
-- GRANT is needed (same as 0050 / 0046).
-- =========================================================================

-- 1. Blank SKU means "no SKU". Do this before any SKU comparison. -----------
UPDATE inventory_items
   SET sku = NULL
 WHERE sku IS NOT NULL AND btrim(sku) = '';

-- Trim surviving SKUs and names so " Flour" and "Flour" stop being distinct.
UPDATE inventory_items
   SET sku = btrim(sku)
 WHERE sku IS NOT NULL AND sku <> btrim(sku);

UPDATE inventory_items
   SET name = btrim(name)
 WHERE name <> btrim(name);

-- 2. A negative threshold can never fire an alert; treat it as "no alert". --
UPDATE inventory_items
   SET par_low_units = 0
 WHERE par_low_units < 0;

-- 3. Rename existing case-insensitive duplicate names so the unique index
--    below can be created. The oldest row (by created_at, id) keeps the
--    original name; later ones gain " (2)", " (3)", … The inner loop skips
--    any suffix that is itself already taken, so this cannot produce a new
--    collision. Soft-deleted rows are outside the index and are left alone.
DO $$
DECLARE
  r         record;
  n         int;
  candidate text;
BEGIN
  FOR r IN
    SELECT id, tenant_id, name
      FROM (
        SELECT id, tenant_id, name,
               row_number() OVER (
                 PARTITION BY tenant_id, lower(name)
                 ORDER BY created_at, id
               ) AS rn
          FROM inventory_items
         WHERE deleted_at IS NULL
      ) ranked
     WHERE rn > 1
     ORDER BY tenant_id, name
  LOOP
    n := 2;
    LOOP
      candidate := r.name || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM inventory_items
         WHERE tenant_id = r.tenant_id
           AND deleted_at IS NULL
           AND lower(name) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE inventory_items SET name = candidate WHERE id = r.id;
    RAISE NOTICE 'inventory: renamed duplicate % -> %', r.name, candidate;
  END LOOP;
END $$;

-- 4. The constraints themselves. -------------------------------------------
-- Case-insensitive, matching house_tabs_tenant_name_uniq (0007_shifts.sql).
CREATE UNIQUE INDEX inventory_items_tenant_name_uniq
  ON inventory_items(tenant_id, lower(name)) WHERE deleted_at IS NULL;

-- Left case-SENSITIVE on purpose, unlike name. A SKU is an external
-- identifier owned by a supplier or barcode, and folding case here would
-- force this migration to mangle real identifiers to resolve a collision.
-- Names are display strings and are safe to auto-rename; SKUs are not.
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_par_low_nonneg CHECK (par_low_units >= 0);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- The data repairs above are deliberately not reversed: the original duplicate
-- names and negative thresholds were invalid, and restoring them would only
-- re-break the rows.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_par_low_nonneg;
DROP INDEX IF EXISTS inventory_items_tenant_name_uniq;
-- +goose StatementEnd
