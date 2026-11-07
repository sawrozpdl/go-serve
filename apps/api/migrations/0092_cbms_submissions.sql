-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0092 — CBMS outbox: every fiscal document's journey to IRD's Central
-- Billing Monitoring System.
--
-- Procedure 2082 §6.4(क), §7.2(ङ): a cloud-hosted billing system must send
-- each invoice to CBMS through its web API at the time of issue. Posting
-- inside the settle transaction would make a slow or down IRD server block
-- the till, so the settle writes an OUTBOX row in the same transaction as the
-- invoice (it can never be lost or doubled) and a worker posts it right
-- after commit, retrying with backoff until IRD has it.
--
--   status   pending  — waiting for its (next) attempt
--            synced   — CBMS answered 200, or 101 "already exists" on a bill
--            failed   — CBMS rejected the content (102/103/104) too many
--                       times; a human must look (alerted)
--   is_realtime is what we told CBMS: true only when the post landed within
--   the real-time window of the invoice's issue time.
--   synced_via says WHO said 200: 'live' (the real CBMS host — IRD's test or
--   live login) or 'mock' (the in-process stand-in used until a café has
--   credentials). Only 'live' counts as Sync_with_IRD in the Standard View,
--   and a 'mock' sync is the one kind that may go back to pending: when the
--   server starts posting for real, cbms_requeue_mock_synced() puts every
--   mock-synced document back in the queue so it reaches IRD after all.
--
-- The payload is the CBMS body WITHOUT the credentials (they are added at
-- send time from fiscal_profiles and never stored here or logged).
--
-- The worker discovers due rows across tenants through the SECURITY DEFINER
-- cbms_due_submissions() — ids only, no payload — and then works each one in
-- a transaction scoped to its own tenant, exactly like the brief job.
-- =========================================================================

CREATE TABLE IF NOT EXISTS cbms_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  doc_type        text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  doc_id          uuid NOT NULL,
  endpoint        text NOT NULL CHECK (endpoint IN ('bill', 'billreturn')),
  -- Issue time of the document, for the real-time window.
  issued_at       timestamptz NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_code       int,
  last_error      text NOT NULL DEFAULT '',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz,
  synced_via      text CHECK (synced_via IN ('live', 'mock')),
  is_realtime     boolean,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, doc_id),
  CHECK (status <> 'synced' OR (synced_at IS NOT NULL AND synced_via IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS cbms_submissions_due_idx
  ON cbms_submissions (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS cbms_submissions_tenant_idx
  ON cbms_submissions (tenant_id, status);

ALTER TABLE cbms_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cbms_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cbms_submissions_isolation ON cbms_submissions;
CREATE POLICY cbms_submissions_isolation ON cbms_submissions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON cbms_submissions TO app;
-- The worker moves status; nothing else about a submission may change.
GRANT UPDATE (status, attempts, last_code, last_error, next_attempt_at, synced_at, synced_via, is_realtime, updated_at)
  ON cbms_submissions TO app;

CREATE OR REPLACE FUNCTION cbms_submissions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CBMS submissions are kept as the record of reporting to IRD'
      USING ERRCODE = 'restrict_violation', HINT = 'fiscal_immutable';
  END IF;
  IF OLD.status = 'synced' AND NEW.status <> 'synced' AND OLD.synced_via IS DISTINCT FROM 'mock' THEN
    RAISE EXCEPTION 'a document already reported to IRD cannot be un-reported'
      USING ERRCODE = 'check_violation', HINT = 'fiscal_immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cbms_submissions_guard ON cbms_submissions;
CREATE TRIGGER cbms_submissions_guard
  BEFORE UPDATE OR DELETE ON cbms_submissions
  FOR EACH ROW EXECUTE FUNCTION cbms_submissions_guard();

-- Due work across tenants: ids and tenants only.
CREATE OR REPLACE FUNCTION cbms_due_submissions(p_limit int)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT s.id, s.tenant_id
  FROM cbms_submissions s
  WHERE s.status = 'pending' AND s.next_attempt_at <= now()
  ORDER BY s.next_attempt_at
  LIMIT greatest(1, least(p_limit, 500))
$fn$;
REVOKE ALL ON FUNCTION cbms_due_submissions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cbms_due_submissions(int) TO app;

-- Live posting has begun: everything only the mock "synced" goes back in the
-- queue (marked non-real-time by the worker, since it is late by now).
CREATE OR REPLACE FUNCTION cbms_requeue_mock_synced() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n int;
BEGIN
  UPDATE cbms_submissions
  SET status = 'pending', synced_at = NULL, synced_via = NULL, next_attempt_at = now(),
      last_error = 'requeued: earlier sync was the mock, not IRD'
  WHERE status = 'synced' AND synced_via = 'mock';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;
REVOKE ALL ON FUNCTION cbms_requeue_mock_synced() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cbms_requeue_mock_synced() TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS cbms_requeue_mock_synced();
DROP FUNCTION IF EXISTS cbms_due_submissions(int);
DROP TABLE IF EXISTS cbms_submissions;
DROP FUNCTION IF EXISTS cbms_submissions_guard();
-- +goose StatementEnd
