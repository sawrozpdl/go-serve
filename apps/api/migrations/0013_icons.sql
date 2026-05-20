-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- ICONS
-- Free-form icon name slugs (e.g. "Coffee", "Pizza", "UtensilsCrossed").
-- Empty string = no icon set; UI falls back to a default glyph + the
-- existing category color. The set of valid names is enforced client-side
-- against the curated lucide-react registry; the DB is intentionally
-- permissive so renaming or extending the registry doesn't require a
-- migration.
-- =========================================================================

ALTER TABLE menu_categories
  ADD COLUMN icon text NOT NULL DEFAULT '';

ALTER TABLE menu_items
  ADD COLUMN icon text NOT NULL DEFAULT '';

ALTER TABLE service_tables
  ADD COLUMN icon text NOT NULL DEFAULT '';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE service_tables    DROP COLUMN IF EXISTS icon;
ALTER TABLE menu_items        DROP COLUMN IF EXISTS icon;
ALTER TABLE menu_categories   DROP COLUMN IF EXISTS icon;
-- +goose StatementEnd
