-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0065: ENGAGE — QR gamified retention
--
-- THE FEATURE
--
-- A café-wide QR on a table tent. A guest scans it, plays a short skill game
-- (Tea Runner / Memory Match / Stack), and if they clear a score threshold they
-- win a reward the cashier applies to the bill they are sitting in front of.
--
-- THE LOAD-BEARING DECISION: THE REWARD DIES IN FIVE MINUTES
--
-- The printed URL is static and grants NOTHING on its own — every scan mints a
-- fresh session, and a won code expires after engage_campaigns.reward_ttl_seconds
-- (default 300). That single property removes the entire coupon-abuse surface:
--
--   * a code farmed at home is worthless by the time you reach a café;
--   * a code posted publicly is worthless to whoever reads it;
--   * nobody can stockpile codes, because they rot in minutes;
--   * QR rotation becomes unnecessary — a leaked link grants nothing — which is
--     why there is no token column here and no rotation endpoint;
--   * spend lift is measurable on the SAME bill instead of inferred across
--     visits.
--
-- It is also why there is no valid_from / expiry_days pair anywhere in this
-- schema. Retention comes from the daily cadence (one winnable play per device
-- per day), not from a coupon the guest might remember to bring back.
--
-- HOW THE MONEY LANDS
--
-- Redemption writes an ORDINARY order_adjustments row of type 'discount' and
-- nothing else. buildQuote, CloseOrder, every report and platform_accuracy_check()
-- therefore keep working with zero edits. The link back to the reward lives on
-- engage_redemptions (here), never as a new column on the hot order_adjustments
-- table.
--
-- NOTE ON RLS: unlike 0038_bug_reports.sql these tables get NO platform-admin
-- policy. engage_contacts is guest PII and /super has no business reading it.
-- Note also that the public play endpoints run with app.tenant_id set but
-- app.user_id UNSET, so no policy here may reference current_user_id().
-- =========================================================================

-- -------------------------------------------------------------------------
-- Campaigns
-- -------------------------------------------------------------------------

CREATE TABLE engage_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','paused','ended')),

  -- Schedule. NULL end date = runs until paused. active_days is 0..6 (Sunday=0),
  -- empty/NULL = every day; the time pair NULL = all day.
  starts_on     date,
  ends_on       date,
  active_days   smallint[],
  active_from   time,
  active_to     time,

  game          text NOT NULL DEFAULT 'tea_runner'
                  CHECK (game IN ('tea_runner','memory_match','stack')),
  difficulty    text NOT NULL DEFAULT 'normal'
                  CHECK (difficulty IN ('gentle','normal','tricky')),

  -- The five-minute rule, and the cashier's escape hatch. grace_seconds is the
  -- window AFTER expiry in which the POS may still honour a code, flagged as an
  -- override — a guest should not lose their prize because the counter was busy.
  reward_ttl_seconds int NOT NULL DEFAULT 300
                  CHECK (reward_ttl_seconds BETWEEN 120 AND 1800),
  grace_seconds      int NOT NULL DEFAULT 600
                  CHECK (grace_seconds BETWEEN 0 AND 3600),

  -- A reward gated on reflexes excludes real customers (motor control, vision,
  -- an old phone, a queue). When on, the play page offers the lowest winning
  -- tier without playing. Default off by the owner's decision.
  allow_claim_without_play boolean NOT NULL DEFAULT false,

  -- Budget caps. NULL = uncapped. Checked at BOOTSTRAP, before a guest plays, so
  -- nobody clears the top tier and is then told the till is dry.
  budget_total_cents  bigint CHECK (budget_total_cents IS NULL OR budget_total_cents >= 0),
  budget_daily_cents  bigint CHECK (budget_daily_cents IS NULL OR budget_daily_cents >= 0),
  budget_daily_count  int    CHECK (budget_daily_count IS NULL OR budget_daily_count >= 0),

  contact_capture_enabled boolean NOT NULL DEFAULT true,

  headline      text NOT NULL DEFAULT '',
  subhead       text NOT NULL DEFAULT '',
  terms_text    text NOT NULL DEFAULT '',

  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: issued codes outlive the campaign that minted them.
  deleted_at    timestamptz,

  CONSTRAINT engage_campaigns_dates_sane
    CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT engage_campaigns_hours_sane
    CHECK (active_from IS NULL OR active_to IS NULL OR active_to > active_from)
);

