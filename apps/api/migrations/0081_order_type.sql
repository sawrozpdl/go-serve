-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0081 — Order type: dine-in, takeaway, delivery
--
-- Until now the product had no idea whether food was leaving the building. A
-- tab with no table was implicitly "take-away", a meaning carried entirely by
-- resolveTableLabel()'s fallback string — which differed per screen ("Walk-in"
-- on web, "Take-away" on mobile, "Unknown" on the floor) and never reached the
-- kitchen at all. A cook who plates a takeaway, or boxes a dine-in, remakes it
-- either way.
--
-- text + CHECK, NOT AN ENUM
--
-- 0076 used ALTER TYPE ... ADD VALUE because order_status already existed and
-- had to be extended. A NEW three-value set has nothing to extend. An enum
-- would cost NO TRANSACTION on every future addition, a value that can never
-- be removed (0076's Down block is the scar that leaves), and a ::text cast at
-- every read site — in exchange for no ordering, no operators and no storage
-- win. staff.status (0023) is this repo's own precedent for a small closed set
-- on a new column.
--
-- NOT DERIVED FROM service_table_id, DELIBERATELY
--
-- The obvious shortcut is "no table means takeaway". It cannot express either
-- of the two cases that motivated this:
--
--   * a DELIVERY order has no table and is not a takeaway. It is a different
--     fulfilment channel, with a different cost and a different promise.
--   * a DINE-IN tab must be flippable to takeaway mid-service, without moving
--     the guest off the table they are still sitting at while the food is
--     boxed. A derived column makes that literally unsayable.
--
-- The inverse is real too: a counter-service cafe seats people at a shared bar
-- with no table row at all, and that is dine-in. So order_type is DATA, set by
-- whoever knows, and MoveOrder deliberately does not touch it — reseating a
-- guest is not a statement about where the food is going.
--
-- A STAFF MEAL IS NOT A TAKEAWAY
--
-- 0076's whole point is that a staff meal is stock leaving the shelf, not a
-- serve. Letting one be labelled TAKEAWAY on a docket would recreate exactly
-- the confusion 0076 removed. Pinned by constraint rather than by convention,
-- the same way orders_staff_meal_has_no_table is.
--
-- NOT IN THIS CHANGE, deliberately: a delivery-partner or channel table, a
-- delivery fee or per-channel commission on the bill, and per-type service
-- charge rules. All three are money paths and each needs its own money.go-grade
-- argument. This change adds a LABEL and nothing else: no figure in money.go
-- moves by one paisa because of it.
-- =========================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'dine_in';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_known;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_known
  CHECK (order_type IN ('dine_in', 'takeaway', 'delivery'));

COMMENT ON COLUMN orders.order_type IS
  'Fulfilment channel: dine_in | takeaway | delivery. Independent of '
  'service_table_id — see 0081. Always dine_in for a staff meal.';

-- Backfill reproduces the meaning the old code carried implicitly: a table-less
-- order WAS a take-away. A staff meal never was, and the DEFAULT already put it
-- right, so it is excluded here rather than corrected afterwards.
--
-- BOTH guards are needed; neither implies the other, and the pair is exactly
-- the set of rows the constraint below would reject:
--
--   * staff_id IS NULL excludes an OPEN staff meal, which carries a staff_id
--     but whose status is still plain 'open' — the terminal 'staff_meal'
--     status only arrives when it is closed. This is the row that matters: a
--     status-only test relabels every in-progress staff meal 'takeaway' and
--     the constraint then rejects the whole migration.
--   * status <> 'staff_meal' excludes a CLOSED staff meal whose staff member
--     was since deleted. 0076 made that FK ON DELETE SET NULL, so the row has
--     no staff_id to test; the constraint would allow 'takeaway' here, but the
--     meal was still never a serve.
UPDATE orders
   SET order_type = 'takeaway'
 WHERE service_table_id IS NULL
   AND staff_id IS NULL
   AND status <> 'staff_meal';

-- Keyed on staff_id, NOT on status. The terminal 'staff_meal' status only
-- exists once the meal is closed; while it is being rung up the row is an
-- ordinary 'open' order carrying a staff_id. A status-only constraint would
-- happily let an OPEN staff meal be labelled 'takeaway' and only object when
-- the cook tried to finish it — turning a wrong label into a serve that cannot
-- be closed at all. staff_id is the thing that actually makes it a staff meal,
-- from the first item to the last, so that is what the rule tests.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_is_dine_in;
ALTER TABLE orders ADD CONSTRAINT orders_staff_meal_is_dine_in
  CHECK (staff_id IS NULL OR order_type = 'dine_in');

-- Lets a report split a day's serves by type without a sequential scan.
CREATE INDEX IF NOT EXISTS orders_type_closed_idx
  ON orders(tenant_id, order_type, closed_at)
  WHERE status = 'closed';

-- A column, an index and two constraints change no table-level privileges, so
-- no new GRANT is needed (same as 0076 / 0050 / 0046).

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_is_dine_in;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_known;
DROP INDEX IF EXISTS orders_type_closed_idx;
ALTER TABLE orders DROP COLUMN IF EXISTS order_type;
-- +goose StatementEnd
