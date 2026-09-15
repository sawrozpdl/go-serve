-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0083 — Staff auto-deactivation from ended_on
--
-- staff.ended_on has existed since 0033 and nothing has ever read it. A cafe
-- sets a leaving date, the date passes, and the person stays on the active
-- roster until somebody remembers to toggle them — which is exactly the kind
-- of remembering software is for. They keep appearing in the staff picker, in
-- the timeline's coverage, and in the list a manager scans at shift start.
--
-- The request was also "or activate — smart kind": clear the end date, or push
-- it out, and the person comes back. That half is where the danger is. A
-- manager who deactivates somebody BY HAND — suspended, on leave, a dispute —
-- must not be silently reactivated by a job the next morning just because
-- their ended_on happens to be blank. That would be the system overruling a
-- human about a person, which is the one outcome worth engineering against.
--
-- ONE NULLABLE MARKER COLUMN IS THE WHOLE DESIGN
--
-- auto_deactivated_on is set only by the reconciler and cleared only by the
-- reconciler or by an explicit human status change. So:
--
--   marker NULL      → a human owns this status. Never auto-reversed.
--   marker NOT NULL  → the reconciler owns it, and may reverse itself.
--
-- The alternative — inferring "was this automatic?" from ended_on and status
-- together — cannot tell "manually deactivated, no end date" apart from
-- "auto-deactivated, end date since cleared". Those two must behave
-- differently, and they are indistinguishable without a marker. A boolean
-- would do equally well; a date costs the same and answers "when" for free.
--
-- ended_on IS THE LAST WORKING DAY, SO THE TEST IS STRICTLY `<`
--
-- Somebody whose last day is today is still working today. `<=` would log them
-- out mid-shift on their own leaving day.
--
-- AND THE COMPARISON IS IN THE TENANT'S TIMEZONE
--
-- Not the API container's (UTC) and not the database session's. Between 18:15
-- and 00:00 UTC, "today" in Asia/Kathmandu is already tomorrow — this repo has
-- a standing class of bug from exactly that gap. Both the handler and the job
-- pass a tenant-local YYYY-MM-DD and compare `ended_on < $1::date`: date to
-- date, with no timestamp and no zone anywhere inside the comparison.
--
-- NOT IN THIS CHANGE, deliberately: a started_on counterpart (a hire date that
-- has not arrived yet is not a reason to hide somebody from the roster), any
-- effect on staff_pay or staff_meals (an inactive person's history stays
-- exactly as it is), and a notice before the date lands.
-- =========================================================================

ALTER TABLE staff ADD COLUMN IF NOT EXISTS auto_deactivated_on date;

COMMENT ON COLUMN staff.auto_deactivated_on IS
  'Set when the reconciler deactivated this person because ended_on had passed; '
  'NULL when a human owns the current status. Only rows with this set are ever '
  'auto-reactivated. See 0083.';

CREATE INDEX IF NOT EXISTS staff_ended_on_idx ON staff(tenant_id, ended_on)
  WHERE deleted_at IS NULL AND ended_on IS NOT NULL;

-- A column and an index change no table-level privileges; staff already holds
-- SELECT/INSERT/UPDATE/DELETE for app from 0023. No new GRANT.

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS staff_ended_on_idx;
ALTER TABLE staff DROP COLUMN IF EXISTS auto_deactivated_on;
-- +goose StatementEnd
