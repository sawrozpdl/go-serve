-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- CASH DRAWER LEDGER  (per-shift pay-ins / pay-outs)
--
-- Closes the gap between "cash arrived/left the till" and "the close-shift
-- reconciliation" — without this every owner-draw or drawer-paid expense
-- counts as variance.
--
-- Direction:  out → cash leaves the drawer, in → cash added to the drawer.
-- Kind:       why it moved. 'expense' rows MUST have expense_id; 'transfer'
--             rows have a paired account_transfers row (cash side).
-- =========================================================================

CREATE TYPE cash_drop_direction AS ENUM ('out', 'in');

CREATE TYPE cash_drop_kind AS ENUM (
  'owner_draw',     -- owner pulls cash for personal/business use
  'bank_deposit',   -- physically deposited to bank
  'expense',        -- drawer paid for an expense (groceries, supplier) — has expense_id
  'transfer',       -- moved into another account (e.g. cash → bank/eSewa)
  'paid_out',       -- generic out (vendor cash, tip-out, etc.)
  'paid_in',        -- generic add-to-drawer (owner top-up)
  'petty_change',   -- replenish small change/coins (in)
  'correction',     -- recount adjustment (either direction)
  'other'
);

CREATE TABLE cash_drops (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id            uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  direction           cash_drop_direction NOT NULL,
  kind                cash_drop_kind NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  reason              text NOT NULL DEFAULT '',
  notes               text NOT NULL DEFAULT '',
  expense_id          uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'expense' OR expense_id IS NOT NULL),
  CHECK (kind = 'expense' OR expense_id IS NULL)
);

CREATE INDEX cash_drops_shift_idx   ON cash_drops(shift_id, recorded_at DESC);
CREATE INDEX cash_drops_tenant_idx  ON cash_drops(tenant_id, recorded_at DESC);
CREATE INDEX cash_drops_expense_idx ON cash_drops(expense_id) WHERE expense_id IS NOT NULL;

ALTER TABLE cash_drops ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_drops FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_drops_isolation ON cash_drops
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- expenses: drawer linkage
--
-- paid_from_drawer=true means the cash physically left the till during a
-- shift; the close-shift math subtracts these so the variance is honest.
-- The CHECK guarantees we can never end up with a "drawer expense" that
-- isn't cash + tied to a shift.
-- =========================================================================

ALTER TABLE expenses
  ADD COLUMN paid_from_drawer boolean NOT NULL DEFAULT false,
  ADD COLUMN shift_id         uuid REFERENCES shifts(id) ON DELETE RESTRICT;

CREATE INDEX expenses_shift_idx ON expenses(shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_drawer_consistency CHECK (
    paid_from_drawer = false
    OR (payment_method = 'cash' AND shift_id IS NOT NULL)
  );

-- =========================================================================
-- ACCOUNT_TRANSFERS  (move balance between payment methods)
--
-- "I cashed out 5,000 from eSewa to the bank", "deposited 12,000 from the
-- drawer to NIBL". Used to keep per-account balances honest in the
-- Accounts report — transfers cancel out across both methods.
--
-- When from_method='cash', shift_id is required and a cash_drops row of
-- kind='transfer' is created in the same tx (cash_drop_id below). When
-- to_method='cash', a cash_drops row of direction='in', kind='paid_in'
-- is created instead.
-- =========================================================================

CREATE TABLE account_transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_method         payment_method NOT NULL,
  to_method           payment_method NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents           bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  reference_no        text NOT NULL DEFAULT '',
  notes               text NOT NULL DEFAULT '',
  transferred_at      timestamptz NOT NULL DEFAULT now(),
  shift_id            uuid REFERENCES shifts(id) ON DELETE RESTRICT,
  cash_drop_id        uuid REFERENCES cash_drops(id) ON DELETE RESTRICT,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  CHECK (from_method <> to_method),
  CHECK (from_method <> 'house_tab' AND to_method <> 'house_tab'),
  CHECK (from_method <> 'cash' OR shift_id IS NOT NULL),
  CHECK (to_method   <> 'cash' OR shift_id IS NOT NULL)
);

CREATE INDEX account_transfers_tenant_idx
  ON account_transfers(tenant_id, transferred_at DESC);
CREATE INDEX account_transfers_shift_idx
  ON account_transfers(shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE account_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY account_transfers_isolation ON account_transfers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_drops TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_transfers TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS account_transfers CASCADE;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_drawer_consistency;
ALTER TABLE expenses DROP COLUMN IF EXISTS shift_id;
ALTER TABLE expenses DROP COLUMN IF EXISTS paid_from_drawer;
DROP INDEX IF EXISTS expenses_shift_idx;
DROP TABLE IF EXISTS cash_drops CASCADE;
DROP TYPE  IF EXISTS cash_drop_kind;
DROP TYPE  IF EXISTS cash_drop_direction;
-- +goose StatementEnd
