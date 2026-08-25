-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0068 — INSIGHTS: findings the café is told about, and what it decided.
--
-- THE SHAPE, AND WHY
--
-- A "finding" is one thing worth an owner's attention: a drawer that came up
-- short, an item selling below cost, books that can't be trusted yet. Detectors
-- (internal/insight) run nightly and produce them; the morning brief delivers
-- them; the owner dismisses, snoozes, or accepts one with a date to look again.
--
-- Two tables, and the split is the important decision:
--
--   insight_findings      ONE DURABLE ROW per open finding, identified by
--                         (tenant_id, detector_key, subject_kind, subject_key).
--   insight_observations  APPEND-ONLY, one row per finding per day, holding the
--                         numbers as they stood that day.
--
-- Not one row per finding per day. The lifecycle belongs to the finding's
-- IDENTITY, not to a day's instance of it: with a row-per-day you would have to
-- carry 'dismissed'/'snoozed' forward every night by copying yesterday's row,
-- and the first time that propagation is missed you re-nag someone who told you
-- to stop. With a durable row, dismissing is one UPDATE and it is terminal.
--
-- But the NUMBERS are per-day, and "did the number move since you accepted
-- this?" must be a QUERY, not a stored diff — a diff computed at accept time
-- freezes and is wrong the moment the detector runs again. Hence the child
-- table, and a join of the observation at accepted_on against the newest one.
--
-- WHAT IS NOT HERE
--
-- No 'muted' state. The rule is "three dismissals of a detector and that café
-- stops hearing about it", which is a COUNT over dismissed_at rather than a
-- flag — so it keeps working after a finding is closed, and one query explains
-- itself. dismissed_at is therefore never cleared, even once the row closes.
--
-- No task/assignee/priority columns. Follow-up is a property of the finding
-- (accepted_on + follow_up_on + note); nobody adopts a second task manager.
-- =========================================================================

CREATE TABLE insight_findings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Which rule fired. Matches insight.Detector.Key; the registry lint test
  -- keeps the Go side unique, and nothing here constrains it to a list so a
  -- new detector needs no migration.
  detector_key   text NOT NULL,

  -- What it is ABOUT. subject_key is a uuid-as-text for a menu item / category
  -- / shift, or '' when the finding is about the café as a whole (books
  -- confidence, unallocated expenses). Text rather than uuid precisely so
  -- tenant-wide findings need no sentinel uuid.
  subject_kind   text NOT NULL CHECK (subject_kind IN
                   ('tenant','menu_item','menu_category','shift','house_tab','user','inventory_item')),
  subject_key    text NOT NULL DEFAULT '',
  -- Frozen name, so an email written tonight still reads correctly after the
  -- item is renamed or deleted.
  subject_label  text NOT NULL DEFAULT '',

  -- Mirrors health.Grade's warn/bad. There is no 'good' and no 'na': a detector
  -- with nothing to say returns no finding at all, so a row here always means
  -- something needs attention.
  severity       text NOT NULL CHECK (severity IN ('warn','bad')),
  deep_link      text NOT NULL DEFAULT '',

  state          text NOT NULL DEFAULT 'new'
                   CHECK (state IN ('new','seen','snoozed','dismissed','accepted','closed')),
  first_seen_on  date NOT NULL,
  last_seen_on   date NOT NULL,

  seen_at        timestamptz,
  snoozed_until  date,
  -- Never cleared, including once state becomes 'closed' — it is the input to
  -- the per-detector mute count.
  dismissed_at   timestamptz,

  accepted_at         timestamptz,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The observation day the owner accepted AGAINST. This is what makes "did the
  -- number move" a join rather than a remembered delta.
  accepted_on         date,
  follow_up_on        date,
  note                text NOT NULL DEFAULT '',

  -- Set when the detector stops firing for this subject: the problem went away.
  closed_at      timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Each terminal state is either fully stamped or absent, never half-recorded.
  -- Same discipline as house_tab_settlements' reversal_complete (0054).
  CONSTRAINT insight_findings_snooze_complete
    CHECK (state <> 'snoozed' OR snoozed_until IS NOT NULL),
  CONSTRAINT insight_findings_accept_complete
    CHECK (state <> 'accepted' OR (accepted_at IS NOT NULL
                                   AND accepted_on IS NOT NULL
                                   AND follow_up_on IS NOT NULL)),
  CONSTRAINT insight_findings_dismiss_complete
    CHECK (state <> 'dismissed' OR dismissed_at IS NOT NULL),
  CONSTRAINT insight_findings_seen_range
    CHECK (last_seen_on >= first_seen_on)
);

