-- Free-text label for a tab with no real table (walk-in / "Unknown +").
-- Servers quick-open an unknown tab and name it later from the Tab page so it's
-- recognisable on the floor, kitchen docket, and history. Blank = the old
-- "Walk-in" / "Take-away" fallback.
--
-- No new GRANT: 0003 already grants UPDATE ON orders TO app, and the
-- orders_updated_at BEFORE-UPDATE trigger keeps updated_at fresh. RLS
-- orders_isolation already tenant-scopes the row.

-- +goose Up
ALTER TABLE orders ADD COLUMN table_label text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE orders DROP COLUMN table_label;
