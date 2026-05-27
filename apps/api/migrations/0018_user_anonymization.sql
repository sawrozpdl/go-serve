-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- USERS: add deleted_at + anonymized_at for GDPR "right to be forgotten".
--
-- A soft-delete flow lets us preserve foreign-key integrity from historical
-- rows (audit_log.actor_id, orders.opened_by_user_id, shifts.opened_by_user_id, …)
-- while honouring the user's request to disappear from the live system.
--
--   deleted_at      — set when the user requests deletion; once set, they
--                     can no longer log in (sessions are revoked synchronously).
--   anonymized_at   — set when the email / name / avatar have been replaced
--                     by sentinel values. Always >= deleted_at.
--
-- The two columns are split so we can support a grace window in the future
-- (deleted_at = T, anonymized_at = T+30d) without changing the schema.
-- For this migration, the GDPR delete endpoint sets both at the same time.
-- =========================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

CREATE INDEX IF NOT EXISTS users_deleted_at_idx
  ON users (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS users_deleted_at_idx;
ALTER TABLE users
  DROP COLUMN IF EXISTS anonymized_at,
  DROP COLUMN IF EXISTS deleted_at;
-- +goose StatementEnd
