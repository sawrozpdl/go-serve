-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0077 — A length floor and ceiling for menu names
--
-- `menu_items.name` and `menu_categories.name` have been unbounded `text` with
-- no CHECK since 0002. That was fine while every writer agreed on what a name
-- was — but they never did:
--
--   * the web form sent it completely untrimmed,
--   * the mobile sheet trimmed it,
--   * bulk import trimmed it and deduped case-insensitively,
--   * and UpdateMenuItem validated nothing at all, so `PATCH {"name": ""}`
--     could blank a name CreateMenuItem would have refused.
--
-- The application-level fix is normalizeName/requireName (name.go, mirrored in
-- packages/validation/src/name.ts), now applied on all four paths. This
-- migration is the backstop underneath it: a name that reaches the column by
-- any other route — a hand-written UPDATE, a future handler, a restored dump —
-- still cannot be blank or long enough to wreck a receipt line.
--
-- 80 CHARACTERS, in char_length (code points) not octet_length, so a Devanagari
-- name gets the same allowance an ASCII one does. The number comes from the
-- printer: an 80mm thermal roll is 48 columns and a 58mm roll is 32, so 80 is
-- already generous for something that has to share a line with a price.
--
-- WHY NORMALISE FIRST
--
-- The dev database had no violations, but this has to be safe on a café's real
-- data. A bare ADD CONSTRAINT would abort the whole migration on one bad row
-- and leave the operator with an error and no path forward, so offenders are
-- repaired in the same statement block instead. Trim before truncating: a name
-- that is only long because of trailing spaces keeps all of its actual text.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
--
-- Every sibling table (menu_categories, service_tables, menu_modifier_groups,
-- inventory_items, outlets, house_tabs, expense_categories) carries a
-- unique(tenant_id, lower(name)) index; menu_items is the lone exception. It
-- stays the exception. A café can legitimately sell "Tea" in both Hot Drinks
-- and Cold Drinks, and adding the index would abort this migration for anyone
-- who already does. Left as a deliberate gap, not an oversight.
-- =========================================================================

UPDATE menu_items
SET name = left(btrim(name), 80)
WHERE name <> left(btrim(name), 80);

UPDATE menu_categories
SET name = left(btrim(name), 80)
WHERE name <> left(btrim(name), 80);

-- A row that was whitespace-only is now empty and would fail the CHECK below.
-- It cannot be dropped (order_items reference menu_items with RESTRICT), so
-- give it a name a human can search for and rename.
UPDATE menu_items    SET name = 'Unnamed item'     WHERE btrim(name) = '';
UPDATE menu_categories SET name = 'Unnamed category' WHERE btrim(name) = '';

ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_name_len
    CHECK (char_length(name) BETWEEN 1 AND 80);

ALTER TABLE menu_categories
  ADD CONSTRAINT menu_categories_name_len
    CHECK (char_length(name) BETWEEN 1 AND 80);

COMMENT ON CONSTRAINT menu_items_name_len ON menu_items IS
  'Backstop under normalizeName (apps/api/internal/api/name.go). 80 code '
  'points, sized for a 32-column 58mm receipt line shared with a price.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_categories DROP CONSTRAINT IF EXISTS menu_categories_name_len;
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_name_len;
-- +goose StatementEnd
