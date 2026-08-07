-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0061 — The pipeline BEFORE a cafe exists.
--
-- 0057 gave us a record of who owns the relationship with a cafe, but only
-- from the moment that cafe is provisioned. Everything before that — an agent
-- walking a market, twenty conversations, four of which are going somewhere —
-- lived nowhere. The effort that produces a tenant was invisible, and the
-- follow-ups sat in somebody's head.
--
-- So: a LEAD. One cafe-in-conversation, owned by a platform_people row,
-- moving through stages, carrying a follow-up date and an activity timeline.
-- Winning it either provisions a new tenant or attaches to an existing one,
-- and the tenant INHERITS the lead's attribution — the lead's owner becomes
-- onboarded_by_person_id (and, via the seed-from-onboarder rule already in
-- provisionTenant, the relationship manager), and the lead's source becomes
-- acquisition_source.
--
-- tenant_requests (0026) was the same idea arriving from the other direction:
-- an inbound lead from the public form. Keeping both would mean two pipelines,
-- two state machines and two places to look, so it is folded in here and
-- dropped. The PUBLIC CONTRACT IS UNCHANGED — POST /public/request-access
-- keeps its body, its 201/200 responses and its rate limits; only the table it
-- writes to moves. tenants.source_request_id becomes source_lead_id.
--
-- ONE VOCABULARY. platform_leads.source uses the same value set as
-- tenants.acquisition_source (extended here with 'outbound'), so conversion
-- copies it across verbatim and there is no mapping table to drift.
--
-- Platform-owned, like platform_people: no RLS. Authority is
-- auth.RequirePlatformAdmin in Go, and nothing under /v1 (the tenant-facing
-- API) reads these. A cafe must never see what we wrote about them while we
-- were still chasing them.
-- =========================================================================

-- 1. Extend the shared acquisition vocabulary -------------------------------

ALTER TABLE tenants DROP CONSTRAINT tenants_acquisition_source_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_acquisition_source_check
  CHECK (acquisition_source IN ('direct', 'request_access', 'referral', 'walk_in', 'outbound', 'other'));

-- 2. The pipeline ------------------------------------------------------------

CREATE TABLE platform_leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_name    text NOT NULL CHECK (length(btrim(cafe_name)) BETWEEN 1 AND 120),
  contact_name text NOT NULL DEFAULT '' CHECK (length(contact_name) <= 120),
  -- Nullable for the same reason platform_people.email is: a lead an agent
  -- picked up on foot may be a shop name and a phone number, nothing more.
  email        citext,
  phone        text NOT NULL DEFAULT '',
  -- Same value set as tenants.acquisition_source. 'outbound' — we went to
  -- them — is the default because that is what an agent-created lead is;
  -- the public form overrides it with 'request_access'.
  source       text NOT NULL DEFAULT 'outbound'
               CHECK (source IN ('direct', 'request_access', 'referral', 'walk_in', 'outbound', 'other')),
  desired_plan text NOT NULL DEFAULT '',        -- plan key hint (not enforced)
  expected_seats int CHECK (expected_seats IS NULL OR expected_seats > 0),
  message      text NOT NULL DEFAULT '' CHECK (length(message) <= 2000),

  stage        text NOT NULL DEFAULT 'new'
               CHECK (stage IN ('new', 'contacted', 'demo', 'negotiating', 'won', 'lost')),
  owner_person_id   uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  -- Day granularity, like tenants.onboarded_on. A field agent books "Tuesday",
  -- not "Tuesday 14:30 Asia/Kathmandu", and a date can't drift across a
  -- timezone boundary on the way to the digest.
  next_follow_up_at date,
  lost_reason  text NOT NULL DEFAULT '' CHECK (length(lost_reason) <= 500),
  converted_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  closed_at    timestamptz,

  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  source_ip    inet,                            -- public submissions only
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Losing a lead must say why. "Lost" with no reason is the single most
  -- useless row a pipeline can contain.
  CONSTRAINT platform_leads_lost_needs_reason
    CHECK (stage <> 'lost' OR length(btrim(lost_reason)) > 0),

  -- Only a WON lead may point at a cafe. Deliberately one-directional rather
  -- than the biconditional ((stage='won') = (converted_tenant_id IS NOT NULL)):
  -- converted_tenant_id is ON DELETE SET NULL, so purging a cafe would
  -- retroactively violate a biconditional and make the table unwritable. The
  -- other half — "winning requires a cafe" — is enforced in the handler, which
  -- only ever sets stage='won' from convert/link.
  CONSTRAINT platform_leads_converted_only_when_won
    CHECK (converted_tenant_id IS NULL OR stage = 'won')
);

