-- +goose Up
-- =========================================================================
-- 0044: halfable items (½ / 1½ / 3½ plates)
--
-- Some items are routinely sold in half plates (momo, chow mein). This adds a
-- per-item opt-in flag; only items with allow_half = true may be ordered in
-- fractional quantities, and the API restricts those to 0.5 steps. Everything
-- else stays whole-number as before.
--
-- order_items.qty widens from int to numeric(6,2) to hold the halves. The
-- existing "qty > 0" CHECK stays valid for numeric, and every line-total is
-- computed as SUM(qty * unit_price_cents)::bigint, which still rounds cleanly
-- to paisa. Existing rows keep their whole-number values untouched.
--
-- No new GRANT needed: app already holds INSERT/UPDATE/SELECT on menu_items
-- and order_items (widening a column / adding a column doesn't change
-- table-level privileges).
-- =========================================================================

ALTER TABLE menu_items
  ADD COLUMN allow_half boolean NOT NULL DEFAULT false;

ALTER TABLE order_items
  ALTER COLUMN qty TYPE numeric(6,2);

-- +goose Down
ALTER TABLE order_items
  ALTER COLUMN qty TYPE int;

ALTER TABLE menu_items DROP COLUMN allow_half;
