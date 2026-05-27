-- +goose Up
-- +goose StatementBegin

-- The OTP handlers use the runtime app pool (APP_DATABASE_URL connects as
-- the non-superuser `app` role), not the admin pool. Migration 0016 created
-- the table but forgot to grant access, so /auth/request-otp died with
-- `permission denied for table email_otps` in prod.
--
-- No RLS on this table — pre-auth flow, no tenant context. Plain grants are
-- enough.

GRANT SELECT, INSERT, UPDATE, DELETE ON email_otps TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
REVOKE SELECT, INSERT, UPDATE, DELETE ON email_otps FROM app;
-- +goose StatementEnd
