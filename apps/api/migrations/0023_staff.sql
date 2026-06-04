-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- STAFF MANAGEMENT (0023)
--
-- A standalone employee registry, deliberately separate from tenant_members
-- (which models people with a LOGIN account and RBAC roles). Many staff —
-- e.g. a barista who never signs in — need a profile and document trail but
-- no account. So: create the person here first, then attach typed documents.
--
-- staff_documents hold sensitive personal IDs (citizenship, driver's licence,
-- …). Unlike logos/menu photos, these are NEVER public-by-URL: the row stores
-- only the private storage key, and bytes are served exclusively through an
-- authenticated, permission-checked proxy endpoint (staff:read) that audits
-- every view.
-- =========================================================================

CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  role_title  text NOT NULL DEFAULT '',          -- job title (free text), NOT an RBAC role
  phone       text NOT NULL DEFAULT '',
  email       citext,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  started_on  date,
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX staff_tenant_idx ON staff(tenant_id) WHERE deleted_at IS NULL;

CREATE TRIGGER staff_updated_at BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_isolation ON staff
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE staff_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,  -- denormalised for RLS
  staff_id            uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  doc_type            text NOT NULL,             -- preset key: citizenship | drivers_license | … | other
  label               text NOT NULL DEFAULT '',  -- custom label, primarily for doc_type='other'
  storage_key         text NOT NULL,             -- private object key — never a public URL
  file_name           text NOT NULL DEFAULT '',
  mime_type           text NOT NULL,
  size_bytes          bigint NOT NULL DEFAULT 0,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX staff_documents_staff_idx
  ON staff_documents(tenant_id, staff_id) WHERE deleted_at IS NULL;

ALTER TABLE staff_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_documents_isolation ON staff_documents
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON staff, staff_documents TO app;

-- Backfill the new staff:* grant onto existing manager roles. Owners hold *:*
-- so they already cover staff; tenants created after this migration seed
-- staff:* for managers from the manifest (rbac.SeedSystemRoles).
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'staff:*' FROM roles WHERE key = 'manager'
ON CONFLICT DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions WHERE permission = 'staff:*';
DROP TABLE IF EXISTS staff_documents CASCADE;
DROP TABLE IF EXISTS staff CASCADE;
-- +goose StatementEnd
