-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- AUDIT_LOG  (append-only activity log)
--
-- Records every mutating action with the actor, a human-readable summary,
-- and a timestamp. Owners/managers see this on the Activity page so they
-- can answer "who deleted that expense?" or "when did the bank balance
-- shift?" without combing through logs.
--
-- Actor identity is snapshotted (actor_name, actor_email, role_snap) so
-- entries survive if the member is later removed or renamed. The FK to
-- users is ON DELETE SET NULL for the same reason.
-- =========================================================================

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name  text NOT NULL,
  actor_email text NOT NULL,
  role_snap   text[] NOT NULL DEFAULT '{}',
  action      text NOT NULL,           -- create|update|delete|open|close|void|settle|login|...
  entity      text NOT NULL,           -- expense|order|member|tenant|...
  entity_id   uuid,                    -- nullable for non-row events (login)
  summary     text NOT NULL,           -- 'deleted expense "Coffee Beans" (₹2,400)'
  ip          inet,
  request_id  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_time_idx  ON audit_log(tenant_id, created_at DESC);
CREATE INDEX audit_log_tenant_actor_idx ON audit_log(tenant_id, actor_id, created_at DESC);
CREATE INDEX audit_log_tenant_ent_idx   ON audit_log(tenant_id, entity, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_isolation ON audit_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON audit_log TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS audit_log CASCADE;
-- +goose StatementEnd