-- One OPEN finding per subject. Closed rows are excluded, so a problem that
-- genuinely comes back six months later gets a fresh row and a fresh lifecycle
-- rather than reopening an argument the owner already settled.
CREATE UNIQUE INDEX insight_findings_open_uniq
  ON insight_findings (tenant_id, detector_key, subject_kind, subject_key)
  WHERE state <> 'closed';

-- The brief and the findings page: what is open, worst first.
CREATE INDEX insight_findings_open_idx
  ON insight_findings (tenant_id, severity, last_seen_on DESC)
  WHERE state IN ('new','seen','snoozed','accepted');
-- Follow-ups coming due.
CREATE INDEX insight_findings_followup_idx
  ON insight_findings (tenant_id, follow_up_on)
  WHERE state = 'accepted';
-- The mute count.
CREATE INDEX insight_findings_dismissed_idx
  ON insight_findings (tenant_id, detector_key)
  WHERE dismissed_at IS NOT NULL;

CREATE TRIGGER insight_findings_updated_at BEFORE UPDATE ON insight_findings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE insight_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY insight_findings_isolation ON insight_findings
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON insight_findings TO app;

-- =========================================================================

CREATE TABLE insight_observations (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  finding_id     uuid NOT NULL REFERENCES insight_findings(id) ON DELETE CASCADE,
  -- The café's LOCAL date, so a brief for "yesterday" means yesterday there.
  day            date NOT NULL,

  severity       text NOT NULL CHECK (severity IN ('warn','bad')),
  -- The one number this finding is about, in metric_unit. Kept as numeric
  -- rather than bigint because ratios and fractional quantities (half plates)
  -- both land here.
  metric_value   numeric NOT NULL,
  -- NULL means there was no baseline to compare against — the GradeNA case from
  -- health.gradeVolume, preserved rather than papered over with a zero.
  baseline_value numeric,
  metric_unit    text NOT NULL CHECK (metric_unit IN ('cents','count','ratio','days','minutes')),

  -- The deterministic sentence, verbatim, as it was rendered that day. Stored
  -- because the brief is a historical record: re-deriving the wording later
  -- from changed thresholds would rewrite what the owner was actually told.
  detail         text NOT NULL,
  -- Supporting numbers for the renderer and the evidence view. Same role as
  -- tenant_health_daily.signals.
  facts          jsonb NOT NULL DEFAULT '{}',

  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (finding_id, day)
);

CREATE INDEX insight_observations_tenant_day_idx
  ON insight_observations (tenant_id, day DESC);

ALTER TABLE insight_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY insight_observations_isolation ON insight_observations
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: an observation is what the café was told on a given day. It leaves
-- only with its finding or its tenant. UPDATE is granted for the nightly
-- re-run's ON CONFLICT (a detector may run twice in one local day).
GRANT SELECT, INSERT, UPDATE ON insight_observations TO app;

-- =========================================================================
-- tenant_integrity_check() — the owner-facing half of platform_accuracy_check.
--
-- 0056 built these invariants for the /super console and had to make them
-- SECURITY DEFINER, because /super has no tenant context and RLS would return
-- nothing; the function self-gates on is_platform_admin(). That makes it
-- unusable from a tenant-scoped job, which is where the café's own findings
-- come from.
--
-- This is the same arithmetic with the gate REMOVED instead of inverted: plain
-- SQL, no DEFINER, so every table it touches is already confined to one café by
-- its own RLS policy and the caller sees exactly their own books. Keeping it in
-- SQL rather than porting it into Go is deliberate — these are invariants OVER
-- THE SCHEMA and they belong beside it, versioned with it.
--
-- Only the checks an owner can act on are carried over. The two add-on fold
-- checks from 0062 are left out on purpose: they detect a bug in our own
-- price-folding, not a mistake at the till, and telling a café to go fix our
-- arithmetic is not an insight. They stay a platform concern.
--
-- Returns raw numbers. The human sentence is rendered in Go (insight/render.go)
-- so wording, money formatting and translation live in one place.
-- =========================================================================

