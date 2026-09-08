-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0078 — Category-wise discounts
--
-- Until now a discount was one scalar on the whole bill. A café that wants
-- "10% off breakfast, 15% off desserts, nothing off the rest" had no way to say
-- so, and no way to find out afterwards what the promotion cost.
--
-- HOW THE PERCENTAGE REACHES THE BILL
--
-- It is applied automatically: the cashier never taps anything. But it is NOT
-- derived on the fly inside buildQuote, and that distinction is the whole
-- design. A derived discount would mean order_adjustments is no longer the
-- complete record of what was taken off a bill, and everything downstream
-- assumes that it is:
--
--   * the per-row delete in the discount UI would have nothing to delete, so a
--     promo could not be waived for one awkward bill;
--   * remainingDiscountHeadroom counts rows, so a manual discount stacked on a
--     derived promo could exceed the bill — buildQuote floors the base at zero
--     and the stored columns then stop reconciling;
--   * platform_accuracy_check's order_arithmetic invariant would start firing on
--     live rows, which is precisely what discounts.go's headroom comment exists
--     to prevent;
--   * and reporting could not attribute the discount to the category that
--     earned it, which is the main thing the café asked for.
--
-- So syncCategoryPromotions (category_promotions.go) MATERIALISES ordinary
-- order_adjustments rows — type='discount', reason='promotion' — on every
-- transaction that changes what the order contains, and again inside CloseOrder.
-- buildQuote, CloseOrder, remainingDiscountHeadroom, the receipt builders and
-- the accuracy checks all keep working untouched. This is the same reasoning
-- engage_redeem.go used for QR rewards: the SAME shape as a manual discount.
--
-- The consequence worth knowing: because close re-syncs, the percentage in force
-- AT SETTLE is the one that applies. Editing a category mid-service does not
-- reprice tabs continuously, and orders.discount_cents is frozen at close, so
-- history never moves under anyone afterwards.
--
-- BASIS POINTS, NOT numeric(5,2)
--
-- engage_campaign_tiers.percent_bp already exists and engage_redeem.go already
-- computes subtotal * percent_bp / 10000. Matching it keeps every discount
-- percentage an integer end to end. service_charge_pct and vat_pct are
-- numeric(5,2) only because they predate the money-vocabulary work, and they
-- pay for it with a string round-trip through parsePctHundredths; there is no
-- reason to add a fourth caller to that.
--
-- NOT IN THIS CHANGE, deliberately: a per-item override (a discount has an
-- identity element — 0 — so it needs no 'inherit' sentinel the way
-- kitchen_behavior does), a scheduled start/end window, and a promotions table
-- for concurrent campaigns. Materialised rows are what will make a window safe
-- to add later: you evaluate the promo at one instant and freeze the result,
-- rather than letting a wall-clock boundary reprice a tab between the cashier
-- reading the total and the guest paying it.
-- =========================================================================

ALTER TABLE menu_categories
  ADD COLUMN discount_percent_bp int NOT NULL DEFAULT 0
    CHECK (discount_percent_bp BETWEEN 0 AND 10000);

COMMENT ON COLUMN menu_categories.discount_percent_bp IS
  'Category promotion in basis points (1000 = 10.00%). 0 = no promotion. '
  'Applied automatically, but materialised as order_adjustments rows by '
  'syncCategoryPromotions rather than derived in buildQuote — see 0078.';

ALTER TABLE order_adjustments
  -- The category this discount was granted for. NULL = an ordinary manual
  -- discount or a QR reward: real money, but not attributable to one category.
  -- A promo row is exactly one where this is NOT NULL, which is how the sync
  -- knows which rows are its own to replace.
  ADD COLUMN menu_category_id uuid REFERENCES menu_categories(id) ON DELETE RESTRICT,
  -- The percentage the amount was derived from, kept so a receipt and an audit
  -- trail can say "Breakfast 10%" instead of a bare rupee figure, and so a
  -- later percentage change cannot rewrite what a closed bill actually gave.
  ADD COLUMN percent_bp int
    CHECK (percent_bp IS NULL OR percent_bp BETWEEN 1 AND 10000),
  ADD CONSTRAINT order_adjustments_category_is_discount
    CHECK (menu_category_id IS NULL OR type = 'discount');

-- RESTRICT, not SET NULL: SET NULL would silently un-attribute a historical
-- discount and corrupt the profitability allocation retroactively. Categories
-- are soft-deleted in practice and menu_items.category_id is already RESTRICT,
-- so "a category carrying billing history is not hard-deletable" is the stance
-- this codebase already takes.

CREATE INDEX order_adjustments_category_idx
  ON order_adjustments(menu_category_id) WHERE menu_category_id IS NOT NULL;

-- Lets a cashier waive the promotion on one bill. Without it, deleting a promo
-- row would only last until the next line was added and the sync re-created it.
ALTER TABLE orders
  ADD COLUMN promotions_waived boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN orders.promotions_waived IS
  'Set when someone deletes a category-promotion row, so syncCategoryPromotions '
  'stops re-creating it for this order. Never set for an ordinary discount.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE orders DROP COLUMN IF EXISTS promotions_waived;
DROP INDEX IF EXISTS order_adjustments_category_idx;
ALTER TABLE order_adjustments
  DROP CONSTRAINT IF EXISTS order_adjustments_category_is_discount,
  DROP COLUMN IF EXISTS percent_bp,
  DROP COLUMN IF EXISTS menu_category_id;
ALTER TABLE menu_categories DROP COLUMN IF EXISTS discount_percent_bp;
-- +goose StatementEnd
