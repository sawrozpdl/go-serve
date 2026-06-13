-- +goose Up
-- +goose NO TRANSACTION

-- =========================================================================
-- 0034 — Owner cash custody
--
-- Tracks cafe cash that an owner physically takes from the drawer and is now
-- holding ("Due from owner" / petty-cash-custodian model). The holding is a
-- real cafe asset bucket: a withdrawal does NOT change total cafe assets, it
-- only moves cash from the drawer into the owner's hands. The holding is later
-- reconciled by one of:
--   * bank_deposit     — owner deposits the cash to the cafe bank
--   * cafe_expense     — owner spent the cash on the cafe (a real expense)
--   * return_to_drawer — owner puts the cash back in the till
--
-- This is custody only — it never touches owner equity (that's owner_ledger).
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction in
-- Postgres, so this migration runs with NO TRANSACTION. The new 'owner_cash'
-- label is therefore committed before the expenses CHECK below references it.
-- =========================================================================

-- 1. New expense source: owner spent cafe cash they're holding. --------------
ALTER TYPE expense_source ADD VALUE IF NOT EXISTS 'owner_cash';

-- 2. owner_cash_entries — per-owner cash clearing ledger. --------------------
CREATE TYPE owner_cash_kind AS ENUM (
  'withdrawal',       -- drawer -> owner hand   (+holding)
  'bank_deposit',     -- owner hand -> bank     (-holding, +bank)
  'cafe_expense',     -- owner hand -> expense  (-holding)  [linked to an expense]
  'return_to_drawer'  -- owner hand -> drawer   (-holding)
);

CREATE TABLE owner_cash_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id            uuid NOT NULL REFERENCES cafe_owners(id) ON DELETE RESTRICT,
  kind                owner_cash_kind NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  notes               text NOT NULL DEFAULT '',
  reference_no        text NOT NULL DEFAULT '',          -- e.g. bank deposit slip no.
  cash_drop_id        uuid REFERENCES cash_drops(id) ON DELETE RESTRICT, -- withdrawal & return
  expense_id          uuid REFERENCES expenses(id) ON DELETE RESTRICT,   -- cafe_expense
  shift_id            uuid REFERENCES shifts(id) ON DELETE RESTRICT,      -- when drawer touched
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- cafe_expense MUST link to the expense it paid; other kinds MUST NOT.
  CHECK (kind <> 'cafe_expense' OR expense_id IS NOT NULL),
  CHECK (kind  = 'cafe_expense' OR expense_id IS NULL),
  -- only the drawer-touching kinds carry a paired cash_drop.
  CHECK (kind IN ('withdrawal','return_to_drawer') OR cash_drop_id IS NULL)
);

CREATE INDEX owner_cash_entries_tenant_idx  ON owner_cash_entries(tenant_id, occurred_at DESC);
CREATE INDEX owner_cash_entries_owner_idx   ON owner_cash_entries(owner_id, occurred_at DESC);
CREATE INDEX owner_cash_entries_expense_idx ON owner_cash_entries(expense_id) WHERE expense_id IS NOT NULL;

ALTER TABLE owner_cash_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_cash_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_cash_entries_isolation ON owner_cash_entries
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- DELETE is allowed so an unreconciled withdrawal/return can be undone while
-- its shift is still open (handler enforces the closed-shift guard).
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_cash_entries TO app;

-- 3. expenses CHECK gains an owner_cash branch. ------------------------------
-- owner_cash: paid from cafe cash an owner is holding. payment_method='cash'
-- (it IS cash) keeps it out of the bank roll-up; shift_id NULL + no paired
-- cash_drop keeps it out of the live-drawer math; the holding absorbs it.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_paid_from_valid;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_paid_from_valid CHECK (
       (paid_from = 'drawer'     AND payment_method = 'cash' AND shift_id IS NOT NULL AND owner_id IS NULL)
    OR (paid_from = 'bank'       AND payment_method = 'bank' AND shift_id IS NULL     AND owner_id IS NULL)
    OR (paid_from = 'owner'      AND owner_id IS NOT NULL    AND shift_id IS NULL)
    OR (paid_from = 'owner_cash' AND owner_id IS NOT NULL    AND shift_id IS NULL     AND payment_method = 'cash')
  );

-- +goose Down
-- +goose NO TRANSACTION

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_paid_from_valid;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_paid_from_valid CHECK (
       (paid_from = 'drawer' AND payment_method = 'cash' AND shift_id IS NOT NULL AND owner_id IS NULL)
    OR (paid_from = 'bank'   AND payment_method = 'bank' AND shift_id IS NULL     AND owner_id IS NULL)
    OR (paid_from = 'owner'  AND owner_id IS NOT NULL    AND shift_id IS NULL)
  );

DROP TABLE IF EXISTS owner_cash_entries CASCADE;
DROP TYPE  IF EXISTS owner_cash_kind;

-- Removing the 'owner_cash' label from expense_source is not supported by
-- Postgres without rewriting the enum; it's harmless if unused. Left in place.
