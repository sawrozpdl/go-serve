-- +goose Up
-- +goose StatementBegin

-- Manager PIN — only required for owner/manager roles. Stored as bcrypt
-- hash (60 chars). NULL means "no PIN set" (which blocks this user from
-- being used as an approver until they set one).
ALTER TABLE tenant_members ADD COLUMN pin_hash text;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE tenant_members DROP COLUMN IF EXISTS pin_hash;
-- +goose StatementEnd