-- The café-wide QR must resolve to exactly ONE campaign. Enforce it here rather
-- than in a handler that would have to guess which of two live campaigns wins.
CREATE UNIQUE INDEX engage_campaigns_one_active
  ON engage_campaigns(tenant_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX engage_campaigns_tenant_idx
  ON engage_campaigns(tenant_id) WHERE deleted_at IS NULL;

CREATE TRIGGER engage_campaigns_updated_at BEFORE UPDATE ON engage_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE engage_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_campaigns_isolation ON engage_campaigns
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_campaigns TO app;

-- -------------------------------------------------------------------------
-- Reward tiers — score >= min_score wins the HIGHEST matching tier
-- -------------------------------------------------------------------------

CREATE TABLE engage_tiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES engage_campaigns(id) ON DELETE CASCADE,

  min_score     int NOT NULL CHECK (min_score >= 0),
  label         text NOT NULL,
  reward_kind   text NOT NULL CHECK (reward_kind IN ('percent','flat','free_item','none')),

  -- Basis points, so percentages stay integer arithmetic end to end (2500 = 25%).
  percent_bp    int    CHECK (percent_bp IS NULL OR percent_bp BETWEEN 1 AND 10000),
  amount_cents  bigint CHECK (amount_cents IS NULL OR amount_cents > 0),
  -- SET NULL, not RESTRICT: RESTRICT would break both the 'menu' purge scope and
  -- an owner simply deleting a menu item some tier happens to reference. A tier
  -- whose item has gone NULL is treated as 'none' at issue time and flagged in
  -- the editor.
  menu_item_id  uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  max_discount_cents bigint CHECK (max_discount_cents IS NULL OR max_discount_cents > 0),

  -- What this tier costs the budget when issued. For percent tiers that is
  -- max_discount_cents, which is exactly why the CHECK below makes it mandatory:
  -- without a ceiling, a percentage reward makes the budget cap unenforceable.
  estimated_value_cents bigint NOT NULL DEFAULT 0 CHECK (estimated_value_cents >= 0),
  sort          int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- free_item deliberately does NOT require menu_item_id here, even though the
  -- handler insists on one. ON DELETE SET NULL has to be able to null the column
  -- when an owner deletes the menu item, and a CHECK demanding it would turn
  -- that ordinary edit — and the 'menu' purge scope — into a constraint
  -- violation:
  --   ERROR: new row for relation "engage_tiers" violates check constraint
  --          "engage_tiers_shape_coherent"
  --   CONTEXT: SQL statement "UPDATE ONLY engage_tiers SET menu_item_id = NULL"
  -- A tier whose item has gone is a BROKEN tier the editor flags and issuing
  -- treats as 'none', not a row the database should refuse to let exist.
  CONSTRAINT engage_tiers_shape_coherent CHECK (
       (reward_kind = 'percent'   AND percent_bp IS NOT NULL AND max_discount_cents IS NOT NULL)
    OR (reward_kind = 'flat'      AND amount_cents IS NOT NULL)
    OR (reward_kind = 'free_item')
    OR (reward_kind = 'none')
  )
);

CREATE UNIQUE INDEX engage_tiers_campaign_score_uniq
  ON engage_tiers(campaign_id, min_score);
CREATE INDEX engage_tiers_tenant_campaign_idx
  ON engage_tiers(tenant_id, campaign_id, sort);

CREATE TRIGGER engage_tiers_updated_at BEFORE UPDATE ON engage_tiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE engage_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_tiers FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_tiers_isolation ON engage_tiers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_tiers TO app;

-- -------------------------------------------------------------------------
-- Play sessions — where the once-a-day gate is enforced
-- -------------------------------------------------------------------------

