-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0098 — Producer and data-centre details for the IRD paperwork.
--
-- Every IRD form names the software producer (the company that lists Go Serve
-- with IRD, Annex 1) and, for cloud hosting, the data centre (Annex 7). They
-- are the same for every café, so they live once, here, edited from the super
-- console. Cafés' document generators read them (non-secret) through
-- ird_platform_profile().
--
-- producer:   company, company_ne, pan, address, address_ne, tax_office,
--             registered_on, director, director_title, email, phone, mobile,
--             website, enlisted_no, enlisted_on, software_name
-- datacenter: company, pan, address, phone, contact, location, server_ip,
--             server_type, hosting_model, tier, dr_site, database, ssl, domain
-- =========================================================================

CREATE TABLE IF NOT EXISTS platform_ird_profile (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  producer    jsonb NOT NULL DEFAULT '{}'::jsonb,
  datacenter  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO platform_ird_profile (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE platform_ird_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_ird_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_ird_profile_admin ON platform_ird_profile;
CREATE POLICY platform_ird_profile_admin ON platform_ird_profile
  USING (is_platform_admin(current_user_id()))
  WITH CHECK (is_platform_admin(current_user_id()));
GRANT SELECT, UPDATE ON platform_ird_profile TO app;

-- Read-only view of the same for any signed-in café (the documents need it).
CREATE OR REPLACE FUNCTION ird_platform_profile() RETURNS TABLE (producer jsonb, datacenter jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT producer, datacenter FROM platform_ird_profile WHERE id = 1
$fn$;
REVOKE ALL ON FUNCTION ird_platform_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ird_platform_profile() TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS ird_platform_profile();
DROP TABLE IF EXISTS platform_ird_profile;
-- +goose StatementEnd
