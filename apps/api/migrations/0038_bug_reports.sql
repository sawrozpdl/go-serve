-- +goose Up

-- =========================================================================
-- 0038 — Bug / issue reporting
--
-- An in-app feedback channel. Any signed-in member can file a report (bug,
-- idea, question or other) with optional screenshots; platform super-admins
-- triage them in the /super console.
--
-- The row carries DENORMALIZED snapshots of the tenant + reporter (slug,
-- cafe name, reporter name/email) — same approach as audit_log, which freezes
-- actor_name/actor_email. This means the super console reads bug_reports
-- directly with plain filtered SQL and never needs a cross-tenant join to
-- tenants/users (both of which are FORCE RLS scoped to current_tenant_id()).
--
-- RLS carries TWO permissive policies per table (Postgres ORs them):
--   * tenant isolation  — a member sees only their own tenant's rows.
--   * platform admin     — a super-admin (no tenant context on /super) sees
--                          everything. is_platform_admin() reads platform_admins
--                          which has no RLS, so the app role can evaluate it.
--
-- Screenshots may contain customer data, so attachments are stored PRIVATE
-- (storage PutOpts default) and only ever streamed through the authenticated
-- proxy endpoints — never a public URL.
-- =========================================================================

CREATE TABLE bug_reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- snapshots, frozen at submit time so the super console needs no joins.
  tenant_slug          text NOT NULL DEFAULT '',
  cafe_name            text NOT NULL DEFAULT '',
  reporter_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  reporter_name        text NOT NULL DEFAULT '',
  reporter_email       text NOT NULL DEFAULT '',
  kind                 text NOT NULL DEFAULT 'bug'
                         CHECK (kind IN ('bug','idea','question','other')),
  mood                 smallint CHECK (mood BETWEEN 1 AND 5),  -- emoji selector, nullable
  title                text NOT NULL DEFAULT '',
  description          text NOT NULL,
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','in_progress','resolved','wont_fix','closed')),
  priority             text NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
  -- auto-captured technical breadcrumbs.
  page_url             text NOT NULL DEFAULT '',
  app_version          text NOT NULL DEFAULT '',
  user_agent           text NOT NULL DEFAULT '',
  viewport             text NOT NULL DEFAULT '',
  meta                 jsonb NOT NULL DEFAULT '{}',
  -- resolution.
  resolution_note      text NOT NULL DEFAULT '',
  resolved_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE INDEX bug_reports_tenant_idx   ON bug_reports(tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX bug_reports_status_idx   ON bug_reports(status, created_at DESC)    WHERE deleted_at IS NULL;
CREATE INDEX bug_reports_reporter_idx ON bug_reports(reporter_user_id, created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bug_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY bug_reports_isolation ON bug_reports
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY bug_reports_platform_admin ON bug_reports
  USING (is_platform_admin(current_user_id()))
  WITH CHECK (is_platform_admin(current_user_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON bug_reports TO app;

CREATE TABLE bug_report_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_report_id   uuid NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,  -- for RLS
  storage_key     text NOT NULL,
  file_name       text NOT NULL DEFAULT '',
  mime_type       text NOT NULL DEFAULT '',
  size_bytes      bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bug_report_attachments_report_idx ON bug_report_attachments(bug_report_id, created_at);

ALTER TABLE bug_report_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bug_report_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY bug_report_attachments_isolation ON bug_report_attachments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY bug_report_attachments_platform_admin ON bug_report_attachments
  USING (is_platform_admin(current_user_id()))
  WITH CHECK (is_platform_admin(current_user_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON bug_report_attachments TO app;

-- +goose Down

DROP TABLE IF EXISTS bug_report_attachments CASCADE;
DROP TABLE IF EXISTS bug_reports CASCADE;
