-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- STAFF PAYROLL + SCHEDULE + LIFECYCLE + TEAM LINK (0033)
--
-- Extends the staff registry (0023) with:
--   • compensation — a salary amount + cadence on the profile, plus a
--     staff_pay ledger recording each actual payment over time;
--   • a recurring weekly shift template (schedule jsonb), one time range per
--     day, keys "0".."6" (0=Sun .. 6=Sat), a missing key meaning "off";
--   • lifecycle close-out — ended_on, complementing the existing
--     active/inactive status;
--   • an optional link to a tenant_members user_id, since most staff also use
--     the app. The link is associative only — full_name/email stay editable on
--     the staff row and are NOT slaved to the user account.
-- =========================================================================

ALTER TABLE staff
  ADD COLUMN ended_on        date,
  ADD COLUMN salary_amount   numeric(14,2),                   -- nullable; NULL = not tracked
  ADD COLUMN salary_cadence  text NOT NULL DEFAULT 'monthly'
    CHECK (salary_cadence IN ('monthly', 'hourly', 'per_shift')),
  ADD COLUMN schedule        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- weekly template; see header
  ADD COLUMN user_id         uuid REFERENCES users(id) ON DELETE SET NULL;  -- optional team-member link

CREATE INDEX staff_user_idx ON staff(tenant_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- Pay-history ledger. One row per recorded payment; soft-deleted like the rest
-- of the staff feature so the audit trail stays intact.
CREATE TABLE staff_pay (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,  -- denormalised for RLS
  staff_id           uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  paid_on            date NOT NULL,
  amount             numeric(14,2) NOT NULL CHECK (amount > 0),
  period_label       text NOT NULL DEFAULT '',   -- e.g. "May 2026" / "Week 21"
  note               text NOT NULL DEFAULT '',
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE INDEX staff_pay_staff_idx
  ON staff_pay(tenant_id, staff_id) WHERE deleted_at IS NULL;

ALTER TABLE staff_pay ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_pay FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_pay_isolation ON staff_pay
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- New write path — the app role needs an explicit grant (tests run as
-- superuser and would not catch a missing one; the live API would 500).
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_pay TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS staff_pay CASCADE;
DROP INDEX IF EXISTS staff_user_idx;
ALTER TABLE staff
  DROP COLUMN IF EXISTS ended_on,
  DROP COLUMN IF EXISTS salary_amount,
  DROP COLUMN IF EXISTS salary_cadence,
  DROP COLUMN IF EXISTS schedule,
  DROP COLUMN IF EXISTS user_id;
-- +goose StatementEnd
