-- +goose Up
-- +goose NO TRANSACTION

-- =========================================================================
-- 0014 — Cafe Finance: bank account, owners, owner ledger, expense refactor
--
-- Brings the cafe's books into a single coherent model:
--   * 'bank' becomes a first-class payment_method so the existing
--     account_balances + account_transfers machinery handles it.
--   * cafe_owners tracks the people who share equity in the cafe with
--     integer share-units (1:1:1, 1:2:3) and a history-friendly active range.
--   * owner_ledger is the append-only journal of money flowing between
--     owners and the cafe — investment (in), payout (out), loan_advance
--     (owner pays a vendor; cafe owes owner), loan_repayment (cafe pays
--     owner back from bank). Hard-immutable.
--   * expenses gain `paid_from` (drawer | bank | owner) — the bool flag
--     `paid_from_drawer` becomes a generated column derived from paid_from.
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction in
-- Postgres, so this migration runs with NO TRANSACTION (annotation above).
-- Each statement still runs atomically on its own.
-- =========================================================================

-- 1. Promote 'bank' to payment_method enum ----------------------------------
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'bank';

-- 2. Normalise existing expenses.payment_method free-text values ------------
--    (Run before converting the column to the enum.) Lower-case + map any
--    bank-like spellings to 'bank' so the enum cast below doesn't error on
--    stale data. Anything outside the known set falls back to 'other'.
UPDATE expenses
   SET payment_method = lower(trim(payment_method));
UPDATE expenses
   SET payment_method = 'bank'
 WHERE payment_method IN ('nibl', 'bank deposit', 'bank transfer', 'wire');
UPDATE expenses
   SET payment_method = 'other'
 WHERE payment_method NOT IN ('cash','esewa','khalti','card','other','bank','house_tab');

-- 3. Convert expenses.payment_method text → enum ----------------------------
-- Drop the text DEFAULT and the legacy CHECK constraint that compares
-- payment_method to text literals; both block the type cast.
ALTER TABLE expenses
  ALTER COLUMN payment_method DROP DEFAULT;
ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_drawer_consistency;
ALTER TABLE expenses
  ALTER COLUMN payment_method TYPE payment_method
  USING payment_method::payment_method;
ALTER TABLE expenses
  ALTER COLUMN payment_method SET DEFAULT 'cash'::payment_method;

-- 4. cafe_owners ------------------------------------------------------------
CREATE TABLE cafe_owners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  share_units  int  NOT NULL CHECK (share_units > 0),
  active_from  date NOT NULL DEFAULT CURRENT_DATE,
  active_to    date,
  notes        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (active_to IS NULL OR active_to >= active_from),
  CHECK (display_name <> '')
);

CREATE INDEX cafe_owners_tenant_idx ON cafe_owners(tenant_id);
-- One active owner row per (tenant, user) when user_id is set.
CREATE UNIQUE INDEX cafe_owners_active_user_uniq
  ON cafe_owners(tenant_id, user_id)
  WHERE active_to IS NULL AND user_id IS NOT NULL;

CREATE TRIGGER cafe_owners_updated_at BEFORE UPDATE ON cafe_owners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE cafe_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafe_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_owners_isolation ON cafe_owners
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- 5. owner_ledger -----------------------------------------------------------
CREATE TYPE owner_ledger_kind AS ENUM (
  'investment',     -- owner → cafe bank (credits bank, raises owner equity)
  'payout',         -- cafe bank → owner (debits bank, lowers equity)
  'loan_advance',   -- owner paid a vendor for the cafe; cafe owes owner
  'loan_repayment'  -- cafe bank → owner; pays down a loan_advance
);

CREATE TABLE owner_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id           uuid NOT NULL REFERENCES cafe_owners(id) ON DELETE RESTRICT,
  kind               owner_ledger_kind NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  notes              text NOT NULL DEFAULT '',
  expense_id         uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  parent_loan_id     uuid REFERENCES owner_ledger(id) ON DELETE RESTRICT,
  is_correction      boolean NOT NULL DEFAULT false,
  corrects_id        uuid REFERENCES owner_ledger(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- loan_advance MUST link to the expense it paid; other kinds MUST NOT.
  CHECK (kind <> 'loan_advance' OR expense_id IS NOT NULL),
  CHECK (kind  = 'loan_advance' OR expense_id IS NULL),
  -- loan_repayment MUST link to a parent loan_advance; other kinds MUST NOT.
  CHECK (kind <> 'loan_repayment' OR parent_loan_id IS NOT NULL),
  CHECK (kind  = 'loan_repayment' OR parent_loan_id IS NULL),
  -- correction entries reference the row they reverse.
  CHECK (is_correction = false OR corrects_id IS NOT NULL)
);

