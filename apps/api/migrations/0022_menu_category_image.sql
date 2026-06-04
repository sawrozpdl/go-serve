-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- MENU CATEGORY IMAGES
-- A single optional banner image per category, surfaced on the public
-- customer menu (and editable in admin). menu_items already carries
-- image_url since 0002; this brings categories to parity so a cafe can give
-- each section a hero photo. NULL/'' = no image (the page falls back to the
-- category icon + color). Stored as the public object URL returned by the
-- storage backend, exactly like menu_items.image_url and tenants.branding.logoUrl.
-- =========================================================================

ALTER TABLE menu_categories
  ADD COLUMN image_url text;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_categories DROP COLUMN IF EXISTS image_url;
-- +goose StatementEnd
