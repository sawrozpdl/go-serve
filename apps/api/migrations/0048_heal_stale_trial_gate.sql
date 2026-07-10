-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0048: HEAL STALE TRIAL GATES ON NON-TRIAL PLANS
--
-- The billing model's invariant is that a tenant carries AT MOST ONE gate:
-- either a trial (trial_ends_at) OR a paid subscription (paid_through_at).
-- trial_ends_at is only meaningful on a plan with a trial window
-- (plans.trial_days > 0 — in practice just the 'trial' plan).
--
-- Provisioning and ChangePlan respected that, but RecordPayment and
-- SetSubscription (comp) did NOT clear trial_ends_at, so a tenant could sit on
-- a paid/enterprise plan with a stale, long-past trial_ends_at. Because the
-- trial gate auto-locks past its grace window and (pre-refactor) took priority
-- over paid_through_at, such a tenant was permanently write-locked as
-- "trial expired" — and neither recording a payment nor marking it comped
-- could clear it.
--
-- Retire every trial_ends_at that sits on a plan without a trial window. These
-- rows are, by definition, not trials. A NULL trial_ends_at means "no trial
-- gate", so ComputeState falls through to the paid / comped branches.
--
-- This is a data-only correction; the code paths that let this happen are fixed
-- alongside this migration (RecordPayment / SetSubscription now clear the gate,
-- and ComputeState lets a live paid_through_at win over a stale trial date).
-- No new GRANT: a plain UPDATE on an already-granted table.
-- =========================================================================

UPDATE tenants t
SET trial_ends_at = NULL
FROM plans p
WHERE t.plan_id = p.id
  AND t.trial_ends_at IS NOT NULL
  AND p.trial_days = 0;

-- Tenants with NO plan row at all are legacy/own workspaces (never on a trial);
-- clear any lingering trial gate on them too.
UPDATE tenants
SET trial_ends_at = NULL
WHERE plan_id IS NULL
  AND trial_ends_at IS NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Irreversible: the retired trial_ends_at values were stale by definition and
-- are not recoverable. Down is a no-op (re-applying Up is safe/idempotent).
SELECT 1;
-- +goose StatementEnd
