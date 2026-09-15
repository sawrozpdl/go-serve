-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0082 — Credit write-offs
--
-- Two requests, one event. "Clear this tab, they're paying 8,000 of the 10,000
-- and we're letting the rest go" and "archive this account, we never got
-- 3,500" are the same fact recorded at two different moments: money the cafe
-- is owed and has decided to stop chasing.
--
-- Until now there was no way to say it. CreateHouseTabSettlement rejects any
-- amount above the outstanding balance, and every settlement is money that
-- actually arrived, so a forgiven remainder simply sat on the books forever.
--
-- A DISCRIMINATOR ON house_tab_settlements, NOT A NEW TABLE
--
-- The tab balance is Σ payments(house_tab) − Σ settlements(live), and that
-- subtraction is written out in nine places. A separate write_offs table would
-- add a third term to every one of them, and a single missed site means a
-- customer still owes money the cafe forgave. Sharing the row means the
-- balance is right everywhere with nothing to remember — and, just as
-- usefully, the existing reversal path (0054) keys on id and never looks at
-- kind, so un-forgiving a write-off works the day this ships.
--
-- payment_method GOES NULL, WHICH IS THE WHOLE TRICK
--
-- Every account-bucket query filters on the method: `= ANY($1)` in money.go
-- and finance.go, `= 'bank'`, `= 'cash'`, and `NOT IN ('cash','bank')` in
-- shifts.go. NULL satisfies none of them — including the NOT IN, because
-- `NULL NOT IN (...)` is NULL rather than true. So a write-off is excluded
-- from the drawer, the bank and the online pool BY CONSTRUCTION, exactly the
-- way 0076's new terminal status excluded staff meals from 44 hand-written
-- sales predicates. Not one money query had to be edited to make that safe,
-- which is precisely why it IS safe.
--
-- The alternative — adding 'write_off' to the payment_method ENUM — was
-- rejected: that enum is shared with payments and expenses, so it would permit
-- a payments row with a method that means nothing, and it would need NO
-- TRANSACTION forever after.
--
-- NO EXPENSE ROW IS WRITTEN, DELIBERATELY
--
-- Booking bad debt through recordExpense looks right and is wrong here.
-- loadAccountBucket SUBTRACTS expenses whose payment_method falls in the
-- bucket, so a bank-paid bad-debt expense would debit the bank tile on the
-- Accounts page and in GetCafeBalance by the written-off amount — for money
-- that never left the bank, because it never arrived in the first place.
-- There is no paid_from value meaning "no account moved" ('owner' books a
-- loan, 'owner_cash' draws down custody), and /super/accuracy-check has no
-- invariant that would catch it. It would simply be silently wrong on two
-- screens, which is the exact failure money.go's header exists to prevent.
--
-- A written-off receivable is not an operating cost. The revenue was
-- recognised when the order closed and stays recognised; the money that will
-- never arrive is reported as its own figure and never folded into either
-- sales or expenses.
--
-- NOT IN THIS CHANGE, deliberately: a write-off allocated to specific charges
-- (the balance has always been a single scalar), an ageing schedule, and an
-- automatic write-off after N days. Resist that last one hardest — forgiving
-- money on a timer is not a feature.
-- =========================================================================

ALTER TABLE house_tab_settlements
  ALTER COLUMN payment_method DROP NOT NULL;

ALTER TABLE house_tab_settlements
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'payment',
  -- Mandatory on a write-off and forbidden on a payment. Forgiving money has
  -- to be answerable, the same rule reversals (0054) already follow.
  ADD COLUMN IF NOT EXISTS write_off_reason text NOT NULL DEFAULT '';

ALTER TABLE house_tab_settlements DROP CONSTRAINT IF EXISTS house_tab_settlements_kind_known;
ALTER TABLE house_tab_settlements ADD CONSTRAINT house_tab_settlements_kind_known
  CHECK (kind IN ('payment', 'write_off'));

COMMENT ON COLUMN house_tab_settlements.kind IS
  'payment = money actually received (CREDIT COLLECTED). write_off = money the '
  'cafe decided it will not get. Both reduce the balance; only payment is ever '
  'reported as collected or lands in an account bucket. See 0082.';

ALTER TABLE house_tab_settlements DROP CONSTRAINT IF EXISTS house_tab_settlements_kind_shape;
ALTER TABLE house_tab_settlements ADD CONSTRAINT house_tab_settlements_kind_shape
  CHECK (
    (kind = 'payment'
       AND payment_method IS NOT NULL
       AND write_off_reason = '')
    OR
    (kind = 'write_off'
       -- The NULL method is what keeps this row out of every bucket query.
       AND payment_method IS NULL
       AND write_off_reason <> ''
       -- A write-off is not cash in a drawer. The method filters in shifts.go
       -- already exclude it; pinning shift_id NULL means a future shift query
       -- that forgets the method filter still cannot miscount it.
       AND shift_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS house_tab_settlements_write_off_idx
  ON house_tab_settlements(tenant_id, house_tab_id, recorded_at)
  WHERE kind = 'write_off' AND reversed_at IS NULL;

-- Column additions change no table-level privileges. house_tab_settlements
-- already holds SELECT/INSERT/UPDATE for app (0007 + 0054); a write-off is an
-- INSERT and its reversal is the existing UPDATE. No new GRANT.

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS house_tab_settlements_write_off_idx;
ALTER TABLE house_tab_settlements DROP CONSTRAINT IF EXISTS house_tab_settlements_kind_shape;
ALTER TABLE house_tab_settlements DROP CONSTRAINT IF EXISTS house_tab_settlements_kind_known;
-- Fail loudly rather than silently re-owing money that was forgiven.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM house_tab_settlements WHERE kind = 'write_off') THEN
    RAISE EXCEPTION 'cannot roll back 0082: write-off rows exist. Reverse or reclassify them first.';
  END IF;
END $$;
ALTER TABLE house_tab_settlements
  DROP COLUMN IF EXISTS write_off_reason,
  DROP COLUMN IF EXISTS kind;
ALTER TABLE house_tab_settlements ALTER COLUMN payment_method SET NOT NULL;
-- +goose StatementEnd