CREATE TABLE engage_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: a practice run can happen with no live campaign, and
  -- deleting a campaign must not erase the play history it produced.
  campaign_id   uuid REFERENCES engage_campaigns(id) ON DELETE SET NULL,

  -- The raw session token is returned to the guest exactly once and never
  -- stored, matching how ws_tickets and email_otps handle their secrets.
  session_token_hash text NOT NULL,
  -- sha256(value || pepper). A raw guest IP is never stored on this table.
  device_hash   text NOT NULL,
  ip_hash       text NOT NULL DEFAULT '',
  -- Signed-cookie identity, used ONLY to resume an in-flight session. The daily
  -- gate keys on device_hash, because a cookie is trivially cleared.
  device_cookie_id text NOT NULL DEFAULT '',

  -- TENANT-LOCAL date, written as (now() AT TIME ZONE <tz>)::date, so "one a
  -- day" means what the owner thinks it means.
  play_day      date NOT NULL,
  is_winnable   boolean NOT NULL DEFAULT false,

  game          text NOT NULL CHECK (game IN ('tea_runner','memory_match','stack')),
  difficulty    text NOT NULL DEFAULT 'normal',
  seed          bigint NOT NULL,

  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','completed','flagged')),
  outcome       text NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending','practice','no_reward','win',
                                     'rejected','claimed_no_play')),

  score             int,
  -- Reported by the client and stored for forensics ONLY. Every decision uses
  -- server_elapsed_ms (now() - started_at), which the guest cannot forge.
  client_elapsed_ms int,
  server_elapsed_ms int,
  event_count       int,
  -- Kept so deterministic server-side replay verification can be added later
  -- without having lost the data. Size-capped in the handler, not here.
  input_trace       jsonb,
  reject_reason     text NOT NULL DEFAULT '',
  user_agent        text NOT NULL DEFAULT '',

  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- THE DAILY GATE. A partial unique index, not a read-then-write check in Go:
-- start-play does INSERT ... ON CONFLICT DO NOTHING RETURNING id, and zero rows
-- back means today's winnable attempt is already spent, so it re-inserts with
-- is_winnable = false for an unlimited practice run.
CREATE UNIQUE INDEX engage_sessions_one_winnable_per_day
  ON engage_sessions(tenant_id, device_hash, play_day) WHERE is_winnable;

CREATE UNIQUE INDEX engage_sessions_token_uniq ON engage_sessions(session_token_hash);
CREATE INDEX engage_sessions_tenant_day_idx   ON engage_sessions(tenant_id, play_day);
CREATE INDEX engage_sessions_device_idx       ON engage_sessions(tenant_id, device_hash, play_day);
CREATE INDEX engage_sessions_campaign_day_idx ON engage_sessions(tenant_id, campaign_id, play_day);
CREATE INDEX engage_sessions_ip_idx           ON engage_sessions(tenant_id, ip_hash, started_at);

ALTER TABLE engage_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_sessions_isolation ON engage_sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_sessions TO app;

-- -------------------------------------------------------------------------
-- Issued reward codes
-- -------------------------------------------------------------------------

CREATE TABLE engage_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- RESTRICT: campaigns are soft-deleted, so this never fires in the app — it is
  -- here to make a hard delete of a campaign with live codes impossible.
  campaign_id   uuid NOT NULL REFERENCES engage_campaigns(id) ON DELETE RESTRICT,
  tier_id       uuid REFERENCES engage_tiers(id) ON DELETE SET NULL,
  session_id    uuid NOT NULL REFERENCES engage_sessions(id) ON DELETE CASCADE,

  -- Display form (TEA-7K2M) and the normalised form used for lookup: upper-cased
  -- with dashes and spaces stripped. Drawn from an alphabet without 0/O/1/I,
  -- because these get read aloud across a counter.
  code          text NOT NULL,
  code_norm     text NOT NULL,

  -- SNAPSHOT of the tier at issue time. A tier edited an hour from now must not
  -- change what an already-revealed code is worth. Same habit as bug_reports and
  -- order_item_modifiers.
  reward_kind   text NOT NULL CHECK (reward_kind IN ('percent','flat','free_item')),
  label         text NOT NULL,
  percent_bp    int,
  amount_cents  bigint,
  menu_item_id  uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  max_discount_cents bigint,
  estimated_value_cents bigint NOT NULL DEFAULT 0,

  issued_on     date NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  -- Set when the guest reveals the code; the TTL clock starts there, not at
  -- issue, so a slow reveal animation never eats into the guest's five minutes.
  revealed_at   timestamptz,
  expires_at    timestamptz NOT NULL,
  grace_until   timestamptz NOT NULL,

  -- No 'expired' status on purpose: expiry is DERIVED from expires_at at read
  -- time. A stored status needs a job to stay true, and a background job that
  -- silently stops is worse than no job at all.
  status        text NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','redeemed','void')),

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX engage_codes_tenant_norm_uniq ON engage_codes(tenant_id, code_norm);
CREATE UNIQUE INDEX engage_codes_session_uniq     ON engage_codes(session_id);
-- The budget aggregate reads through this one.
CREATE INDEX engage_codes_campaign_issued_idx
  ON engage_codes(tenant_id, campaign_id, issued_on) WHERE status <> 'void';
