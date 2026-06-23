-- +goose Up
-- +goose StatementBegin
-- 0042: audit logs become a premium plan feature ("audit_logs"). Seed it onto
-- the premium tiers for existing tenants; new tenants pick it up from the plan
-- they're provisioned on. Standard stays base (no audit logs). Trial is listed
-- only for parity — the billing code already short-circuits all features during
-- the trial window. Additive (ON CONFLICT DO NOTHING) so manual grants survive.
INSERT INTO plan_features (plan_id, feature_key)
  SELECT id, 'audit_logs' FROM plans WHERE key IN ('trial', 'growth', 'enterprise')
ON CONFLICT DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM plan_features WHERE feature_key = 'audit_logs';
-- +goose StatementEnd
