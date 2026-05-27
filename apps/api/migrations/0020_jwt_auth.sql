-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- JWT auth: move off cross-site session cookies (blocked by iOS WebKit ITP)
-- onto stateless access JWTs + opaque rotating refresh tokens.
--
--   * users.token_version  — bumped on logout-all / GDPR delete; embedded as
--     the `tv` claim in every access token so a bump invalidates all
--     outstanding access tokens (enforced per-request via a short-lived
--     in-memory cache; see auth.GetTokenVersion).
--   * sessions.replaced_by / replaced_at — refresh-rotation lineage. A
--     refresh presented after rotation but still inside a short grace window
--     replays the successor's tokens (multi-tab / network-retry safe);
--     outside the window it is treated as token reuse and revokes the chain.
--   * auth_handoff — single-use, short-lived codes for the Google OAuth
--     redirect → SPA token handoff (the callback can't return JSON, and we
--     keep tokens out of URL history).
--   * ws_tickets — single-use, short-lived tickets so the browser WebSocket
--     (which can't send an Authorization header) authenticates without
--     leaking a bearer token in the URL / proxy logs.
--
-- sessions.tenant_id is now vestigial (per-request tenant resolution is
-- header-based via X-Tenant-ID + RequireMember). Left in place — dropping it
-- is needless churn.
-- =========================================================================

ALTER TABLE users
  ADD COLUMN token_version integer NOT NULL DEFAULT 0;

ALTER TABLE sessions
  ADD COLUMN replaced_by uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN replaced_at timestamptz;

CREATE TABLE auth_handoff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ip  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX auth_handoff_expires_idx ON auth_handoff(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE ws_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_hash text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX ws_tickets_expires_idx ON ws_tickets(expires_at) WHERE consumed_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS ws_tickets;
DROP TABLE IF EXISTS auth_handoff;
ALTER TABLE sessions DROP COLUMN IF EXISTS replaced_at, DROP COLUMN IF EXISTS replaced_by;
ALTER TABLE users DROP COLUMN IF EXISTS token_version;
-- +goose StatementEnd
