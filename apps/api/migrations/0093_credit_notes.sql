-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0093 — Corrections to issued IRD invoices: sales returns and reverse
-- entries, and the money they give back.
--
-- An issued invoice is never edited or deleted (0090). Procedure 2082
-- §6.2(ज) gives two ways to correct one, each with a reason and each in its
-- own register:
--
--   reversal      (उल्टो प्रविष्टि / Reverse Entry) — "immediate cancellation":
--                 the whole bill, the same BS day it was issued, nothing
--                 corrected before. Numbered RE-n.
--   sales_return  (बिक्री फिर्ता / Sales Return, a credit note under VAT
--                 Rule 20) — all or part of the bill, any later day. CN-n.
--
-- Both are reported to CBMS through /api/billreturn and both drive
-- Is_bill_Active in the Standard View (false once the bill is fully
-- credited). They share one table because they share every column; kind and
-- the separate number series keep the two registers apart.
--
-- AMOUNTS mirror invoices (same CHECKs), positive numbers that SUBTRACT from
-- the invoice. The database refuses crediting more than was billed, per bill
-- (trigger) and per line (trigger on credit_note_lines).
--
-- REFUNDS are the money side and live in their own table:
--   cash    → also a cash_drops 'out' row in the open shift, so the drawer's
--             expected cash and the cash account balance fall by it with no
--             change to either calculation;
--   online  → subtracted from the online account (loadAccountBucket);
--   credit  → the bill went on a house tab: a write-off row on that tab
--             lowers what the guest owes (no money moves);
--   none    → nothing to give back (e.g. a fully discounted bill).
-- =========================================================================

CREATE TABLE IF NOT EXISTS credit_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id         uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('sales_return', 'reversal')),
  fiscal_year        text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}/[0-9]{2}$'),
  seq                bigint NOT NULL CHECK (seq >= 1),
  number             text NOT NULL,
  issued_at          timestamptz NOT NULL,
  bs_date            text NOT NULL CHECK (bs_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ad_date            date NOT NULL,
  reason             text NOT NULL CHECK (length(btrim(reason)) > 0),

  seller_pan         text NOT NULL,
  seller_name        text NOT NULL,
  seller_address     text NOT NULL,
  buyer_name         text NOT NULL DEFAULT '',
  buyer_pan          text NOT NULL DEFAULT '',

  gross_cents        bigint NOT NULL CHECK (gross_cents >= 0),
  discount_cents     bigint NOT NULL CHECK (discount_cents >= 0),
  taxable_cents      bigint NOT NULL CHECK (taxable_cents >= 0),
  non_taxable_cents  bigint NOT NULL CHECK (non_taxable_cents >= 0),
  vat_cents          bigint NOT NULL CHECK (vat_cents >= 0),
  total_cents        bigint NOT NULL CHECK (total_cents > 0),

  refund_method      text NOT NULL CHECK (refund_method IN ('cash', 'online', 'credit', 'none')),
  issued_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name     text NOT NULL,
  software_version   text NOT NULL,
  qr_payload         text NOT NULL,
  content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, fiscal_year, number),
  CHECK (gross_cents - discount_cents = taxable_cents + non_taxable_cents),
  CHECK (total_cents = taxable_cents + non_taxable_cents + vat_cents)
);

CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx ON credit_notes (invoice_id);
CREATE INDEX IF NOT EXISTS credit_notes_issued_idx ON credit_notes (tenant_id, issued_at);

ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_notes_isolation ON credit_notes;
CREATE POLICY credit_notes_isolation ON credit_notes
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON credit_notes TO app;

DROP TRIGGER IF EXISTS credit_notes_immutable ON credit_notes;
CREATE TRIGGER credit_notes_immutable
  BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- Never credit more than was billed; a reversal is the whole bill, first and
-- only. SECURITY DEFINER so the check sees every earlier note through RLS.
CREATE OR REPLACE FUNCTION credit_notes_issue_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv record;
  prev record;