CREATE OR REPLACE FUNCTION tenant_integrity_check()
RETURNS TABLE (
  check_key   text,
  entity      text,
  entity_id   uuid,
  delta_cents bigint,
  occurred_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- total_cents must reconcile with its own components.
  SELECT 'order_arithmetic', 'order', o.id,
         o.total_cents - (o.subtotal_cents - o.discount_cents + o.service_charge_cents),
         o.closed_at
  FROM orders o
  WHERE o.status = 'closed'
    AND o.total_cents NOT IN (
      o.subtotal_cents - o.discount_cents + o.service_charge_cents,
      o.subtotal_cents - o.discount_cents + o.service_charge_cents + o.tax_cents
    )

  UNION ALL
  -- A closed order's payments must equal its total.
  SELECT 'payments_vs_total', 'order', o.id, p.paid - o.total_cents, o.closed_at
  FROM orders o
  JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents), 0)::bigint AS paid
    FROM payments WHERE order_id = o.id
  ) p ON true
  WHERE o.status = 'closed' AND p.paid <> o.total_cents

  UNION ALL
  -- Lines voided after the order closed: the frozen total kept the line, every
  -- line-level aggregate dropped it.
  SELECT 'post_close_void', 'order_item', oi.id,
         (oi.qty * oi.unit_price_cents)::bigint, oi.voided_at
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status = 'closed' AND o.closed_at IS NOT NULL
    AND oi.voided_at IS NOT NULL AND oi.voided_at > o.closed_at

  UNION ALL
  -- A credit charge that belongs to no credit account.
  SELECT 'credit_without_tab', 'payment', p.id, p.amount_cents, p.recorded_at
  FROM payments p
  WHERE p.method = 'house_tab' AND p.house_tab_id IS NULL

  UNION ALL
  -- Over-collected credit account: more collected than was ever charged.
  SELECT 'negative_tab', 'house_tab', ht.id, b.charged - b.settled, ht.created_at
  FROM house_tabs ht
  JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(amount_cents) FROM payments
                WHERE house_tab_id = ht.id AND method = 'house_tab'), 0)::bigint AS charged,
      COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
                WHERE house_tab_id = ht.id AND reversed_at IS NULL), 0)::bigint AS settled
  ) b ON true
  WHERE ht.deleted_at IS NULL AND b.charged - b.settled < 0

  UNION ALL
  -- Cash that no drawer count can ever see.
  SELECT 'cash_without_shift', 'payment', p.id, p.amount_cents, p.recorded_at
  FROM payments p
  WHERE p.method = 'cash' AND p.shift_id IS NULL

  UNION ALL
  -- Half-recorded reversal.
  SELECT 'reversal_incomplete', 'house_tab_settlement', s.id, s.amount_cents, s.reversed_at
  FROM house_tab_settlements s
  WHERE s.reversed_at IS NOT NULL AND s.reversed_by_user_id IS NULL

  UNION ALL
  -- A closed shift whose stamped expected cash no longer matches its rows.
  SELECT 'shift_expected_cash', 'shift', sh.id,
         sh.expected_cash_cents - r.expected, sh.closed_at
  FROM shifts sh
  JOIN LATERAL (
    SELECT (sh.opening_float_cents
      + COALESCE((SELECT SUM(amount_cents) FROM payments
                  WHERE shift_id = sh.id AND method = 'cash'), 0)
      + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
                  WHERE shift_id = sh.id AND payment_method = 'cash'
                    AND reversed_at IS NULL), 0)
      + COALESCE((SELECT SUM(amount_cents) FROM cash_drops
                  WHERE shift_id = sh.id AND direction = 'in'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM cash_drops
                  WHERE shift_id = sh.id AND direction = 'out'), 0))::bigint AS expected
  ) r ON true
  WHERE sh.closed_at IS NOT NULL AND sh.expected_cash_cents IS NOT NULL
    AND sh.expected_cash_cents <> r.expected

  UNION ALL
  -- A drawer-paid expense that never moved the drawer.
  SELECT 'drawer_expense_unlinked', 'expense', e.id, e.amount_cents, e.paid_at
  FROM expenses e
  WHERE e.deleted_at IS NULL AND e.paid_from = 'drawer'
    AND NOT EXISTS (SELECT 1 FROM cash_drops d WHERE d.expense_id = e.id)

  ORDER BY 1, 3
$$;

REVOKE ALL ON FUNCTION tenant_integrity_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_integrity_check() TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP FUNCTION IF EXISTS tenant_integrity_check();
DROP TABLE IF EXISTS insight_observations;
DROP TABLE IF EXISTS insight_findings;

-- +goose StatementEnd
