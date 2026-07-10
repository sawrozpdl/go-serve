-- +goose Up
-- +goose StatementBegin
-- 0047: broaden the gated-feature catalog. The billing.Registry grows from 3
-- keys to 13 so capabilities can be tiered across plans later. For NOW every
-- new key (and the pre-existing advanced_analytics / email_shift_summaries) is
-- granted to EVERY plan so nothing changes for users yet — this migration only
-- builds the entitlement rows the tiering will later prune. The single
-- exception is 'audit_logs', which stays restricted (seeded in 0042 onto
-- trial/growth/enterprise only) — hence it is deliberately absent below.
--
-- Additive + idempotent (ON CONFLICT DO NOTHING): existing rows and any manual
-- per-plan grants survive. Trial is included only for parity; the billing code
-- already short-circuits ALL features during the trial window.
INSERT INTO plan_features (plan_id, feature_key)
  SELECT p.id, f.feature_key
  FROM plans p
  CROSS JOIN (VALUES
    ('advanced_analytics'),
    ('profitability'),
    ('owner_finance'),
    ('house_tabs'),
    ('staff_hr'),
    ('staff_scheduling'),
    ('custom_roles'),
    ('email_shift_summaries'),
    ('multi_outlet'),
    ('inventory'),
    ('menu_import'),
    ('thermal_printing')
  ) AS f(feature_key)
  WHERE p.key IN ('trial', 'standard', 'growth', 'enterprise')
ON CONFLICT DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Remove only the keys this migration introduced. advanced_analytics and
-- email_shift_summaries predate it (seeded in 0024) so are left intact for the
-- tiers that always had them; the broad grant to 'standard' is dropped.
DELETE FROM plan_features
  WHERE feature_key IN (
    'profitability', 'owner_finance', 'house_tabs', 'staff_hr',
    'staff_scheduling', 'custom_roles', 'multi_outlet', 'inventory',
    'menu_import', 'thermal_printing'
  );
DELETE FROM plan_features pf
  USING plans p
  WHERE pf.plan_id = p.id AND p.key = 'standard'
    AND pf.feature_key IN ('advanced_analytics');
-- +goose StatementEnd
