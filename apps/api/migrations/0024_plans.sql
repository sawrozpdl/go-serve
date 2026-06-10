-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- PLANS — the subscription-tier catalog.
--
-- Global, NOT RLS-scoped (like tenants/users): the catalog is shared across
-- all tenants, read by the per-request billing loader and edited by the
-- super-admin console.
--
-- `member_limit` NULL  → unlimited seats.
-- `is_enterprise` true  → contact-only tier (no self-serve hint).
-- Feature KEYS are code-defined (internal/billing.Registry); which plan
-- includes which key is DATA in plan_features below.
-- =========================================================================

CREATE TABLE plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE CHECK (key = lower(key) AND key ~ '^[a-z0-9][a-z0-9_-]{1,38}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  member_limit  int CHECK (member_limit IS NULL OR member_limit > 0),  -- NULL = unlimited
  price_copy    text NOT NULL DEFAULT '',          -- display string e.g. "Rs 2,000/mo"
  is_enterprise boolean NOT NULL DEFAULT false,     -- contact-only / no self-serve
  sort_order    int NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER plans_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- plan→feature mapping. No FK to a features table on purpose — the Go
-- registry is the source of truth for valid keys; the super-admin handler
-- validates submitted keys against it before insert.
CREATE TABLE plan_features (
  plan_id      uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  PRIMARY KEY (plan_id, feature_key)
);

-- =========================================================================
-- TENANT plan columns.
--
--   plan_id              → catalog entry this tenant is on.
--   trial_ends_at        → NULL means "no trial gate". Set to now()+90d only
--                          for genuinely new provisioned tenants.
--   member_limit_override→ per-tenant seat override (Enterprise deals).
--   feature_overrides    → {"grant":[...],"revoke":[...]} applied over plan
--                          features (ignored during trial = all features).
--   billing_state        → 'ok' | 'write_locked'. The MANUAL super-admin lock.
--                          The TRIAL-expiry lock is COMPUTED from trial_ends_at
--                          + grace, never stored, so extending the trial
--                          auto-clears it. Effective lock = manual OR computed.
--                          This is SEPARATE from tenants.status so a
--                          write-locked tenant still resolves via LookupBySlug
--                          (reads + login + export keep working).
-- =========================================================================

ALTER TABLE tenants
  ADD COLUMN plan_id               uuid REFERENCES plans(id),
  ADD COLUMN trial_ends_at         timestamptz,
  ADD COLUMN member_limit_override int CHECK (member_limit_override IS NULL OR member_limit_override > 0),
  ADD COLUMN feature_overrides     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN billing_state         text NOT NULL DEFAULT 'ok'
                                    CHECK (billing_state IN ('ok','write_locked')),
  ADD COLUMN billing_note          text NOT NULL DEFAULT '';

GRANT SELECT, INSERT, UPDATE, DELETE ON plans TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_features TO app;

-- =========================================================================
-- Seed the default catalog.
-- =========================================================================

INSERT INTO plans (key, name, member_limit, price_copy, is_enterprise, sort_order, active) VALUES
  ('trial',      'Free Trial', NULL, '3 months free',  false, 0,  true),
  ('standard',   'Standard',   5,    'Contact us',     false, 10, true),
  ('growth',     'Growth',     10,   'Contact us',     false, 20, true),
  ('enterprise', 'Enterprise', NULL, 'Contact sales',  true,  30, true);

-- Feature mappings. Trial gets ALL features (also short-circuited in code);
-- standard = base only; growth/enterprise add advanced analytics. Email shift
-- summaries available on every paid tier + trial.
INSERT INTO plan_features (plan_id, feature_key)
  SELECT id, 'advanced_analytics'    FROM plans WHERE key IN ('trial','growth','enterprise');
INSERT INTO plan_features (plan_id, feature_key)
  SELECT id, 'email_shift_summaries' FROM plans WHERE key IN ('trial','standard','growth','enterprise');

-- =========================================================================
-- Backfill existing tenants. The only existing tenants are our own
-- (Sahan Cafe + resell), so put them on 'enterprise' with NO trial gate
-- (trial_ends_at = NULL) — they must never be trial-locked. Only brand-new
-- provisioned tenants get the 90-day trial window (set in provisioning code).
-- =========================================================================

UPDATE tenants SET
  plan_id = (SELECT id FROM plans WHERE key = 'enterprise'),
  trial_ends_at = NULL
WHERE plan_id IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE tenants
  DROP COLUMN IF EXISTS plan_id,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS member_limit_override,
  DROP COLUMN IF EXISTS feature_overrides,
  DROP COLUMN IF EXISTS billing_state,
  DROP COLUMN IF EXISTS billing_note;
DROP TABLE IF EXISTS plan_features;
DROP TABLE IF EXISTS plans CASCADE;
-- +goose StatementEnd