-- Two leads cannot claim the same cafe.
CREATE UNIQUE INDEX platform_leads_tenant_uniq
  ON platform_leads (converted_tenant_id) WHERE converted_tenant_id IS NOT NULL;

-- This is tenant_requests_one_pending_per_email relocated. It still does the
-- anti-abuse job for the public form, and it now also stops two agents working
-- the same cafe in parallel. Closed stages are excluded so a lost lead can be
-- re-opened as a fresh one later, and NULLs don't collide with each other.
CREATE UNIQUE INDEX platform_leads_open_email_uniq
  ON platform_leads (email)
  WHERE email IS NOT NULL AND stage NOT IN ('won', 'lost');

CREATE INDEX platform_leads_board_idx
  ON platform_leads (stage, next_follow_up_at NULLS LAST, created_at DESC);
CREATE INDEX platform_leads_owner_idx
  ON platform_leads (owner_person_id) WHERE stage NOT IN ('won', 'lost');
CREATE INDEX platform_leads_followup_idx
  ON platform_leads (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL AND stage NOT IN ('won', 'lost');

CREATE TRIGGER platform_leads_updated_at
  BEFORE UPDATE ON platform_leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What was actually done about this lead. 'stage_change' rows are written by
-- the handler, never by a user, so the timeline explains its own history
-- instead of being a pile of undated notes.
CREATE TABLE platform_lead_activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES platform_leads(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'note'
              CHECK (kind IN ('call', 'visit', 'message', 'demo', 'note', 'stage_change')),
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_lead_activities_lead_idx
  ON platform_lead_activities (lead_id, occurred_at DESC, created_at DESC);

-- No DELETE on leads: a lead is LOST, never deleted, so the work that went
-- into it survives (same posture as platform_people).
GRANT SELECT, INSERT, UPDATE         ON platform_leads           TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_lead_activities TO app;

-- 3. Fold tenant_requests in --------------------------------------------------

-- provisioned_tenant_id has no unique constraint, so in principle two approved
-- requests could name one cafe. Only the earliest keeps the link — the later
-- one stays 'won' with a NULL tenant, which the one-directional CHECK allows.
INSERT INTO platform_leads (
  id, cafe_name, contact_name, email, phone, source, desired_plan, message,
  stage, converted_tenant_id, lost_reason, closed_at, source_ip, created_at, updated_at
)
SELECT
  tr.id,
  tr.cafe_name,
  tr.name,
  tr.email,
  tr.phone,
  'request_access',
  tr.desired_plan,
  tr.message,
  CASE tr.state WHEN 'approved' THEN 'won' WHEN 'rejected' THEN 'lost' ELSE 'new' END,
  CASE WHEN tr.state = 'approved' AND tr.dup_rank = 1 THEN tr.provisioned_tenant_id END,
  -- The lost CHECK needs a non-empty reason and review_note was optional
  -- (and unbounded, hence the left()).
  CASE WHEN tr.state = 'rejected'
       THEN left(COALESCE(NULLIF(btrim(tr.review_note), ''), 'no reason recorded'), 500)
       ELSE '' END,
  tr.reviewed_at,
  tr.source_ip,
  tr.created_at,
  COALESCE(tr.reviewed_at, tr.created_at)
FROM (
  SELECT *, row_number() OVER (PARTITION BY provisioned_tenant_id ORDER BY created_at) AS dup_rank
  FROM tenant_requests
) tr;

-- Every request must have become exactly one lead. If this fires, STOP — the
-- DROP below would destroy rows that never made it across.
DO $$
DECLARE src bigint; dst bigint;
BEGIN
  SELECT count(*) INTO src FROM tenant_requests;
  SELECT count(*) INTO dst FROM platform_leads WHERE source = 'request_access';
  IF src <> dst THEN
    RAISE EXCEPTION 'lead backfill lost rows: % tenant_requests -> % leads', src, dst;
  END IF;
END $$;

-- 4. Re-point the tenant back-reference ---------------------------------------

ALTER TABLE tenants
  ADD COLUMN source_lead_id uuid REFERENCES platform_leads(id) ON DELETE SET NULL;

-- The lead ids were preserved from the request ids above, so this is the same
-- relation 0057 established, just renamed.
UPDATE tenants t SET source_lead_id = t.source_request_id
WHERE t.source_request_id IS NOT NULL;

CREATE INDEX tenants_source_lead_idx
  ON tenants (source_lead_id) WHERE source_lead_id IS NOT NULL;

ALTER TABLE tenants DROP COLUMN source_request_id;
DROP TABLE tenant_requests;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Recreate tenant_requests exactly as 0026 left it, then push the inbound
-- leads back into it.
CREATE TABLE tenant_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  cafe_name     text NOT NULL CHECK (length(cafe_name) BETWEEN 1 AND 120),
  email         citext NOT NULL,
  phone         text NOT NULL DEFAULT '',
  desired_plan  text NOT NULL DEFAULT '',
  message       text NOT NULL DEFAULT '' CHECK (length(message) <= 2000),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  provisioned_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_note   text NOT NULL DEFAULT '',
  source_ip     inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_requests (
  id, name, cafe_name, email, phone, desired_plan, message,
  state, provisioned_tenant_id, reviewed_at, review_note, source_ip, created_at
)
SELECT
  l.id,
  COALESCE(NULLIF(btrim(l.contact_name), ''), l.cafe_name),
  l.cafe_name,
  l.email,
  l.phone,
  l.desired_plan,
  l.message,
  CASE l.stage WHEN 'won' THEN 'approved' WHEN 'lost' THEN 'rejected' ELSE 'pending' END,
  l.converted_tenant_id,
  l.closed_at,
  CASE WHEN l.stage = 'lost' THEN l.lost_reason ELSE '' END,
  l.source_ip,
  l.created_at
FROM platform_leads l
WHERE l.source = 'request_access' AND l.email IS NOT NULL;

CREATE INDEX tenant_requests_state_idx ON tenant_requests(state, created_at DESC);
CREATE UNIQUE INDEX tenant_requests_one_pending_per_email
  ON tenant_requests (email) WHERE state = 'pending';
GRANT SELECT, INSERT, UPDATE ON tenant_requests TO app;

ALTER TABLE tenants
  ADD COLUMN source_request_id uuid REFERENCES tenant_requests(id) ON DELETE SET NULL;
UPDATE tenants t SET source_request_id = t.source_lead_id
WHERE t.source_lead_id IN (SELECT id FROM tenant_requests);

DROP INDEX IF EXISTS tenants_source_lead_idx;
ALTER TABLE tenants DROP COLUMN source_lead_id;

DROP TABLE IF EXISTS platform_lead_activities;
DROP TABLE IF EXISTS platform_leads;

ALTER TABLE tenants DROP CONSTRAINT tenants_acquisition_source_check;
UPDATE tenants SET acquisition_source = 'direct' WHERE acquisition_source = 'outbound';
ALTER TABLE tenants ADD CONSTRAINT tenants_acquisition_source_check
  CHECK (acquisition_source IN ('direct', 'request_access', 'referral', 'walk_in', 'other'));

-- +goose StatementEnd