CREATE INDEX engage_codes_status_idx ON engage_codes(tenant_id, status, expires_at);

ALTER TABLE engage_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_codes_isolation ON engage_codes
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_codes TO app;

-- -------------------------------------------------------------------------
-- Redemptions — the POS record
-- -------------------------------------------------------------------------

CREATE TABLE engage_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_id       uuid NOT NULL REFERENCES engage_codes(id) ON DELETE CASCADE,

  -- CASCADE is MANDATORY here. purge_tenant_data's 'transactions' scope deletes
  -- orders, and a RESTRICT would reproduce exactly the bug 0064 was written to
  -- fix (purge aborting on a normal café shape).
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- SET NULL: deleting the order cascades order_adjustments, and this row is
  -- already going with the order anyway.
  order_adjustment_id uuid REFERENCES order_adjustments(id) ON DELETE SET NULL,
  -- Which line a free-item reward consumed.
  order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL,

  -- What was ACTUALLY discounted, after clamping to the bill's headroom, and
  -- what it would have been. Keeping both is what stops reward-value reporting
  -- from overstating itself.
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  intended_amount_cents bigint NOT NULL CHECK (intended_amount_cents > 0),
  was_clamped           boolean NOT NULL DEFAULT false,
  -- Honoured after expiry, inside the grace window, by a named human.
  was_grace_override    boolean NOT NULL DEFAULT false,

  redeemed_on   date NOT NULL,
  redeemed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Set when the cashier removes the discount again; the code goes back to
  -- 'issued' and the partial unique indexes below let it be used once more.
  reverted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One reward per bill. Stacking multiplies the discount-cap and budget
-- attribution problems for no product value.
CREATE UNIQUE INDEX engage_redemptions_one_per_order
  ON engage_redemptions(tenant_id, order_id) WHERE reverted_at IS NULL;
CREATE UNIQUE INDEX engage_redemptions_one_per_code
  ON engage_redemptions(code_id) WHERE reverted_at IS NULL;
CREATE INDEX engage_redemptions_day_idx ON engage_redemptions(tenant_id, redeemed_on);
CREATE INDEX engage_redemptions_adj_idx ON engage_redemptions(tenant_id, order_adjustment_id);

ALTER TABLE engage_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_redemptions_isolation ON engage_redemptions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_redemptions TO app;

-- -------------------------------------------------------------------------
-- Opt-in guest contacts (PII)
-- -------------------------------------------------------------------------

CREATE TABLE engage_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES engage_sessions(id) ON DELETE SET NULL,
  campaign_id   uuid REFERENCES engage_campaigns(id) ON DELETE SET NULL,

  name          text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  -- lower(email) || '|' || digits(phone) — the dedupe key, so a returning guest
  -- bumps last_seen_at instead of creating a second row.
  contact_key   text NOT NULL,

  -- CHECK (consent) means a row CANNOT EXIST without consent. Storing the exact
  -- wording they agreed to is the difference between a consent record and a
  -- checkbox.
  consent       boolean NOT NULL CHECK (consent),
  consent_at    timestamptz NOT NULL DEFAULT now(),
  consent_source text NOT NULL DEFAULT 'play_reveal',
  consent_text_version text NOT NULL DEFAULT '',

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  times_seen    int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT engage_contacts_reachable CHECK (email <> '' OR phone <> '')
);

CREATE UNIQUE INDEX engage_contacts_key_uniq ON engage_contacts(tenant_id, contact_key);
CREATE INDEX engage_contacts_tenant_seen_idx ON engage_contacts(tenant_id, last_seen_at DESC);

ALTER TABLE engage_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_contacts_isolation ON engage_contacts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_contacts TO app;

-- -------------------------------------------------------------------------
-- Scans — deduped to device-days
-- -------------------------------------------------------------------------

CREATE TABLE engage_scans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES engage_campaigns(id) ON DELETE SET NULL,
  device_hash   text NOT NULL,
  scan_date     date NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Reloads. Counting UNIQUE device-days as "scans" makes the headline number
  -- mean "guests who opened it" and makes it much harder to inflate; raw hits
  -- are kept alongside for the ratio.
  hits          int NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX engage_scans_device_day_uniq
  ON engage_scans(tenant_id, device_hash, scan_date);
