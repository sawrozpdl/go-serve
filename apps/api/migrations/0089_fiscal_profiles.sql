-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0089 — Fiscal profiles: a café's tax registration and IRD e-billing mode
--
-- First migration of the IRD compliance epic (docs/ird/COMPLIANCE.md). It adds
-- the registration a café bills under and the one-way switch that turns on
-- IRD electronic invoicing. Nothing here issues documents yet; it only lets a
-- café declare who it is and refuses the settings combinations that a fiscal
-- café may not have.
--
-- REGISTRATION TYPE
--   'none' — not registered (or chooses not to bill electronically). Today's
--            behaviour; receipts print "Not a tax invoice".
--   'pan'  — income-tax (PAN) only: an "Invoice" with no VAT lines.
--   'vat'  — VAT registered: a "Tax Invoice" with 13% VAT.
--
-- FISCAL MODE IS ONE-WAY
-- fiscal_mode_enabled_at is set once, when the café has its IRD permit, and a
-- trigger refuses clearing or moving it. From that moment the identity the
-- invoices are numbered under (registration type, PAN, outlet code) is frozen
-- too: changing a PAN mid-year would put two taxpayers' bills in one series.
-- Legal name and address may still change (a café moves); every invoice
-- snapshots the seller block at issue, so history never shifts.
--
-- OUTLET CODE, AND WHY THE UNIQUE INDEX IS GLOBAL
-- A branch is a tenant (0088). Branches of one business share one PAN, and the
-- procedure (§6.2(ग)) requires each billing outlet's numbers to carry its own
-- code so (PAN, fiscal year, bill number) stays unique at CBMS. The unique
-- index on (pan, outlet_code) is enforced by Postgres regardless of RLS, so
-- two tenants can never claim the same outlet under one PAN — the constraint
-- holds across tenants without any SECURITY DEFINER lookup.
--
-- SETTINGS A FISCAL CAFÉ MAY NOT HAVE (trigger on tenants)
--   * service charge > 0 — struck down by the Supreme Court (2079.10.11);
--   * VAT café: vat_mode must be 'inclusive' (VAT Rule 14ख: hotel/restaurant
--     menu prices include VAT) and vat_pct must be 13 (VAT Act rate);
--   * PAN café: vat_mode must be 'none'.
-- The enable wizard checks the same things first and explains them; the
-- triggers are the backstop for every other write path.
--
-- CBMS CREDENTIALS
-- The café's IRD Taxpayer Portal user id and password, which CBMS takes in
-- every request body. The password is AES-256-GCM ciphertext produced by the
-- API (key FISCAL_ENCRYPTION_KEY, id in cbms_key_id for rotation); the
-- database never sees plaintext and the API never returns it.
-- =========================================================================

