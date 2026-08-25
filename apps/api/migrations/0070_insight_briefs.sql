-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0070 — the brief: one record per café per local day of what it was told.
--
-- WHY A TABLE AND NOT JUST AN EMAIL
--
-- The row IS the idempotence marker, and that is its main job. The nightly
-- fan-out runs per café, and a café's brief must be produced exactly once for
-- its own local date no matter how the run is interrupted:
--
--   * the API runs as a single ECS task with minimumHealthyPercent 0, so ANY
--     push to main kills the job mid-run
--   * the 5-minute ticker fires several times inside the due window
--   * an admin can re-trigger the run by hand
--
-- The digest (jobs/digest.go) gets away with a platform_audit marker because it
-- sends ONE email for the whole platform. A per-tenant fan-out needs per-tenant
-- state, or a crash halfway through means every café before the crash gets a
-- second brief tomorrow-plus-one and every café after it gets none.
--
-- Reserving the row BEFORE doing the work is what makes a crash cost one brief
-- rather than duplicate an email. emailed_at and pushed_at are separate stamps
-- because "the brief was computed" and "the email actually went" fail
-- independently, and conflating them would either re-send or silently drop.
--
-- CROSS-TENANT READ, WITHOUT A DEFINER FUNCTION
--
-- The runtime pool connects as app_user (NOBYPASSRLS), so the scheduler cannot
-- ask "which cafés still need a brief?" under plain tenant isolation — it has no
-- tenant context yet, and that is the whole question it is trying to answer.
--
-- Two policies rather than one, following 0038's bug_reports: normal tenant
-- isolation, plus a platform-admin branch. The job borrows a platform admin's
-- identity for that ONE scheduling query, exactly as jobs/snapshot.go does for
-- the usage rollup, and then does all the real per-café work inside a
-- transaction with app.tenant_id set.
--
-- Deliberately NOT the alternative: a SECURITY DEFINER function per read. This
-- table holds counts and timestamps, not money, and one extra policy is a much
-- smaller surface than a function that bypasses RLS entirely.
--
-- The BUSINESS data behind a brief is never read this way. Findings, orders,
-- expenses and the rest stay under plain tenant isolation and are only ever
-- reached with app.tenant_id set — a platform-admin identity does not open those
-- policies and must not.
-- =========================================================================

CREATE TABLE insight_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The café's LOCAL date. A UTC date would put a Kathmandu morning's brief on
  -- the previous day for six hours out of every twenty-four.
  day           date NOT NULL,

  -- What the run found. Kept so a brief can be explained after the fact without
  -- re-deriving it from thresholds that may since have changed.
  finding_count int NOT NULL DEFAULT 0,
  -- How many the brief actually led with, and how many it said were left over.
  lead_count    int NOT NULL DEFAULT 0,
  more_count    int NOT NULL DEFAULT 0,
  -- NULL when the café had recorded too little for the figure to mean anything.
  -- That is a real answer, not a missing one.
  books_confidence numeric,

  -- Separate stamps: computed, emailed and pushed fail independently.
  emailed_at      timestamptz,
  email_recipients int NOT NULL DEFAULT 0,
  pushed_at       timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- The idempotence marker itself.
  UNIQUE (tenant_id, day)
);

CREATE INDEX insight_briefs_day_idx ON insight_briefs(day DESC);

ALTER TABLE insight_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_briefs FORCE ROW LEVEL SECURITY;
CREATE POLICY insight_briefs_isolation ON insight_briefs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- The scheduling branch. Read AND write, because the job reserves the row
-- before it has a tenant context to reserve it under.
CREATE POLICY insight_briefs_platform ON insight_briefs
  USING (is_platform_admin(current_user_id()))
  WITH CHECK (is_platform_admin(current_user_id()));

GRANT SELECT, INSERT, UPDATE ON insight_briefs TO app;

-- =========================================================================
-- What the brief actually led with. Recorded rather than re-derived, so "the
-- email told me X on Tuesday" is answerable even after the finding closed.
-- =========================================================================

CREATE TABLE insight_brief_items (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brief_id   uuid NOT NULL REFERENCES insight_briefs(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES insight_findings(id) ON DELETE CASCADE,
  rank       int  NOT NULL,
  PRIMARY KEY (brief_id, finding_id)
);

ALTER TABLE insight_brief_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_brief_items FORCE ROW LEVEL SECURITY;
CREATE POLICY insight_brief_items_isolation ON insight_brief_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
-- No platform branch here: the items are written inside the per-café
-- transaction, where tenant context exists. Only the marker needs the escape.

GRANT SELECT, INSERT ON insight_brief_items TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE IF EXISTS insight_brief_items;
DROP TABLE IF EXISTS insight_briefs;

-- +goose StatementEnd
