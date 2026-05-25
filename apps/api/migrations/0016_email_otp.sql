-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- EMAIL_OTPS
-- One-time codes for the email+OTP login path. Pre-auth — no tenant or user
-- context yet. Queried directly by the auth package via the admin pool
-- (no RLS, no app-role grants needed).
--
-- Codes are stored as sha256 hex; raw digits are never persisted. The same
-- email can have at most one un-consumed row at a time — resends supersede
-- prior rows by marking them consumed. The consumed_at flag also enforces
-- single-use after a successful verify and is set when attempts hit the cap.
-- =========================================================================

CREATE TABLE email_otps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  code_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  consumed_at   timestamptz,
  request_ip    text,
  request_ua    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Active (un-consumed) rows are queried by email on every send + verify.
CREATE INDEX email_otps_email_active_idx
  ON email_otps (email, created_at DESC)
  WHERE consumed_at IS NULL;

-- Per-IP rate checks scan recent rows by IP.
CREATE INDEX email_otps_ip_recent_idx
  ON email_otps (request_ip, created_at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS email_otps;
-- +goose StatementEnd
