-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0057 — Who owns the relationship with each cafe.
--
-- Until now the only record of who brought a cafe onto the platform was a
-- platform_audit row with action='tenant.create', and there was no notion at
-- all of an ongoing relationship manager. That fails in two ways: the audit
-- trail answers "which admin clicked the button", not "whose customer is
-- this", and the people who actually do the onboarding are often market
-- agents who have never logged in and have no users row to point at.
--
-- So: a small registry of PEOPLE that is deliberately NOT an auth surface.
-- A platform_people row is a name and a phone number. It may optionally link
-- to a users row (when that person is also a console login), but the link is
-- nullable and nothing about permissions reads this table. Adding an agent
-- must never mean creating an account for them.
--
-- Two roles per tenant, stored separately because they diverge in practice:
--   onboarded_by_person_id  — who signed them up. Historical; set once.
--   relationship_manager_id — who looks after them NOW. Reassignable.
-- The handler defaults the second to the first at provision time. That is a
-- HANDLER default rather than a DB trigger or a COALESCE-on-read precisely so
-- reassigning an RM is a plain UPDATE that sticks, instead of something that
-- silently reverts to the onboarder.
--
-- Commission is explicitly NOT modelled here. But a future
-- platform_commissions(person_id, tenant_id, payment_id, …) joins cleanly
-- against this table, tenants.onboarded_by_person_id, and (from 0060)
-- tenant_payments.collected_by_person_id — so it stays a pure addition.
--
-- All three tables are PLATFORM-owned: no RLS, following the
-- tenant_payments / platform_audit posture. Authority is
-- auth.RequirePlatformAdmin in Go, and nothing under /v1 (the tenant-facing
-- API) reads them. Cafe owners must not see who manages their account.
-- =========================================================================

CREATE TABLE platform_people (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- admin   = one of us, with console access
  -- agent   = field/market person who signs cafes up
  -- partner = reseller or referral partner
  kind       text NOT NULL DEFAULT 'agent' CHECK (kind IN ('admin', 'agent', 'partner')),
  -- Nullable on purpose: a market agent may genuinely have no email.
  email      citext,
  phone      text NOT NULL DEFAULT '',
  -- Set when this person is also a console login. NOT a permission grant —
  -- platform_admins remains the only thing that confers console access.
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  active     boolean NOT NULL DEFAULT true,
  notes      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Partial uniques: many agents share the "no email" state, so NULLs must not
-- collide with each other.
CREATE UNIQUE INDEX platform_people_email_uniq ON platform_people (email)   WHERE email   IS NOT NULL;
CREATE UNIQUE INDEX platform_people_user_uniq  ON platform_people (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX platform_people_active_idx ON platform_people (active, name);

CREATE TRIGGER platform_people_updated_at
  BEFORE UPDATE ON platform_people
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Relationship + provenance on the tenant itself. ON DELETE SET NULL, not
-- RESTRICT: removing a person from the registry must not be blocked by, or
-- silently erase, the cafes they touched — the attribution simply goes blank
-- and can be re-pointed.
ALTER TABLE tenants
  ADD COLUMN onboarded_by_person_id  uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  ADD COLUMN relationship_manager_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  ADD COLUMN onboarded_on            date,
  ADD COLUMN acquisition_source      text NOT NULL DEFAULT 'direct'
             CHECK (acquisition_source IN ('direct', 'request_access', 'referral', 'walk_in', 'other')),
  -- Back-pointer to the lead this tenant came from. tenant_requests already
  -- points forward via provisioned_tenant_id; the link was one-way, so the
  -- console could not get from a cafe back to what the owner originally wrote.
  ADD COLUMN source_request_id       uuid REFERENCES tenant_requests(id) ON DELETE SET NULL,
  -- The human's name. tenants has always had contact_phone but never a name:
  -- owner_email in the summaries view is DERIVED from an accepted invite, so a
  -- freshly provisioned cafe (zero members, one pending invite) shows nobody.
  ADD COLUMN owner_name              text NOT NULL DEFAULT '';

CREATE INDEX tenants_rm_idx         ON tenants (relationship_manager_id) WHERE deleted_at IS NULL;
CREATE INDEX tenants_onboarder_idx  ON tenants (onboarded_by_person_id)  WHERE deleted_at IS NULL;

-- Free-text CRM timeline. Platform-owned: these are OUR notes about a cafe
-- ("owner wants a second outlet in Q4", "phone was disconnected"), never
-- shown to the cafe. Deliberately excluded from the partial purge scopes in
-- 0036 — wiping a cafe's transactions must not destroy our account history
-- with them. A full tenant delete still clears them via the CASCADE below.
CREATE TABLE tenant_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body           text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  pinned         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_notes_tenant_idx ON tenant_notes (tenant_id, pinned DESC, created_at DESC);

-- No DELETE on people: deactivate instead, so historical attribution survives.
GRANT SELECT, INSERT, UPDATE         ON platform_people TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_notes    TO app;

-- --- Backfill ------------------------------------------------------------

-- 1. Every existing platform admin becomes an 'admin' person, linked to their
--    user. COALESCE on name because users.name can be empty for OTP signups.
INSERT INTO platform_people (name, kind, email, user_id)
SELECT
  COALESCE(NULLIF(btrim(u.name), ''), split_part(u.email::text, '@', 1)),
  'admin',
  u.email,
  u.id
FROM platform_admins pa
JOIN users u ON u.id = pa.user_id
ON CONFLICT DO NOTHING;

-- 2. Attribute each tenant to whoever provisioned it, per platform_audit.
--    DISTINCT ON picks the EARLIEST create row per tenant — a tenant can only
--    be created once, but a re-provision or a replayed audit row would
--    otherwise make this ambiguous.
WITH creator AS (
  SELECT DISTINCT ON (pa.target_tenant_id)
         pa.target_tenant_id AS tenant_id,
         pp.id               AS person_id
  FROM platform_audit pa
  JOIN platform_people pp ON pp.user_id = pa.actor_user_id
  WHERE pa.action = 'tenant.create' AND pa.target_tenant_id IS NOT NULL
  ORDER BY pa.target_tenant_id, pa.created_at
)
UPDATE tenants t
SET onboarded_by_person_id  = c.person_id,
    relationship_manager_id = c.person_id   -- RM defaults to the onboarder
FROM creator c
WHERE t.id = c.tenant_id;

-- 3. Onboarding date is the tenant's own creation date. Set for every tenant,
--    including ones with no identifiable onboarder.
UPDATE tenants SET onboarded_on = created_at::date WHERE onboarded_on IS NULL;

-- 4. Tenants that came from the public request-access form: back-pointer,
--    source, and the owner's name (which the form captured and nothing ever
--    copied onto the tenant).
UPDATE tenants t
SET source_request_id  = tr.id,
    acquisition_source = 'request_access',
    owner_name         = COALESCE(NULLIF(btrim(tr.name), ''), t.owner_name)
FROM tenant_requests tr
WHERE tr.provisioned_tenant_id = t.id;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE IF EXISTS tenant_notes;

DROP INDEX IF EXISTS tenants_onboarder_idx;
DROP INDEX IF EXISTS tenants_rm_idx;
ALTER TABLE tenants
  DROP COLUMN IF EXISTS owner_name,
  DROP COLUMN IF EXISTS source_request_id,
  DROP COLUMN IF EXISTS acquisition_source,
  DROP COLUMN IF EXISTS onboarded_on,
  DROP COLUMN IF EXISTS relationship_manager_id,
  DROP COLUMN IF EXISTS onboarded_by_person_id;

DROP TABLE IF EXISTS platform_people;

-- +goose StatementEnd
