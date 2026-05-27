-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- Grant the runtime role (app / app_user, NOBYPASSRLS) access to the tables
-- added in 0020. Without this, INSERTs fail with "permission denied" under
-- the non-superuser connection — surfacing as 500s on the Google login
-- handoff (auth_handoff) and the WebSocket ticket endpoint (ws_tickets),
-- while OTP login keeps working (it only touches the already-granted
-- sessions/users tables).
--
-- Mirrors 0017_email_otp_grants, which back-filled the grant 0016 omitted.
-- These tables carry no tenant data and are looked up by single-use hashed
-- token, so — like sessions and email_otps — they need no RLS, just grants.
-- =========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_handoff, ws_tickets TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
REVOKE SELECT, INSERT, UPDATE, DELETE ON auth_handoff, ws_tickets FROM app;
-- +goose StatementEnd