CREATE INDEX engage_scans_tenant_day_idx ON engage_scans(tenant_id, scan_date);

ALTER TABLE engage_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE engage_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY engage_scans_isolation ON engage_scans
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON engage_scans TO app;

-- +goose StatementEnd

-- -------------------------------------------------------------------------
-- clone_tenant_data: the table list becomes its own function.
--
-- 0063 hard-coded the array inside clone_tenant_data, which means every
-- migration that adds a cloneable table has to restate the whole 190-line body
-- twice (once up, once down) just to change one line — a transcription risk on
-- a SECURITY DEFINER function that can cross tenants if it is got wrong.
-- Hoisting the list into clone_tables() makes this migration's Down a ten-line
-- function replacement instead.
--
-- WHAT IS CLONED, AND WHAT IS NOT. Only engage_campaigns and engage_tiers go —
-- they are configuration, like the menu_items already in the list. Sessions,
-- codes, redemptions, contacts and scans are guest data:
--   * cloning codes would mint live redeemable discounts in a QA sandbox;
--   * cloning contacts would duplicate consented PII into a second workspace.
-- The array's convention is otherwise "add every new table", so the omission is
-- deliberate and stated here.
-- -------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION clone_tables()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'outlets',
    'menu_categories',
    'menu_items',
    'menu_modifier_groups',
    'menu_modifiers',
    'menu_item_modifier_groups',
    'menu_category_modifier_groups',
    'inventory_items',
    'pack_rules',
    'menu_item_inventory_link',
    'modifier_inventory_link',
    'service_tables',
    'house_tabs',
    'cafe_owners',
    'expense_categories',
    'staff',
    'staff_documents',
    'roles',
    'role_permissions',
    'tenant_members',
    'tenant_member_roles',
    'shifts',
    'orders',
    'order_items',
    'order_item_modifiers',
    'order_adjustments',
    'expenses',
    'expense_allocations',
    'payments',
    'house_tab_settlements',
    'stock_movements',
    'cash_drops',
    'account_transfers',
    'owner_ledger',
    'owner_cash_entries',
    'staff_pay',
    -- Engage CONFIG only. engage_tiers.menu_item_id remaps through
    -- _clonemap_menu_items because menu_items is already in this list.
    'engage_campaigns',
    'engage_tiers'
  ]
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION clone_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clone_tables() TO app;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION clone_tenant_data(p_src uuid, p_dst uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  -- Parents before children. Order matters for the INSERTs (a real FK has to
  -- find its parent row); it does NOT matter for the id maps, which are all
  -- built up front.
  tbls text[] := clone_tables();
  t          text;
  col        record;
  sel_parts  text[];
  col_parts  text[];
  counts     jsonb := '{}'::jsonb;
  n          bigint;
  scope      text;   -- the WHERE that selects the source tenant's rows
BEGIN
  IF p_src = p_dst THEN
    RAISE EXCEPTION 'clone_tenant_data: source and destination are the same tenant';
  END IF;

  IF EXISTS (SELECT 1 FROM orders WHERE tenant_id = p_dst)
     OR EXISTS (SELECT 1 FROM menu_items WHERE tenant_id = p_dst) THEN
    RAISE EXCEPTION 'clone_tenant_data: destination tenant already has menu or order data';
  END IF;

  DELETE FROM tenant_member_roles WHERE tenant_id = p_dst;
  DELETE FROM tenant_members WHERE tenant_id = p_dst;
  DELETE FROM outlets WHERE tenant_id = p_dst;

  -- Pass 1: an id map per table, ALL of them before anything is copied.
  FOREACH t IN ARRAY tbls LOOP
    IF clone_has_column(t, 'id') THEN
      EXECUTE format('CREATE TEMP TABLE %I (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP',
                     '_clonemap_' || t);
      EXECUTE format('INSERT INTO %I (old, new) SELECT id, gen_random_uuid() FROM %I s WHERE %s',
                     '_clonemap_' || t, t, clone_scope_sql(t, tbls)) USING p_src;
    END IF;
  END LOOP;

  -- System roles map onto the destination's OWN seeded role of the same key.
  UPDATE _clonemap_roles m
     SET new = d.id
    FROM roles srcr, roles d
   WHERE srcr.id = m.old
     AND srcr.tenant_id = p_src AND srcr.is_system
     AND d.tenant_id = p_dst AND d.key = srcr.key;

  -- Pass 2: copy, remapping ids as we go.
  FOREACH t IN ARRAY tbls LOOP
    col_parts := ARRAY[]::text[];
    sel_parts := ARRAY[]::text[];

    FOR col IN
      SELECT a.attname AS name,
             (SELECT tgt.relname
                FROM pg_constraint con
                JOIN pg_class tgt ON tgt.oid = con.confrelid
               WHERE con.conrelid = c.oid AND con.contype = 'f'
                 AND array_length(con.conkey, 1) = 1 AND con.conkey[1] = a.attnum
               LIMIT 1) AS fk_target
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = t
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
      ORDER BY a.attnum
    LOOP
      col_parts := col_parts || quote_ident(col.name);

      IF col.name = 'tenant_id' THEN
        sel_parts := sel_parts || '$2'::text;
      ELSIF col.name = 'id' THEN
        sel_parts := sel_parts || format('(SELECT new FROM %I WHERE old = s.id)', '_clonemap_' || t);
      ELSIF col.fk_target IS NOT NULL AND col.fk_target = ANY(tbls) THEN
        sel_parts := sel_parts ||
          format('(SELECT new FROM %I WHERE old = s.%I)', '_clonemap_' || col.fk_target, col.name);
      ELSE
        sel_parts := sel_parts || format('s.%I', col.name);
      END IF;
    END LOOP;

    IF t = 'roles' THEN
      scope := clone_scope_sql(t, tbls) || ' AND NOT s.is_system';
    ELSIF t = 'role_permissions' THEN
      scope := clone_scope_sql(t, tbls)
        || ' AND EXISTS (SELECT 1 FROM roles r WHERE r.id = s.role_id AND NOT r.is_system)';
    ELSE
      scope := clone_scope_sql(t, tbls);
    END IF;

    EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I s WHERE %s',
                   t,
                   array_to_string(col_parts, ', '),
                   array_to_string(sel_parts, ', '),
                   t,
                   scope)
      USING p_src, p_dst;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(t, n);
  END LOOP;

  -- Polymorphic references the catalogue cannot describe.
  UPDATE stock_movements sm
     SET ref_id = m.new
    FROM _clonemap_order_items m
   WHERE sm.tenant_id = p_dst AND sm.ref_type = 'order_item' AND sm.ref_id = m.old;

  UPDATE stock_movements sm
     SET ref_id = m.new
    FROM _clonemap_expenses m
   WHERE sm.tenant_id = p_dst AND sm.ref_type = 'expense' AND sm.ref_id = m.old;

  RETURN counts;
