-- +goose Up
-- +goose NO TRANSACTION

-- =========================================================================
-- 0076 — Staff meals
--
-- Until now, feeding staff meant ringing the food up on a real table: it
-- occupied a table the cafe wanted to seat, and it counted as a sale. The
-- cafe's revenue included food nobody paid for, and the only way to zero the
-- money was a full discount, which then inflated the discount figure instead.
--
-- A staff meal is modelled as what it actually is: stock leaving the shelf for
-- a member of staff, at no charge, attributed to a person.
--
-- WHY A NEW TERMINAL STATUS, AND NOT A BOOLEAN FLAG
--
-- There are 44 hand-written `status = 'closed'` predicates across the API
-- outside the shared closedOrdersInWindow constant (money.go). A flag would
-- mean auditing every one of them, and missing a single site silently corrupts
-- a money figure — precisely the failure money.go's header exists to prevent.
--
-- Giving staff meals their own terminal status means every existing sales
-- predicate excludes them by construction, with nothing to remember. This is
-- also the codebase's own precedent: the go-live opening balance is a
-- synthetic *cancelled* order for exactly this reason (orders.go,
-- openingBalanceMarker). Reports that want staff meals ask for them by name.
--
-- NO EXPENSE ROW IS WRITTEN, DELIBERATELY
--
-- The food was already expensed when it was bought (expenses + a `purchase`
-- stock movement — see docs/inventory-and-cogs.md, Path A). Booking a second
-- expense when it is eaten would count the same cash twice. What was missing
-- was never a cost entry; it was that the meal was counted as revenue. The
-- perk's value is reported from order_items.unit_cost_cents, which is already
-- captured at add-time for exactly this kind of question.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction, hence
-- NO TRANSACTION (same as 0034).
-- =========================================================================

-- 1. The terminal status. --------------------------------------------------
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'staff_meal';

-- 2. Who ate it. -----------------------------------------------------------
-- SET NULL rather than RESTRICT: removing a staff member must not be blocked
-- by, or erase, the history of stock that genuinely left the shelf.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES staff(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS orders_staff_meal_idx
  ON orders(tenant_id, staff_id, closed_at)
  WHERE status = 'staff_meal';

-- 3. A staff meal never occupies a table, which is half the point of the
--    feature. Enforced rather than trusted: orders_one_open_per_table would
--    otherwise let a staff meal hold a table hostage while it is open.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_has_no_table;
ALTER TABLE orders ADD CONSTRAINT orders_staff_meal_has_no_table
  CHECK (status <> 'staff_meal' OR service_table_id IS NULL);

-- Adding a column/index/constraint changes no table-level privileges, so no
-- new GRANT is needed (same as 0050 / 0046).

-- +goose Down
-- +goose NO TRANSACTION
-- The enum label cannot be removed once added (Postgres has no
-- ALTER TYPE ... DROP VALUE), so any staff_meal rows would be orphaned by a
-- rollback. Fail loudly instead of silently corrupting them.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE status = 'staff_meal') THEN
    RAISE EXCEPTION 'cannot roll back 0076: staff-meal orders exist. Reclassify or delete them first.';
  END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_has_no_table;
DROP INDEX IF EXISTS orders_staff_meal_idx;
ALTER TABLE orders DROP COLUMN IF EXISTS staff_id;
