-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- TENANT PREFERENCES
-- Operational behavior flags. Branding stays cosmetic; this column holds
-- workflow toggles (auto-serve, auto-clean tables, combined settle modal).
-- Stored as jsonb so adding a new flag doesn't require another migration.
-- =========================================================================

ALTER TABLE tenants
  ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

-- =========================================================================
-- MENU ITEM PRESET NOTES
-- Pre-canned note presets a waiter can attach when adding to a tab
-- (e.g. "low sugar", "no ice"). Free-form notes still work — these are
-- shortcuts, not a fixed enum.
-- =========================================================================

ALTER TABLE menu_items
  ADD COLUMN preset_notes text[] NOT NULL DEFAULT '{}'::text[];

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_items DROP COLUMN IF EXISTS preset_notes;
ALTER TABLE tenants    DROP COLUMN IF EXISTS preferences;
-- +goose StatementEnd