CREATE TABLE IF NOT EXISTS fiscal_profiles (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  registration_type      text NOT NULL DEFAULT 'none'
                         CHECK (registration_type IN ('none', 'pan', 'vat')),
  pan                    text,
  legal_name             text NOT NULL DEFAULT '',
  legal_name_ne          text NOT NULL DEFAULT '',
  address                text NOT NULL DEFAULT '',
  phone                  text NOT NULL DEFAULT '',
  email                  text NOT NULL DEFAULT '',
  -- Inland Revenue / taxpayer office the café is registered with.
  tax_office             text NOT NULL DEFAULT '',
  -- Annex-4 permit number, once granted.
  permit_no              text NOT NULL DEFAULT '',
  outlet_code            text NOT NULL DEFAULT '',
  fiscal_mode_enabled_at timestamptz,
  fiscal_mode_enabled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cbms_enabled           boolean NOT NULL DEFAULT false,
  cbms_username          text NOT NULL DEFAULT '',
  cbms_password_enc      bytea,
  cbms_key_id            text NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CHECK (pan IS NULL OR pan ~ '^[0-9]{9}$'),
  CHECK (registration_type = 'none' OR pan IS NOT NULL),
  CHECK (outlet_code ~ '^[A-Z0-9]{0,6}$'),
  -- Fiscal mode needs a registration to bill under.
  CHECK (fiscal_mode_enabled_at IS NULL OR registration_type <> 'none'),
  CHECK (NOT cbms_enabled OR (cbms_username <> '' AND cbms_password_enc IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_profiles_pan_outlet_uniq
  ON fiscal_profiles (pan, outlet_code) WHERE pan IS NOT NULL;

ALTER TABLE fiscal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_profiles_isolation ON fiscal_profiles;
CREATE POLICY fiscal_profiles_isolation ON fiscal_profiles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: a profile row outlives every change of mind, and once fiscal mode
-- is on it is part of the record IRD inspects.
GRANT SELECT, INSERT, UPDATE ON fiscal_profiles TO app;

-- -------------------------------------------------------------------------
-- One-way fiscal mode + frozen identity.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fiscal_profiles_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.fiscal_mode_enabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'fiscal profile of a café in IRD fiscal mode cannot be deleted / आईआरडी बीजक मोडमा रहेको प्रोफाइल मेटाउन मिल्दैन'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  NEW.updated_at := now();
  IF OLD.fiscal_mode_enabled_at IS NOT NULL THEN
    IF NEW.fiscal_mode_enabled_at IS DISTINCT FROM OLD.fiscal_mode_enabled_at
       OR NEW.fiscal_mode_enabled_by IS DISTINCT FROM OLD.fiscal_mode_enabled_by THEN
      RAISE EXCEPTION 'fiscal mode cannot be turned off or re-dated / बीजक मोड बन्द गर्न मिल्दैन'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.registration_type IS DISTINCT FROM OLD.registration_type
       OR NEW.pan IS DISTINCT FROM OLD.pan
       OR NEW.outlet_code IS DISTINCT FROM OLD.outlet_code THEN
      RAISE EXCEPTION 'registration type, PAN and outlet code are frozen once fiscal mode is on / बीजक मोडपछि दर्ता प्रकार, स्थायी लेखा नम्बर र आउटलेट कोड परिवर्तन गर्न मिल्दैन'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fiscal_profiles_guard ON fiscal_profiles;
CREATE TRIGGER fiscal_profiles_guard
  BEFORE UPDATE OR DELETE ON fiscal_profiles
  FOR EACH ROW EXECUTE FUNCTION fiscal_profiles_guard();

-- -------------------------------------------------------------------------
-- Tax settings a fiscal café may not hold. Checked on both sides: when the
-- tenant row changes, and when fiscal mode is switched on.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fiscal_tax_settings_violation(
  p_registration text, p_service_charge numeric, p_vat_mode text, p_vat_pct numeric
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_service_charge <> 0
      THEN 'service charge must be 0 for a café in IRD fiscal mode'
    WHEN p_registration = 'vat' AND p_vat_mode <> 'inclusive'
      THEN 'a VAT café in fiscal mode must use VAT-inclusive menu prices'
    WHEN p_registration = 'vat' AND p_vat_pct <> 13
      THEN 'a VAT café in fiscal mode must use the 13% VAT rate'
    WHEN p_registration = 'pan' AND p_vat_mode <> 'none'
      THEN 'a PAN-only café cannot charge VAT'
  END
$$;

CREATE OR REPLACE FUNCTION tenants_fiscal_tax_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_reg text;
  v_msg text;
BEGIN
  SELECT registration_type INTO v_reg
  FROM fiscal_profiles
  WHERE tenant_id = NEW.id AND fiscal_mode_enabled_at IS NOT NULL;
  IF v_reg IS NULL THEN
    RETURN NEW;
  END IF;
  v_msg := fiscal_tax_settings_violation(v_reg, NEW.service_charge_pct, NEW.vat_mode, NEW.vat_pct);
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_msg USING ERRCODE = 'check_violation', HINT = 'fiscal_tax_settings';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_fiscal_tax_guard ON tenants;
CREATE TRIGGER tenants_fiscal_tax_guard
  BEFORE UPDATE OF service_charge_pct, vat_mode, vat_pct ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_fiscal_tax_guard();

CREATE OR REPLACE FUNCTION fiscal_profiles_enable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  v_msg text;
BEGIN
  IF NEW.fiscal_mode_enabled_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.fiscal_mode_enabled_at IS NOT NULL THEN
    RETURN NEW; -- already on; identity guard above covers the rest
  END IF;
  SELECT service_charge_pct, vat_mode, vat_pct INTO t FROM tenants WHERE id = NEW.tenant_id;
  v_msg := fiscal_tax_settings_violation(NEW.registration_type, t.service_charge_pct, t.vat_mode, t.vat_pct);
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_msg USING ERRCODE = 'check_violation', HINT = 'fiscal_tax_settings';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fiscal_profiles_enable_guard ON fiscal_profiles;
CREATE TRIGGER fiscal_profiles_enable_guard
  BEFORE INSERT OR UPDATE ON fiscal_profiles
  FOR EACH ROW EXECUTE FUNCTION fiscal_profiles_enable_guard();

-- -------------------------------------------------------------------------
-- tenant_fiscal_mode(id): is this tenant in IRD fiscal mode? SECURITY DEFINER
-- because billing.LoadStateTx runs before/independent of the tenant GUC (it
-- reads only global tables) and a fiscal tenant must have its activity log
-- forced on (procedure §6.3(ख)) whatever its plan says. Returns one boolean
-- about one tenant; nothing else crosses the RLS boundary.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_fiscal_mode(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM fiscal_profiles
    WHERE tenant_id = p_tenant AND fiscal_mode_enabled_at IS NOT NULL
  )
$fn$;
REVOKE ALL ON FUNCTION tenant_fiscal_mode(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_fiscal_mode(uuid) TO app;

-- -------------------------------------------------------------------------
-- Permissions: back-fill onto existing tenants' system roles (the manifest
-- carries them for new tenants). Owner holds *:* already.
--   fiscal:read    — invoices, IRD registers, Standard View
--   fiscal:print   — print / reprint an issued invoice (every print is logged)
--   fiscal:correct — sales return and reverse entry
--   fiscal:manage  — tax profile, CBMS credentials, enable fiscal mode
-- Whoever can settle can print the bill they just issued; corrections and the
-- registers are a manager's job; the profile is the owner's alone.
-- -------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('manager', 'fiscal:read'),
  ('manager', 'fiscal:print'),
  ('manager', 'fiscal:correct'),
  ('waiter',  'fiscal:print'),
  ('kitchen', 'fiscal:print')
) AS p(role_key, permission) ON r.key = p.role_key
ON CONFLICT DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions rp
USING roles r, (VALUES
  ('manager', 'fiscal:read'),
  ('manager', 'fiscal:print'),
  ('manager', 'fiscal:correct'),
  ('waiter',  'fiscal:print'),
  ('kitchen', 'fiscal:print')
) AS p(role_key, permission)
WHERE rp.role_id = r.id AND r.key = p.role_key AND rp.permission = p.permission;
DROP FUNCTION IF EXISTS tenant_fiscal_mode(uuid);
DROP TRIGGER IF EXISTS tenants_fiscal_tax_guard ON tenants;
DROP FUNCTION IF EXISTS tenants_fiscal_tax_guard();
DROP TABLE IF EXISTS fiscal_profiles;
DROP FUNCTION IF EXISTS fiscal_profiles_enable_guard();
DROP FUNCTION IF EXISTS fiscal_profiles_guard();
DROP FUNCTION IF EXISTS fiscal_tax_settings_violation(text, numeric, text, numeric);
-- +goose StatementEnd
