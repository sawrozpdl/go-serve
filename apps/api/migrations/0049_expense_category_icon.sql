-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- EXPENSE CATEGORY ICONS
-- Mirrors 0013_icons.sql. Free-form icon name slug (e.g. "Receipt",
-- "Wallet"); empty string = no icon set. Valid names are enforced
-- client-side against the curated lucide-react registry; the DB is
-- intentionally permissive. Replaces the legacy `color` swatch in the UI
-- (the color column is retained for fallback tinting of pre-icon rows).
-- =========================================================================

ALTER TABLE expense_categories
  ADD COLUMN icon text NOT NULL DEFAULT '';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE expense_categories DROP COLUMN IF EXISTS icon;
-- +goose StatementEnd
