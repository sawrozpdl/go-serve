-- +goose Up
-- =========================================================================
-- 0040: configurable kitchen routing (replaces per-item auto_ready)
--
-- Decomposes the old boolean menu_items.auto_ready into a single "kitchen
-- behaviour" routing that can be set per category (default) and per item
-- (override). On send-to-kitchen an order item is routed to:
--
--   cook   → 'in_progress' (normal: kitchen cooks, waiter serves)
--   ready  → 'ready'       (skip cooking; lands in the KDS Ready column)
--   serve  → 'served'      (skip kitchen + serve entirely — the old auto_ready)
--
-- 'inherit' is the sentinel: an item inherits its category, and a category
-- inherits the tenant-wide default derived from preferences.autoReadyOnSend +
-- preferences.autoServeOnReady. Effective behaviour resolves item → category
-- → tenant-default.
--
-- No new GRANT needed: app already holds INSERT/UPDATE/SELECT on these tables
-- (adding a column doesn't change table-level privileges).
-- =========================================================================

ALTER TABLE menu_categories
  ADD COLUMN kitchen_behavior text NOT NULL DEFAULT 'inherit'
    CHECK (kitchen_behavior IN ('inherit', 'cook', 'ready', 'serve'));

ALTER TABLE menu_items
  ADD COLUMN kitchen_behavior text NOT NULL DEFAULT 'inherit'
    CHECK (kitchen_behavior IN ('inherit', 'cook', 'ready', 'serve'));

-- Carry the legacy flag forward: auto_ready=true meant straight-to-served.
UPDATE menu_items SET kitchen_behavior = 'serve' WHERE auto_ready = true;

ALTER TABLE menu_items DROP COLUMN auto_ready;

-- +goose Down
ALTER TABLE menu_items
  ADD COLUMN auto_ready boolean NOT NULL DEFAULT false;

UPDATE menu_items SET auto_ready = true WHERE kitchen_behavior = 'serve';

ALTER TABLE menu_items DROP COLUMN kitchen_behavior;
ALTER TABLE menu_categories DROP COLUMN kitchen_behavior;
