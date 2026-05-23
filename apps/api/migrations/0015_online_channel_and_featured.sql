-- +goose Up
-- +goose NO TRANSACTION

-- =========================================================================
-- 0015 — Collapse digital channels into a single 'online' account, and let
--        operators pin menu items as featured so the "Frequently used" row
--        stays useful before there's enough order history to rank by.
--
-- Why now: the cafe operates with two real cash pools (drawer + bank) plus
-- "money that came in digitally and hasn't been swept yet". The eSewa /
-- Khalti / card / other distinction was bookkeeping overhead with no
-- corresponding workflow — every settlement still flowed through the same
-- "look at the phone, confirm receipt" check. Consolidating to a single
-- 'online' channel makes the Move Money and Settle pickers honest.
--
-- Historical rows are migrated forward so the channels list contains one
-- unified Online tile; the old enum values stay in the type (Postgres
-- can't drop enum values without rewriting the column) but no UI surfaces
-- them.
-- =========================================================================

-- 1. Add 'online' to payment_method ----------------------------------------
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'online';

-- 2. Backfill all digital channels to 'online' -----------------------------
-- payments + expenses + account_transfers (both sides). 'card' and 'other'
-- are folded in too — the tenants who would distinguish them are not on the
-- platform yet, and an honest single bucket is better than three nearly-
-- empty ones.
UPDATE payments
   SET method = 'online'
 WHERE method IN ('esewa','khalti','card','other');

UPDATE expenses
   SET payment_method = 'online'
 WHERE payment_method IN ('esewa','khalti','card','other');

UPDATE account_transfers
   SET from_method = 'online'
 WHERE from_method IN ('esewa','khalti','card','other');
UPDATE account_transfers
   SET to_method = 'online'
 WHERE to_method IN ('esewa','khalti','card','other');

-- 3. menu_items.is_featured ------------------------------------------------
-- Operator-pinned items that should surface in the "Frequently used" view
-- even before order history accumulates. Once history exists the popular
-- query blends featured + recent-qty ranking.
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS menu_items_featured_idx
  ON menu_items(tenant_id)
  WHERE is_featured = true AND deleted_at IS NULL;

-- +goose Down
-- +goose NO TRANSACTION

DROP INDEX IF EXISTS menu_items_featured_idx;
ALTER TABLE menu_items DROP COLUMN IF EXISTS is_featured;

-- Reverting the payment_method backfill is not safe — we cannot recover
-- the original esewa/khalti/card split from a row that's been collapsed
-- to 'online'. The Up migration left the old enum values in place, so
-- callers that still write them will continue to work.
