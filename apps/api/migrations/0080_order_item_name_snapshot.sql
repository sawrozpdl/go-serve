-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0080 — Snapshot the item name onto the order line
--
-- order_items captured the price and the cost at add time (0003 L54 says why),
-- but never the NAME: every read joined menu_items live. So renaming "Latte" to
-- "Cafe Latte" silently rewrote it on every historical receipt, every KOT
-- reprint, and the order-history page — for bills that had already been printed
-- and handed to a customer. A café tidying up its menu was rewriting its own
-- records.
--
-- The line now snapshots the name the same way it snapshots the money.
--
-- WHICH READS CHANGE, AND WHICH DELIBERATELY DO NOT
--
-- Order-scoped reads (a specific bill: GetOrder, GetOrderHistory,
-- ListKitchenTickets) switch to this column — they are showing what the
-- customer was given.
--
-- Item-scoped reports (top sellers, movers, sales-by-item, the profitability
-- drill-down's item list, the shift summary's top five) keep joining
-- menu_items. Those GROUP BY mi.id, mi.name to answer "how is this ITEM
-- selling", and a renamed item is still one item. Reading the snapshot there
-- would fragment one item into one row per historical name, which is a worse
-- bug than the one this fixes.
--
-- THE TRIGGER IS THE POINT, exactly as in 0062's base_price_cents
--
-- Filling this in the handler alone would rely on every writer remembering:
-- the demo seed generator, the six direct INSERTs in the test suite, and
-- whatever writes lines next. The trigger makes it structurally true for every
-- insert path, and an explicit value always wins.
--
-- It also makes this migration safe to run BEFORE the new code is live, which
-- is the order the deploy actually uses (migrations run as a one-shot ECS task,
-- then the service rolls). The currently-running binary INSERTs without this
-- column; the trigger fills it, so NOT NULL is satisfied and nothing 500s
-- during the window.
--
-- NO LENGTH CHECK, deliberately. 0077 caps menu_items.name at 80 characters,
-- but a snapshot must be able to hold whatever was legal when it was taken —
-- constraining history to today's rules is how you end up unable to insert a
-- backfilled row.
-- =========================================================================

ALTER TABLE order_items ADD COLUMN menu_item_name text;

-- Safe to backfill from the live catalog: menu_item_id is NOT NULL REFERENCES
-- menu_items ON DELETE RESTRICT (0003 L64) and categories/items are only ever
-- soft-deleted, so every historical line still has a parent row and this cannot
-- leave a NULL behind. It is also the best name available for a line that
-- predates the column.
UPDATE order_items oi
SET menu_item_name = mi.name
FROM menu_items mi
WHERE mi.id = oi.menu_item_id;

-- +goose StatementEnd
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION order_items_default_item_name() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.menu_item_name IS NULL THEN
    SELECT name INTO NEW.menu_item_name FROM menu_items WHERE id = NEW.menu_item_id;
  END IF;
  RETURN NEW;
END;
$fn$;
-- +goose StatementEnd
-- +goose StatementBegin

-- Row triggers fire in name order. 'order_items_base_price_default' sorts
-- before this one; they touch different columns, so the order is immaterial —
-- noted only so the next person doesn't have to work it out.
CREATE TRIGGER order_items_item_name_default
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_default_item_name();

-- NOT NULL is validated after BEFORE triggers run, so the trigger's fill
-- satisfies it (same reasoning as 0062).
ALTER TABLE order_items ALTER COLUMN menu_item_name SET NOT NULL;

COMMENT ON COLUMN order_items.menu_item_name IS
  'The item name AS SOLD, snapshotted at add time like unit_price_cents. '
  'Order-scoped reads (bills, receipts, dockets, history) use this. '
  'Item-scoped reports keep joining menu_items so a rename does not split one '
  'item into several rows. Filled by order_items_item_name_default when omitted.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS order_items_item_name_default ON order_items;
DROP FUNCTION IF EXISTS order_items_default_item_name();
ALTER TABLE order_items DROP COLUMN IF EXISTS menu_item_name;
-- +goose StatementEnd
