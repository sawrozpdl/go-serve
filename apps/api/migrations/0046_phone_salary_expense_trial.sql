-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0046: CONTACT PHONE + SALARY→EXPENSE LINK + 1-MONTH TRIAL DEFAULT
--
-- Three unrelated small schema/data changes bundled together:
--
--  1. tenants.contact_phone — a required contact number is now captured for
--     every workspace (both the public request-access lead and the super-admin
--     direct add). Column defaults to '' so the ALTER is safe on existing rows;
--     the NOT-EMPTY requirement is enforced in the handlers, not the DB.
--
--  2. staff_pay.expense_id — recording a salary payment now also writes an
--     `expenses` row (category "Salaries") so payroll shows up in spending and
--     moves the cafe balance. This nullable FK links the pay row to its expense
--     so DeleteStaffPay can cascade the reversal. NULL for legacy pay rows.
--
--  3. Trial default 90 → 30 days. 0039 seeded the 'trial' plan at 90 days and
--     0024 seeded the "3 months free" copy; both already ran on deployed DBs,
--     so we correct them here. Provisioning reads plans.trial_days at runtime,
--     so this is the single source of truth going forward.
--
-- Adding columns needs no new GRANT: app already holds the table privileges and
-- a column add doesn't change table-level grants (same as 0040 / 0045).
-- =========================================================================

ALTER TABLE tenants   ADD COLUMN IF NOT EXISTS contact_phone text NOT NULL DEFAULT '';
ALTER TABLE staff_pay ADD COLUMN IF NOT EXISTS expense_id uuid REFERENCES expenses(id);

UPDATE plans SET trial_days = 30       WHERE key = 'trial';
UPDATE plans SET price_copy = '1 month free' WHERE key = 'trial';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE plans SET trial_days = 90       WHERE key = 'trial';
UPDATE plans SET price_copy = '3 months free' WHERE key = 'trial';
ALTER TABLE staff_pay DROP COLUMN IF EXISTS expense_id;
ALTER TABLE tenants   DROP COLUMN IF EXISTS contact_phone;
-- +goose StatementEnd
