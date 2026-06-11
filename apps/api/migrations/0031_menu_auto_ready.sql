-- +goose Up
-- =========================================================================
-- 0031: per-item "auto ready" (skip the kitchen)
--
-- Some menu items never need cooking — cigarettes, packaged drinks, retail
-- resell goods. For these, "send to kitchen" should hand the item straight to
-- the customer instead of parking it on the kitchen board. This flag drives
-- that: when an auto_ready item is sent, the order handler jumps it directly to
-- 'served' (stamping sent/ready/served together) so it never shows as a ticket.
--
-- Distinct from the tenant-wide preferences.autoServeOnReady flag, which only
-- collapses the ready→served hop AFTER the kitchen has marked an item ready.
-- auto_ready skips the kitchen entirely, and only for the items so marked.
--
-- No new GRANT needed: app already holds INSERT/UPDATE/SELECT on menu_items
-- (adding a column doesn't change table-level privileges).
-- =========================================================================

ALTER TABLE menu_items
  ADD COLUMN auto_ready boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE menu_items DROP COLUMN auto_ready;
