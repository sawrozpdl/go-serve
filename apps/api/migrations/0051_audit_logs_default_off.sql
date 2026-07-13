-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0051: audit_logs is OFF by default for everyone.
--
-- Audit logging becomes an opt-in capability that super admins enable per
-- tenant (via the Features tab → feature_overrides.grant). No plan grants it
-- anymore, and the trial "all features" blanket grant excludes it in code
-- (billing.FeatureDef.DefaultOff).
--
-- To avoid disrupting tenants that have audit logs on TODAY, we first migrate
-- their current entitlement into an explicit grant override, THEN strip the
-- key from plan_features. New tenants (created after this migration) have no
-- override and no plan grant, so they start with audit logs off.
-- =========================================================================

-- 1. Preserve currently-on tenants: any tenant whose plan currently includes
--    audit_logs and that isn't already revoking it gets an explicit grant
--    override so the entitlement survives the plan_features prune below.
UPDATE tenants t
SET feature_overrides = jsonb_set(
      COALESCE(t.feature_overrides, '{}'::jsonb),
      '{grant}',
      (
        SELECT to_jsonb(ARRAY(
          SELECT DISTINCT x
          FROM unnest(
            COALESCE(
              ARRAY(SELECT jsonb_array_elements_text(t.feature_overrides->'grant')),
              ARRAY[]::text[]
            ) || ARRAY['audit_logs']
          ) AS x
        ))
      ),
      true
    )
WHERE EXISTS (
        SELECT 1 FROM plan_features pf
        WHERE pf.plan_id = t.plan_id AND pf.feature_key = 'audit_logs'
      )
  AND NOT (
        COALESCE(t.feature_overrides->'revoke', '[]'::jsonb) ? 'audit_logs'
      );

-- 2. No plan grants audit_logs anymore.
DELETE FROM plan_features WHERE feature_key = 'audit_logs';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Restore the pre-0051 seeding (audit_logs on trial/growth/enterprise, per
-- 0042). The grant overrides added above are left in place — harmless, and we
-- can't reliably tell which were pre-existing.
INSERT INTO plan_features (plan_id, feature_key)
  SELECT p.id, 'audit_logs'
  FROM plans p
  WHERE p.key IN ('trial', 'growth', 'enterprise')
ON CONFLICT DO NOTHING;
-- +goose StatementEnd
