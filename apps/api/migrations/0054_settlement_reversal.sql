-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0054 — reversible credit (house-tab) settlements.
--
-- house_tab_settlements was INSERT-only for the `app` role (0007 granted
-- SELECT, INSERT and nothing else) and carries CHECK (amount_cents > 0), so a
-- compensating negative row is impossible too. A settlement recorded for the
-- wrong amount, the wrong tab or the wrong method could therefore NEVER be
-- corrected: it permanently overstated the cash/online/bank account it credited
-- and permanently understated the customer's outstanding credit.
--
-- We keep the table append-only in spirit — the original row stays, visible in
-- the tab ledger — and mark it reversed instead of deleting it. Every roll-up
-- filters `reversed_at IS NULL`, so a reversal removes the money from balances
-- while leaving the full audit trail of what was entered and what undid it.
--
-- UPDATE is granted narrowly for this: the handler only ever sets the three
-- reversal columns, and RLS still confines the row to its tenant.
-- =========================================================================

ALTER TABLE house_tab_settlements
  ADD COLUMN IF NOT EXISTS reversed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_user_id  uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reversal_reason      text NOT NULL DEFAULT '';

-- A reversal is either fully stamped or absent — never half-recorded.
ALTER TABLE house_tab_settlements
  ADD CONSTRAINT house_tab_settlements_reversal_complete
  CHECK ((reversed_at IS NULL) = (reversed_by_user_id IS NULL));

-- Live settlements are the common read; keep them cheap to find per tab.
CREATE INDEX IF NOT EXISTS house_tab_settlements_live_idx
  ON house_tab_settlements(house_tab_id, recorded_at DESC)
  WHERE reversed_at IS NULL;

GRANT UPDATE ON house_tab_settlements TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

REVOKE UPDATE ON house_tab_settlements FROM app;
DROP INDEX IF EXISTS house_tab_settlements_live_idx;
ALTER TABLE house_tab_settlements
  DROP CONSTRAINT IF EXISTS house_tab_settlements_reversal_complete;
ALTER TABLE house_tab_settlements
  DROP COLUMN IF EXISTS reversal_reason,
  DROP COLUMN IF EXISTS reversed_by_user_id,
  DROP COLUMN IF EXISTS reversed_at;

-- +goose StatementEnd
