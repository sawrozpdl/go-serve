-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- TENANT_REQUESTS — public "request access" submissions.
--
-- Filled by the anonymous POST /public/request-access endpoint (someone who
-- found us online and wants a workspace). NOT RLS-scoped: no tenant exists
-- yet and the writer has no auth context. The super-admin reviews the queue
-- and either approves (provisions a tenant + owner invite) or rejects.
-- =========================================================================

CREATE TABLE tenant_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  cafe_name     text NOT NULL CHECK (length(cafe_name) BETWEEN 1 AND 120),
  email         citext NOT NULL,
  phone         text NOT NULL DEFAULT '',
  desired_plan  text NOT NULL DEFAULT '',          -- plan key hint (not enforced)
  message       text NOT NULL DEFAULT '' CHECK (length(message) <= 2000),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  -- provisioning linkage once approved
  provisioned_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_note   text NOT NULL DEFAULT '',
  source_ip     inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_requests_state_idx ON tenant_requests(state, created_at DESC);

-- Anti-abuse: at most one OPEN (pending) request per email at a time.
CREATE UNIQUE INDEX tenant_requests_one_pending_per_email
  ON tenant_requests (email) WHERE state = 'pending';

GRANT SELECT, INSERT, UPDATE ON tenant_requests TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS tenant_requests CASCADE;
-- +goose StatementEnd
