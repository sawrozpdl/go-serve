-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0086 — Drop orders.staff_id (the contract half of 0085)
--
-- 0085 erased every staff_id and kept the column only because the binary it
-- replaced still SELECTed it during the migrate-before-roll window. That binary
-- is gone; nothing reads or writes the column now, so it and the trigger that
-- kept it NULL go.
--
-- OpenOrder still accepts a legacy `staff_id` in the request BODY from mobile
-- builds that have not taken the OTA update. That is a JSON field, not this
-- column, and needs neither.
--
-- platform_accuracy_check_discounts was already re-declared without staff_id
-- in 0085, so dropping the column cannot break it.
-- =========================================================================

DROP TRIGGER IF EXISTS orders_anonymise_staff_meal ON orders;
DROP FUNCTION IF EXISTS orders_anonymise_staff_meal();
ALTER TABLE orders DROP COLUMN IF EXISTS staff_id;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- The column comes back empty: the names were erased in 0085.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES staff(id) ON DELETE SET NULL;

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
-- +goose StatementEnd
