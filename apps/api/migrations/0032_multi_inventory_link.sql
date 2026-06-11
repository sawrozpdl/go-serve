-- +goose Up
-- =========================================================================
-- 0032: allow more than one inventory link per menu item
--
-- Originally menu_item_inventory_link.menu_item_id was the PRIMARY KEY, so a
-- menu item could deduct from exactly one inventory item. Combos and prepared
-- items often draw down several stock items per sale (a burger → bun + patty),
-- so widen the key to (menu_item_id, inventory_item_id). Existing single-link
-- rows are valid composite rows and survive untouched.
--
-- DecrementInventoryForOrder already JOINs this table, so a menu item with N
-- links simply emits N stock movements per sale — no handler change required.
--
-- Grants unchanged: app already holds SELECT/INSERT/UPDATE/DELETE (0005).
-- =========================================================================

ALTER TABLE menu_item_inventory_link
  DROP CONSTRAINT menu_item_inventory_link_pkey;

ALTER TABLE menu_item_inventory_link
  ADD CONSTRAINT menu_item_inventory_link_pkey
  PRIMARY KEY (menu_item_id, inventory_item_id);

-- +goose Down
ALTER TABLE menu_item_inventory_link
  DROP CONSTRAINT menu_item_inventory_link_pkey;

ALTER TABLE menu_item_inventory_link
  ADD CONSTRAINT menu_item_inventory_link_pkey
  PRIMARY KEY (menu_item_id);
