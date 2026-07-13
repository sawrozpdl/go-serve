-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0050: house_tabs.contact_phone
--
-- Credit accounts (formerly "house tabs" in the UI) now capture an optional
-- contact phone number for the person the ledger belongs to. Optional at the
-- DB level (defaults to '' so the ALTER is safe on existing rows); the handler
-- does not require it.
--
-- Adding a column needs no new GRANT: app already holds the table privileges
-- and a column add doesn't change table-level grants (same as 0046 / 0045).
-- =========================================================================

ALTER TABLE house_tabs ADD COLUMN IF NOT EXISTS contact_phone text NOT NULL DEFAULT '';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE house_tabs DROP COLUMN IF EXISTS contact_phone;
-- +goose StatementEnd