BEGIN
  -- Serialise notes against one invoice.
  PERFORM pg_advisory_xact_lock(hashtextextended('credit_note:' || NEW.invoice_id::text, 0));
  SELECT tenant_id, total_cents, vat_cents, taxable_cents, non_taxable_cents INTO inv
  FROM invoices WHERE id = NEW.invoice_id;
  IF inv.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'credit note and invoice belong to different tenants' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) AS n, COALESCE(sum(total_cents), 0) AS total, COALESCE(sum(vat_cents), 0) AS vat
  INTO prev FROM credit_notes WHERE invoice_id = NEW.invoice_id;
  IF prev.total + NEW.total_cents > inv.total_cents OR prev.vat + NEW.vat_cents > inv.vat_cents THEN
    RAISE EXCEPTION 'credit notes would exceed the invoice (already credited %, invoice %)', prev.total, inv.total_cents
      USING ERRCODE = 'check_violation', HINT = 'fiscal_over_credit';
  END IF;
  IF NEW.kind = 'reversal' AND (prev.n > 0 OR NEW.total_cents <> inv.total_cents) THEN
    RAISE EXCEPTION 'a reverse entry cancels the whole bill and only a bill not corrected before'
      USING ERRCODE = 'check_violation', HINT = 'fiscal_reversal_whole';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS credit_notes_issue_guard ON credit_notes;
CREATE TRIGGER credit_notes_issue_guard
  BEFORE INSERT ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION credit_notes_issue_guard();

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  credit_note_id   uuid NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_line_id  uuid NOT NULL REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  line_no          int NOT NULL CHECK (line_no >= 1),
  description      text NOT NULL,
  qty              numeric(6,2) NOT NULL CHECK (qty > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (credit_note_id, line_no)
);

ALTER TABLE credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_note_lines_isolation ON credit_note_lines;
CREATE POLICY credit_note_lines_isolation ON credit_note_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON credit_note_lines TO app;

DROP TRIGGER IF EXISTS credit_note_lines_immutable ON credit_note_lines;
CREATE TRIGGER credit_note_lines_immutable
  BEFORE UPDATE OR DELETE ON credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

CREATE OR REPLACE FUNCTION credit_note_lines_qty_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  billed numeric;
  returned numeric;
BEGIN
  SELECT qty INTO billed FROM invoice_lines WHERE id = NEW.invoice_line_id;
  SELECT COALESCE(sum(qty), 0) INTO returned FROM credit_note_lines WHERE invoice_line_id = NEW.invoice_line_id;
  IF returned + NEW.qty > billed THEN
    RAISE EXCEPTION 'cannot return % of a line billed % (already returned %)', NEW.qty, billed, returned
      USING ERRCODE = 'check_violation', HINT = 'fiscal_over_credit';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS credit_note_lines_qty_guard ON credit_note_lines;
CREATE TRIGGER credit_note_lines_qty_guard
  BEFORE INSERT ON credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION credit_note_lines_qty_guard();

CREATE TABLE IF NOT EXISTS refunds (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  credit_note_id          uuid NOT NULL UNIQUE REFERENCES credit_notes(id) ON DELETE RESTRICT,
  method                  text NOT NULL CHECK (method IN ('cash', 'online', 'credit')),
  amount_cents            bigint NOT NULL CHECK (amount_cents > 0),
  shift_id                uuid REFERENCES shifts(id) ON DELETE RESTRICT,
  cash_drop_id            uuid REFERENCES cash_drops(id) ON DELETE RESTRICT,
  house_tab_settlement_id uuid REFERENCES house_tab_settlements(id) ON DELETE RESTRICT,
  reference_no            text NOT NULL DEFAULT '',
  recorded_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (method <> 'cash' OR (shift_id IS NOT NULL AND cash_drop_id IS NOT NULL)),
  CHECK (method <> 'credit' OR house_tab_settlement_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS refunds_tenant_idx ON refunds (tenant_id, recorded_at);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refunds_isolation ON refunds;
CREATE POLICY refunds_isolation ON refunds
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON refunds TO app;

DROP TRIGGER IF EXISTS refunds_immutable ON refunds;
CREATE TRIGGER refunds_immutable
  BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS refunds;
DROP TABLE IF EXISTS credit_note_lines;
DROP FUNCTION IF EXISTS credit_note_lines_qty_guard();
DROP TABLE IF EXISTS credit_notes;
DROP FUNCTION IF EXISTS credit_notes_issue_guard();
-- +goose StatementEnd
