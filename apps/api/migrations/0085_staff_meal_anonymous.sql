-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0085 — Staff meals stop recording who ate what
--
-- 0076 attributed every staff meal to a person (orders.staff_id), and the
-- staff-meals report broke the cost down per head. That turned out to be the
-- wrong question: the owner wants to know what feeding the team costs, not to
-- keep a ledger of what each person ate. Tracking it per person is nosy.
--
-- A staff meal is now one shared "Staff meals" tab with items in it. The
-- 'staff_meal' terminal status, cost valuation and stock depletion from 0076
-- are all unchanged — only the attribution goes.
--
-- WHAT MARKS AN ORDER AS A STAFF MEAL
--
-- staff_id was doing double duty: it named the person AND it was the only
-- thing that made an OPEN order a staff meal (the status only flips at close,
-- see the 0081 comment on orders_staff_meal_is_dine_in). is_staff_meal takes
-- over the second job.
--
-- THE NAMES ARE ERASED, NOT HIDDEN
--
-- staff_id is NULLed on every row so the history is anonymised too. Counts and
-- costs survive; who ate them does not, and a rollback cannot restore it.
--
-- WHY THE COLUMN IS NOT DROPPED HERE
--
-- Migrations run before the new API tasks roll, so for a few minutes the
-- previous binary runs against this schema — and it SELECTs o.staff_id on
-- every floor and tab read. Dropping the column now would 500 the floor for
-- that window. It stays, always NULL, and a later migration drops it once no
-- deployed binary reads it.
--
-- Until then a trigger keeps it NULL: an older binary, or an older mobile build
-- still waiting on its OTA update, may write a staff_id. The trigger turns that
-- write into an anonymous staff meal instead of letting the name back in.
--
-- NO UNIQUE INDEX FOR "ONE OPEN STAFF-MEAL TAB"
--
-- A cafe may have several staff meals open at the moment this runs (one per
-- person, under the old model). A unique partial index would fail to build on
-- exactly those cafes, and CI migrates an empty database so it would only fail
-- in prod. OpenOrder serialises on an advisory lock and reuses the open tab
-- instead; any legacy extras stay visible on the floor until finished.
-- =========================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_staff_meal boolean NOT NULL DEFAULT false;

UPDATE orders
   SET is_staff_meal = true
 WHERE staff_id IS NOT NULL OR status = 'staff_meal';

-- Every legacy meal is labelled with the person's name (OpenOrder defaulted
-- table_label to it), and the audit trail spelled it out too. Both go, open or
-- closed — erasing staff_id alone would leave the names sitting in text.
UPDATE orders
   SET table_label = 'Staff meals'
 WHERE is_staff_meal;

UPDATE audit_log
   SET summary = 'opened order on the staff meals tab'
 WHERE entity = 'order' AND summary LIKE 'opened order on staff meal for %';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_is_dine_in;
ALTER TABLE orders ADD CONSTRAINT orders_staff_meal_is_dine_in
  CHECK (NOT is_staff_meal OR order_type = 'dine_in');

-- orders_staff_meal_has_no_table (0076) only binds once the status flips; this
-- one holds from the first item, for the same reason as the dine-in rule.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_no_table;
ALTER TABLE orders ADD CONSTRAINT orders_staff_meal_no_table
  CHECK (NOT is_staff_meal OR service_table_id IS NULL);

-- Re-declared verbatim from 0079 but for the staff-meal predicate: a SQL
-- function body is only checked when called, so the later staff_id drop would
-- otherwise leave the accuracy check failing at runtime.
CREATE OR REPLACE FUNCTION platform_accuracy_check_discounts(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  tenant_id   uuid,
  slug        text,
  check_key   text,
  entity      text,
  entity_id   uuid,
  detail      text,
  delta_cents bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
  WITH allowed AS (
    SELECT t.id, t.slug
    FROM tenants t
    WHERE is_platform_admin(current_user_id())
      AND (p_tenant IS NULL OR t.id = p_tenant)
  )
  SELECT a.id, a.slug, 'order_discount_rows', 'order', o.id,
         format('discount_cents %s but discount rows sum to %s',
                o.discount_cents, d.rows_sum),
         d.rows_sum - o.discount_cents
  FROM allowed a
  JOIN orders o ON o.tenant_id = a.id AND o.status = 'closed' AND NOT o.is_staff_meal
  JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents), 0)::bigint AS rows_sum
    FROM order_adjustments
    WHERE order_id = o.id AND type = 'discount'
  ) d ON true
  WHERE d.rows_sum <> o.discount_cents
$fn$;

UPDATE orders SET staff_id = NULL WHERE staff_id IS NOT NULL;

CREATE OR REPLACE FUNCTION orders_anonymise_staff_meal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.staff_id IS NOT NULL THEN
    NEW.is_staff_meal := true;
    NEW.staff_id      := NULL;
    NEW.table_label   := 'Staff meals';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS orders_anonymise_staff_meal ON orders;
CREATE TRIGGER orders_anonymise_staff_meal
  BEFORE INSERT OR UPDATE OF staff_id ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_anonymise_staff_meal();

-- The 0076 index keyed on staff_id, which is now always NULL.
DROP INDEX IF EXISTS orders_staff_meal_idx;
CREATE INDEX IF NOT EXISTS orders_staff_meal_idx
  ON orders(tenant_id, closed_at)
  WHERE status = 'staff_meal';

-- A column, an index and constraints change no table-level privileges, so no
-- new GRANT is needed (same as 0076 / 0081).

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- The names are gone for good: staff_id stays NULL on every row. An open
-- staff meal stops being one (only the closed ones keep their status).
DROP TRIGGER IF EXISTS orders_anonymise_staff_meal ON orders;
DROP FUNCTION IF EXISTS orders_anonymise_staff_meal();
DROP INDEX IF EXISTS orders_staff_meal_idx;
CREATE INDEX IF NOT EXISTS orders_staff_meal_idx
  ON orders(tenant_id, staff_id, closed_at)
  WHERE status = 'staff_meal';

CREATE OR REPLACE FUNCTION platform_accuracy_check_discounts(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  tenant_id   uuid,
  slug        text,
  check_key   text,
  entity      text,
  entity_id   uuid,
  detail      text,
  delta_cents bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
  WITH allowed AS (
    SELECT t.id, t.slug
    FROM tenants t
    WHERE is_platform_admin(current_user_id())
      AND (p_tenant IS NULL OR t.id = p_tenant)
  )
  SELECT a.id, a.slug, 'order_discount_rows', 'order', o.id,
         format('discount_cents %s but discount rows sum to %s',
                o.discount_cents, d.rows_sum),
         d.rows_sum - o.discount_cents
  FROM allowed a
  JOIN orders o ON o.tenant_id = a.id AND o.status = 'closed' AND o.staff_id IS NULL
  JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents), 0)::bigint AS rows_sum
    FROM order_adjustments
    WHERE order_id = o.id AND type = 'discount'
  ) d ON true
  WHERE d.rows_sum <> o.discount_cents
$fn$;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_no_table;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_staff_meal_is_dine_in;
ALTER TABLE orders ADD CONSTRAINT orders_staff_meal_is_dine_in
  CHECK (staff_id IS NULL OR order_type = 'dine_in');
ALTER TABLE orders DROP COLUMN IF EXISTS is_staff_meal;
-- +goose StatementEnd
