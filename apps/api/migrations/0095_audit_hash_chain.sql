-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0095 — Hash-chained activity log (procedure 2082 §6.3(ख)(ग), 2074 §6(ञ)).
--
-- audit_log was already append-only for the app role (SELECT/INSERT grants
-- only). That stops the application, not a database owner. Chaining makes any
-- later edit or deletion DETECTABLE by anyone who can read the log: every row
-- of a tenant carries the sha256 of its own content plus the previous row's
-- hash, numbered by chain_seq. Change, insert or remove one row and every
-- hash after it stops matching; audit_chain_verify(tenant) says where.
--
-- The hash covers a canonical jsonb array of the row (jsonb's text form is
-- deterministic), so no field can bleed into another. created_at is taken in
-- UTC with microseconds so the value hashed is the value stored.
--
-- Rows written before this migration have no chain (chain_seq NULL); the chain
-- of each tenant starts at its first row after it. Rows without a tenant
-- (pre-tenant logins) are not chained.
--
-- A per-tenant advisory lock orders concurrent inserts so two rows never claim
-- the same predecessor. Audit volume per café is low; the lock is brief.
-- =========================================================================

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS chain_seq bigint,
  ADD COLUMN IF NOT EXISTS prev_hash text,
  ADD COLUMN IF NOT EXISTS hash text;

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_uniq
  ON audit_log (tenant_id, chain_seq) WHERE chain_seq IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_log_row_hash(
  p_prev text, p_seq bigint, p_tenant uuid, p_actor uuid, p_actor_name text, p_action text,
  p_entity text, p_entity_id uuid, p_summary text, p_created timestamptz, p_request text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    p_prev, p_seq, p_tenant, p_actor, p_actor_name, p_action, p_entity, p_entity_id, p_summary,
    to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), p_request
  )::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  last record;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.tenant_id::text, 0));
  SELECT chain_seq, hash INTO last
  FROM audit_log
  WHERE tenant_id = NEW.tenant_id AND chain_seq IS NOT NULL
  ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := COALESCE(last.chain_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last.hash, repeat('0', 64));
  NEW.hash := audit_log_row_hash(NEW.prev_hash, NEW.chain_seq, NEW.tenant_id, NEW.actor_id, NEW.actor_name,
    NEW.action, NEW.entity, NEW.entity_id, NEW.summary, NEW.created_at, NEW.request_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Walk a tenant's chain. ok=false names the first row that does not match
-- (its content was changed, or a row before it was removed or altered).
-- The caller must be allowed to read that tenant's log: a platform admin, or
-- the tenant itself (current_tenant_id()).
CREATE OR REPLACE FUNCTION audit_chain_verify(p_tenant uuid)
RETURNS TABLE (ok boolean, rows_checked bigint, first_bad_seq bigint, first_bad_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r record;
  prev text := repeat('0', 64);
  expect bigint := 1;
  n bigint := 0;
BEGIN
  IF p_tenant IS DISTINCT FROM current_tenant_id() AND NOT is_platform_admin(current_user_id()) THEN
    RAISE EXCEPTION 'audit_chain_verify: not allowed' USING ERRCODE = '42501';
  END IF;
  FOR r IN
    SELECT * FROM audit_log WHERE tenant_id = p_tenant AND chain_seq IS NOT NULL ORDER BY chain_seq
  LOOP
    n := n + 1;
    IF r.chain_seq <> expect OR r.prev_hash <> prev OR r.hash <> audit_log_row_hash(
         r.prev_hash, r.chain_seq, r.tenant_id, r.actor_id, r.actor_name, r.action, r.entity,
         r.entity_id, r.summary, r.created_at, r.request_id) THEN
      RETURN QUERY SELECT false, n, r.chain_seq, r.id;
      RETURN;
    END IF;
    prev := r.hash;
    expect := expect + 1;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::uuid;
END;
$fn$;
REVOKE ALL ON FUNCTION audit_chain_verify(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_chain_verify(uuid) TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS audit_chain_verify(uuid);
DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
DROP FUNCTION IF EXISTS audit_log_chain();
DROP FUNCTION IF EXISTS audit_log_row_hash(text, bigint, uuid, uuid, text, text, text, uuid, text, timestamptz, text);
DROP INDEX IF EXISTS audit_log_chain_uniq;
ALTER TABLE audit_log DROP COLUMN IF EXISTS hash, DROP COLUMN IF EXISTS prev_hash, DROP COLUMN IF EXISTS chain_seq;
-- +goose StatementEnd