END;
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION clone_tenant_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clone_tenant_data(uuid, uuid) TO app;

-- -------------------------------------------------------------------------
-- tenant_data_counts / purge_tenant_data gain an 'engage' scope.
--
-- The scope is FORCED whenever 'transactions' is purged, because
-- engage_redemptions references orders. Bodies are otherwise 0062's and 0064's
-- unchanged.
-- -------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION tenant_data_counts(p_tenant uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT jsonb_build_object(
    'logs',
      (SELECT count(*) FROM audit_log    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM audit_events WHERE tenant_id = p_tenant),
    'transactions',
      (SELECT count(*) FROM orders               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_item_modifiers WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_adjustments    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM payments             WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM shifts               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM cash_drops           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM account_transfers    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM house_tab_settlements WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM expenses             WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM expense_allocations  WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM owner_ledger         WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM owner_cash_entries   WHERE tenant_id = p_tenant),
    'menu',
      (SELECT count(*) FROM menu_items                    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_categories               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_modifier_groups          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_modifiers                WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_modifier_groups     WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_category_modifier_groups WHERE tenant_id = p_tenant),
    'tables',      (SELECT count(*) FROM service_tables WHERE tenant_id = p_tenant),
    'house_tabs',  (SELECT count(*) FROM house_tabs     WHERE tenant_id = p_tenant),
    'owners',      (SELECT count(*) FROM cafe_owners    WHERE tenant_id = p_tenant),
    'inventory',
      (SELECT count(*) FROM inventory_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM pack_rules               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM stock_movements          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_inventory_link WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM modifier_inventory_link  WHERE tenant_id = p_tenant),
    'staff',
      (SELECT count(*) FROM staff           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_documents WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_pay       WHERE tenant_id = p_tenant),
    'engage',
      (SELECT count(*) FROM engage_campaigns   WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM engage_tiers       WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM engage_sessions    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM engage_codes       WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM engage_redemptions WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM engage_contacts    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM engage_scans       WHERE tenant_id = p_tenant)
  )
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION tenant_data_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data_counts(uuid) TO app;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION purge_tenant_data(p_tenant uuid, p_scopes text[])
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  total bigint := 0;
  n     bigint;
  s     text[] := p_scopes;
  drop_tenant boolean := 'everything' = ANY(p_scopes);
BEGIN
  IF drop_tenant THEN
    s := ARRAY['logs','transactions','menu','tables','house_tabs','owners','inventory','staff','engage'];
  END IF;

  -- Catalog scopes RESTRICT-reference transaction rows; force 'transactions'.
  IF ('menu' = ANY(s) OR 'tables' = ANY(s) OR 'house_tabs' = ANY(s) OR 'owners' = ANY(s))
     AND NOT ('transactions' = ANY(s)) THEN
    s := array_append(s, 'transactions');
  END IF;

  -- 'engage' needs NO forcing rule in either direction, and that is by design
  -- rather than by luck. The lesson of 0064 was that a RESTRICT reference from a
  -- new table into an old one silently breaks purge for normal cafés, so this
  -- module's references outward were all chosen to be harmless:
  --   engage_redemptions -> orders            ON DELETE CASCADE
  --   engage_redemptions -> order_adjustments ON DELETE SET NULL
  --   engage_redemptions -> order_items       ON DELETE SET NULL
  --   engage_tiers/codes -> menu_items        ON DELETE SET NULL
  -- So purging 'transactions' or 'menu' without 'engage' cannot raise an FK
  -- error. Keeping the scopes independent also means purging transactions does
  -- not silently destroy the owner's campaign CONFIG, which forcing would.

  IF 'logs' = ANY(s) THEN
    DELETE FROM audit_events WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM audit_log    WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  -- Runs before 'transactions' so the redemption rows go explicitly rather than
  -- by cascade from orders — the row counts stay honest either way.
  -- Child-first within the module: contacts -> redemptions -> codes -> sessions
  -- -> scans -> tiers -> campaigns.
  IF 'engage' = ANY(s) THEN
    DELETE FROM engage_contacts    WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM engage_redemptions WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM engage_codes       WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM engage_sessions    WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM engage_scans       WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM engage_tiers       WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM engage_campaigns   WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'transactions' = ANY(s) THEN
    DELETE FROM owner_cash_entries WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant AND (is_correction OR parent_loan_id IS NOT NULL); GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM house_tab_settlements WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM orders WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades order_items (-> order_item_modifiers), order_adjustments, payments
    DELETE FROM staff_pay WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- references expenses
    DELETE FROM account_transfers WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM cash_drops WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- references expenses
    DELETE FROM expenses WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades expense_allocations
    DELETE FROM shifts WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'menu' = ANY(s) THEN
    DELETE FROM menu_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_item_inventory_link, menu_item_modifier_groups
    DELETE FROM menu_categories WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_category_modifier_groups
    DELETE FROM menu_modifier_groups WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades menu_modifiers -> modifier_inventory_link
  END IF;

  IF 'tables' = ANY(s) THEN
    DELETE FROM service_tables WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'house_tabs' = ANY(s) THEN
    DELETE FROM house_tabs WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'owners' = ANY(s) THEN
    DELETE FROM cafe_owners WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'inventory' = ANY(s) THEN
    DELETE FROM modifier_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_item_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM inventory_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades pack_rules, stock_movements
  END IF;

  IF 'staff' = ANY(s) THEN
    DELETE FROM staff WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n; -- cascades staff_documents, staff_pay
  END IF;

  IF drop_tenant THEN
    DELETE FROM tenants WHERE id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  RETURN total;
END;
$fn$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION purge_tenant_data(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tenant_data(uuid, text[]) TO app;

-- +goose Down

-- The functions must stop referencing the engage tables BEFORE those tables are
-- dropped, or every super-admin purge / clone would fail at call time.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION clone_tables()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'outlets',
    'menu_categories',
    'menu_items',
    'menu_modifier_groups',
    'menu_modifiers',
    'menu_item_modifier_groups',
    'menu_category_modifier_groups',
    'inventory_items',
    'pack_rules',
    'menu_item_inventory_link',
    'modifier_inventory_link',
    'service_tables',
    'house_tabs',
    'cafe_owners',
    'expense_categories',
    'staff',
    'staff_documents',
    'roles',
    'role_permissions',
    'tenant_members',
    'tenant_member_roles',
    'shifts',
    'orders',
    'order_items',
    'order_item_modifiers',
    'order_adjustments',
    'expenses',
    'expense_allocations',
    'payments',
    'house_tab_settlements',
    'stock_movements',
    'cash_drops',
    'account_transfers',
    'owner_ledger',
    'owner_cash_entries',
    'staff_pay'
  ]
$fn$;
-- +goose StatementEnd

-- Restores 0062's body (no 'engage' key).
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION tenant_data_counts(p_tenant uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT jsonb_build_object(
    'logs',
      (SELECT count(*) FROM audit_log    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM audit_events WHERE tenant_id = p_tenant),
    'transactions',
      (SELECT count(*) FROM orders               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_item_modifiers WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM order_adjustments    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM payments             WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM shifts               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM cash_drops           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM account_transfers    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM house_tab_settlements WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM expenses             WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM expense_allocations  WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM owner_ledger         WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM owner_cash_entries   WHERE tenant_id = p_tenant),
    'menu',
      (SELECT count(*) FROM menu_items                    WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_categories               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_modifier_groups          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_modifiers                WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_modifier_groups     WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_category_modifier_groups WHERE tenant_id = p_tenant),
    'tables',      (SELECT count(*) FROM service_tables WHERE tenant_id = p_tenant),
    'house_tabs',  (SELECT count(*) FROM house_tabs     WHERE tenant_id = p_tenant),
    'owners',      (SELECT count(*) FROM cafe_owners    WHERE tenant_id = p_tenant),
    'inventory',
      (SELECT count(*) FROM inventory_items          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM pack_rules               WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM stock_movements          WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM menu_item_inventory_link WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM modifier_inventory_link  WHERE tenant_id = p_tenant),
    'staff',
      (SELECT count(*) FROM staff           WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_documents WHERE tenant_id = p_tenant)
    + (SELECT count(*) FROM staff_pay       WHERE tenant_id = p_tenant)
  )
$fn$;
-- +goose StatementEnd

-- Restores 0064's body (no 'engage' scope).
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION purge_tenant_data(p_tenant uuid, p_scopes text[])
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  total bigint := 0;
  n     bigint;
  s     text[] := p_scopes;
  drop_tenant boolean := 'everything' = ANY(p_scopes);
BEGIN
  IF drop_tenant THEN
    s := ARRAY['logs','transactions','menu','tables','house_tabs','owners','inventory','staff'];
  END IF;

  IF ('menu' = ANY(s) OR 'tables' = ANY(s) OR 'house_tabs' = ANY(s) OR 'owners' = ANY(s))
     AND NOT ('transactions' = ANY(s)) THEN
    s := array_append(s, 'transactions');
  END IF;

  IF 'logs' = ANY(s) THEN
    DELETE FROM audit_events WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM audit_log    WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'transactions' = ANY(s) THEN
    DELETE FROM owner_cash_entries WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant AND (is_correction OR parent_loan_id IS NOT NULL); GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM owner_ledger WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM house_tab_settlements WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM orders WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM staff_pay WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM account_transfers WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM cash_drops WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM expenses WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM shifts WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'menu' = ANY(s) THEN
    DELETE FROM menu_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_categories WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_modifier_groups WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'tables' = ANY(s) THEN
    DELETE FROM service_tables WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'house_tabs' = ANY(s) THEN
    DELETE FROM house_tabs WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'owners' = ANY(s) THEN
    DELETE FROM cafe_owners WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'inventory' = ANY(s) THEN
    DELETE FROM modifier_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM menu_item_inventory_link WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    DELETE FROM inventory_items WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF 'staff' = ANY(s) THEN
    DELETE FROM staff WHERE tenant_id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  IF drop_tenant THEN
    DELETE FROM tenants WHERE id = p_tenant; GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  END IF;

  RETURN total;
END;
$fn$;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TABLE IF EXISTS engage_scans;
DROP TABLE IF EXISTS engage_contacts;
DROP TABLE IF EXISTS engage_redemptions;
DROP TABLE IF EXISTS engage_codes;
DROP TABLE IF EXISTS engage_sessions;
DROP TABLE IF EXISTS engage_tiers;
DROP TABLE IF EXISTS engage_campaigns;
-- +goose StatementEnd
