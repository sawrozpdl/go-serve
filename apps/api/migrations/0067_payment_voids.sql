-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0067 — payments can no longer vanish without trace.
--
-- THE HOLE
--
-- 0004 created payments with the header comment "Append-only ledger of money
-- received against an order" and then granted DELETE on it. Both were true:
-- DeletePayment (internal/api/payments.go) uses it to undo a wrong-method or
-- overpaid entry, and it is guarded — the ORDER must still be open and the
-- payment's SHIFT must still be open, so a signed-off reconciliation can never
-- be silently invalidated.
--
-- What was missing is the trace. A deleted payment left NO row anywhere:
-- audit_log is DefaultOff since 0051 and empty for any café provisioned after
-- it, so "money was rung up and then un-rung" was an unanswerable question. For
-- a product whose pitch is that nothing walks out unnoticed, that is the one
-- table where a silent delete path is unacceptable.
--
-- WHY A TOMBSTONE TABLE AND NOT 0054's SHAPE
--
-- 0054 made house_tab_settlements reversible the other way: a nullable
-- reversed_at on the same table, with every roll-up filtering it. That was the
-- right call there — a reversal is a business event the customer's tab ledger
-- should keep showing, and the table had a handful of readers.
--
-- payments has TWENTY-NINE read sites across reports, shifts, history, money,
-- house_tabs, finance and orders, plus platform_accuracy_check() (0056) and
-- platform_accuracy_check_addons (0062), which assert money invariants over it.
-- Adding a nullable flag would mean twenty-nine hand edits where every MISS is a
-- silent bug that OVERSTATES revenue, and would make the invariant functions
-- start reporting violations until they were updated too.
--
-- So the row moves instead of being flagged. Consequences, all deliberate:
--
--   * Every existing aggregate is correct with zero changes. A retracted
--     payment is simply not in `payments`, exactly as before this migration.
--   * The trace is guaranteed by the DATABASE, not by handler discipline. A
--     future code path that deletes a payment cannot forget to record it.
--   * payment_voids gets SELECT + INSERT only. There is no grant that can
--     scrub the trace afterwards.
--
-- It is also the honest model. A settlement reversal is a business event; a
-- pre-close payment undo is an INPUT CORRECTION — from the café's point of
-- view that payment never happened. "Entered and retracted" is a different
-- fact from "is a payment, but flagged".
--
-- WHAT DOES NOT GET A TOMBSTONE, AND WHY THAT IS NOT A LOOPHOLE
--
-- The trigger records only deletes that carry a matching tenant context, i.e.
-- ones that came through the tenant-scoped API (db.TxMiddleware sets
-- app.tenant_id / app.user_id tx-locally for every /v1 request). The
-- super-admin destructive paths — purge_tenant_data (0036/0064),
-- delete_tenant_cascade (0035), clone_tenant_data (0063) — run under /super,
-- which mounts TxMiddleware with app.user_id ONLY and no tenant, so they skip.
--
-- That is the boundary we want. Those operations are wholesale, deliberate, and
-- already recorded in platform_audit; writing millions of tombstones for a
-- tenant we are erasing would be noise. The vector this migration closes is a
-- single payment quietly disappearing from a live café, and that always runs
-- with tenant context.
--
-- Cleanup needs no changes anywhere: order_id cascades (purge deletes orders,
-- which takes the tombstones with it) and tenant_id cascades (tenant deletion).
-- payment_voids is intentionally absent from clone_tenant_data's table list, so
-- a QA clone starts with no retraction history.
-- =========================================================================

CREATE TABLE payment_voids (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The retracted payment's own id. NOT a foreign key: the row it named is
  -- gone, which is the whole point of this table.
  payment_id          uuid NOT NULL,

  -- Snapshot of the payment exactly as it stood. Frozen rather than joined so
  -- the trace survives and reads without touching anything else.
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shift_id            uuid,
  method              payment_method NOT NULL,
  amount_cents        bigint NOT NULL,
  reference_no        text NOT NULL DEFAULT '',
  house_tab_id        uuid,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at         timestamptz NOT NULL,

  -- Who retracted it, and when.
  voided_by_user_id   uuid NOT NULL REFERENCES users(id),
  voided_at           timestamptz NOT NULL DEFAULT now(),

  -- Optional free text. DeletePayment takes no body today, so this is normally
  -- ''. The handler can start collecting a reason by setting the
  -- 'app.void_reason' GUC before the delete — no migration needed.
  reason              text NOT NULL DEFAULT ''
);

-- The detector query: retractions for this café over a window, newest first.
CREATE INDEX payment_voids_tenant_voided_idx
  ON payment_voids(tenant_id, voided_at DESC);
-- "was a payment removed from this order?"
CREATE INDEX payment_voids_order_idx ON payment_voids(order_id);
-- "who has been retracting payments?" — the concentration signal.
CREATE INDEX payment_voids_actor_idx
  ON payment_voids(tenant_id, voided_by_user_id, voided_at DESC);

ALTER TABLE payment_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_voids_isolation ON payment_voids
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- SELECT + INSERT only, deliberately. No UPDATE and no DELETE means the trace
-- cannot be edited or scrubbed by anything the app can do; it leaves only when
-- its order or its tenant does.
GRANT SELECT, INSERT ON payment_voids TO app;

-- =========================================================================
-- The trigger. BEFORE DELETE so the tombstone is written inside the same
-- transaction as the delete: either both land or neither does.
-- =========================================================================

CREATE OR REPLACE FUNCTION record_payment_void() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Only application deletes, which always carry both GUCs. The tenant match
  -- is what excludes the SECURITY DEFINER purge/cascade/clone paths (they run
  -- with no app.tenant_id at all) — see this migration's header.
  IF current_tenant_id() IS NULL
     OR current_user_id() IS NULL
     OR current_tenant_id() <> OLD.tenant_id THEN
    RETURN OLD;
  END IF;

  INSERT INTO payment_voids (
    tenant_id, payment_id, order_id, shift_id, method, amount_cents,
    reference_no, house_tab_id, recorded_by_user_id, recorded_at,
    voided_by_user_id, reason
  ) VALUES (
    OLD.tenant_id, OLD.id, OLD.order_id, OLD.shift_id, OLD.method,
    OLD.amount_cents, OLD.reference_no, OLD.house_tab_id,
    OLD.recorded_by_user_id, OLD.recorded_at,
    current_user_id(),
    COALESCE(NULLIF(current_setting('app.void_reason', true), ''), '')
  );
  RETURN OLD;
END
$fn$;

CREATE TRIGGER payments_record_void
  BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION record_payment_void();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TRIGGER IF EXISTS payments_record_void ON payments;
DROP FUNCTION IF EXISTS record_payment_void();
DROP TABLE IF EXISTS payment_voids;

-- +goose StatementEnd