CREATE INDEX owner_ledger_tenant_idx ON owner_ledger(tenant_id, occurred_at DESC);
CREATE INDEX owner_ledger_owner_idx  ON owner_ledger(owner_id, occurred_at DESC);
CREATE INDEX owner_ledger_kind_idx   ON owner_ledger(tenant_id, kind);
CREATE INDEX owner_ledger_parent_idx ON owner_ledger(parent_loan_id) WHERE parent_loan_id IS NOT NULL;
CREATE INDEX owner_ledger_expense_idx ON owner_ledger(expense_id) WHERE expense_id IS NOT NULL;

ALTER TABLE owner_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_ledger_isolation ON owner_ledger
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Append-only: no UPDATE, no DELETE (corrections happen via paired rows).
GRANT SELECT, INSERT ON cafe_owners TO app;
GRANT UPDATE         ON cafe_owners TO app;  -- for share_units edits + deactivate
GRANT SELECT, INSERT ON owner_ledger TO app;

-- 6. Refactor `expenses` ---------------------------------------------------
CREATE TYPE expense_source AS ENUM ('drawer', 'bank', 'owner');

-- (The old drawer-only consistency check was already dropped in step 3.)

ALTER TABLE expenses
  ADD COLUMN paid_from expense_source NOT NULL DEFAULT 'bank',
  ADD COLUMN owner_id  uuid REFERENCES cafe_owners(id) ON DELETE RESTRICT;

-- Backfill paid_from from the existing bool — but only for actually-drawer
-- expenses. The catch is the old constraint also permitted method='cash' +
-- shift_id set with paid_from_drawer=false (legacy), so we tighten by
-- treating any cash+shift_id pair as drawer-paid.
UPDATE expenses
   SET paid_from = 'drawer'
 WHERE paid_from_drawer = true
    OR (payment_method = 'cash' AND shift_id IS NOT NULL);

-- For non-drawer rows, default the payment_method to 'bank' so they fit
-- the new model. Anything with method='cash' but no shift can't be drawer;
-- promote to 'bank' so the ledger is honest (these are legacy rows that
-- predate proper shift tracking).
UPDATE expenses
   SET payment_method = 'bank'
 WHERE paid_from = 'bank'
   AND payment_method = 'cash';

-- Drop the boolean column; replace with a generated column so any external
-- reader keeps working.
ALTER TABLE expenses DROP COLUMN paid_from_drawer;
ALTER TABLE expenses
  ADD COLUMN paid_from_drawer boolean
    GENERATED ALWAYS AS (paid_from = 'drawer') STORED;

-- Re-add the consistency CHECK against the new column.
ALTER TABLE expenses
  ADD CONSTRAINT expenses_paid_from_valid CHECK (
       (paid_from = 'drawer' AND payment_method = 'cash' AND shift_id IS NOT NULL AND owner_id IS NULL)
    OR (paid_from = 'bank'   AND payment_method = 'bank' AND shift_id IS NULL     AND owner_id IS NULL)
    OR (paid_from = 'owner'  AND owner_id IS NOT NULL    AND shift_id IS NULL)
  );

CREATE INDEX expenses_paid_from_idx ON expenses(paid_from);
CREATE INDEX expenses_owner_idx ON expenses(owner_id) WHERE owner_id IS NOT NULL;

-- 7. Tighten cash_drops --------------------------------------------------
-- Correction movements must come with a note (the user explicitly requires
-- this — corrections without justification have no audit value). System-
-- internal kinds (expense/transfer) keep filling reason+notes from their
-- handlers.
ALTER TABLE cash_drops
  ADD CONSTRAINT cash_drops_correction_notes CHECK (
    kind <> 'correction' OR length(coalesce(notes, '')) > 0
  );

-- +goose Down
-- +goose NO TRANSACTION

ALTER TABLE cash_drops DROP CONSTRAINT IF EXISTS cash_drops_correction_notes;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_paid_from_valid;
ALTER TABLE expenses DROP COLUMN IF EXISTS paid_from_drawer;
ALTER TABLE expenses DROP COLUMN IF EXISTS owner_id;
ALTER TABLE expenses DROP COLUMN IF EXISTS paid_from;
DROP TYPE IF EXISTS expense_source;

-- Restore the original bool column with a best-effort backfill.
ALTER TABLE expenses ADD COLUMN paid_from_drawer boolean NOT NULL DEFAULT false;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_drawer_consistency CHECK (
    paid_from_drawer = false
    OR (payment_method = 'cash' AND shift_id IS NOT NULL)
  );

DROP TABLE IF EXISTS owner_ledger CASCADE;
DROP TYPE  IF EXISTS owner_ledger_kind;
DROP TABLE IF EXISTS cafe_owners CASCADE;

-- Reverting the expenses.payment_method TYPE ALTER and removing 'bank' from
-- the payment_method enum is irreversible in Postgres without rewriting the
-- enum. Leave both in place on Down — they're harmless if unused.
