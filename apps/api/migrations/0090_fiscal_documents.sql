-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0090 — IRD fiscal documents: invoices, order slips, gap-free numbering, and
-- the immutability that makes them evidence.
--
-- Only a café in fiscal mode (0089) gets these rows. For everyone else the
-- tables stay empty and nothing changes.
--
-- WHAT AN INVOICE IS
-- A frozen snapshot, written inside CloseOrder's transaction, of everything an
-- IRD bill states: number, fiscal year, issue time (server clock), BS date,
-- the seller block as it was that day, the buyer, the IRD amount breakdown,
-- the lines, the payment method and who issued it. Nothing on it is ever
-- recomputed from live tables: menu names, prices, the café's address and the
-- cashier's name can all change later and the bill must not.
--
-- Status that DOES change — printed or not, reported to CBMS or not, still
-- active or cancelled — lives in its own append-only tables (print_log in
-- P2, cbms_submissions in P3, credit_notes in P4) and is derived by joins. So
-- an invoice row is written once and never updated, and the trigger below can
-- refuse every UPDATE and DELETE without exceptions.
--
-- THE AMOUNTS (paisa, bigint, like the rest of the money model)
--   gross_cents      Amount before discount, excluding VAT     (Annex 5 Amount)
--   discount_cents   Discount, excluding VAT                   (Annex 5 Discount)
--   taxable_cents    VAT-taxable value                         (Taxable_Amount)
--   non_taxable_cents Value outside VAT — a PAN-only café's sales, or exempt
--   vat_cents        VAT                                       (Tax_Amount)
--   total_cents      What the customer paid                    (Total_Amount)
-- and the database insists the books balance:
--   gross − discount = taxable + non_taxable, total = taxable + non_taxable + vat
-- and that the invoice agrees with the order it bills (the trigger below):
--   total_cents = orders.total_cents, vat_cents = orders.tax_cents.
--
-- NUMBERING (procedure §6.2(ख)(ग))
-- fiscal_sequences holds the next number per (tenant, document type, fiscal
-- year). The issuing transaction takes the row with FOR UPDATE, uses it and
-- increments it, so the number is consumed only if the bill commits: a rolled
-- back settle leaves no gap. The trigger lets next_value move forward by
-- exactly one and nothing else. A branch's outlet code (0089) is printed in
-- front of the number, which keeps (PAN, FY, number) unique at CBMS across the
-- branches of one business.
--
-- ORDER SLIPS (§6.2(घ) — hotels and restaurants)
-- Each send-to-kitchen of a fiscal café records one numbered slip with the
-- lines it carried. Slips and invoice share the order, which is the link the
-- procedure asks for.
--
-- THE ORDER BEHIND AN INVOICE IS FROZEN TOO
-- Once an order has an invoice, its row, lines, discounts and payments refuse
-- change. Two exceptions, both outside the bill: the kitchen may keep moving a
-- line through ready/served after the guest has paid, and a user reference may
-- be nulled when that user is erased (personal data); the invoice keeps the
-- issuer's name as text.
--
-- DELETION
-- Every foreign key into these tables is ON DELETE RESTRICT, and the
-- triggers refuse DELETE outright. A tenant that ever issued an invoice can
-- therefore not be purged, cloned over, or cascaded away — which is the point
-- (§6.3(घ), §11(च)). Test teardown is the only place that switches triggers
-- off (session_replication_role = replica, superuser only).
-- =========================================================================

-- -------------------------------------------------------------------------
-- The generic refusal used by every fiscal table.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fiscal_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued IRD records cannot be changed or deleted (%) / जारी भइसकेको बीजक अभिलेख परिवर्तन वा मेटाउन मिल्दैन', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation', HINT = 'fiscal_immutable';
END;
$$;

-- -------------------------------------------------------------------------
-- Sequences
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fiscal_sequences (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  doc_type    text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note', 'reversal', 'order_slip', 'purchase_return')),
  fiscal_year text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}/[0-9]{2}$'),
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, doc_type, fiscal_year)
);

ALTER TABLE fiscal_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_sequences_isolation ON fiscal_sequences;
CREATE POLICY fiscal_sequences_isolation ON fiscal_sequences
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON fiscal_sequences TO app;

CREATE OR REPLACE FUNCTION fiscal_sequences_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fiscal number series cannot be deleted' USING ERRCODE = 'restrict_violation', HINT = 'fiscal_immutable';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.doc_type <> OLD.doc_type OR NEW.fiscal_year <> OLD.fiscal_year
     OR NEW.created_at <> OLD.created_at OR NEW.next_value <> OLD.next_value + 1 THEN
    RAISE EXCEPTION 'a fiscal number series only moves forward by one' USING ERRCODE = 'check_violation', HINT = 'fiscal_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fiscal_sequences_guard ON fiscal_sequences;
CREATE TRIGGER fiscal_sequences_guard
  BEFORE UPDATE OR DELETE ON fiscal_sequences
  FOR EACH ROW EXECUTE FUNCTION fiscal_sequences_guard();

-- -------------------------------------------------------------------------
-- Invoices
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- 'tax_invoice' (VAT café) or 'invoice' (PAN-only café).
  kind               text NOT NULL CHECK (kind IN ('tax_invoice', 'invoice')),
  fiscal_year        text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}/[0-9]{2}$'),
  seq                bigint NOT NULL CHECK (seq >= 1),
  number             text NOT NULL,
  issued_at          timestamptz NOT NULL,
  bs_date            text NOT NULL CHECK (bs_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ad_date            date NOT NULL,

  -- Seller block as printed (snapshot of fiscal_profiles at issue).
  seller_pan         text NOT NULL CHECK (seller_pan ~ '^[0-9]{9}$'),
  seller_name        text NOT NULL,
  seller_name_ne     text NOT NULL DEFAULT '',
  seller_address     text NOT NULL,
  seller_phone       text NOT NULL DEFAULT '',
  outlet_code        text NOT NULL DEFAULT '',

  -- Buyer (optional for a walk-in guest).
  buyer_name         text NOT NULL DEFAULT '',
  buyer_pan          text NOT NULL DEFAULT '' CHECK (buyer_pan = '' OR buyer_pan ~ '^[0-9]{9}$'),
  buyer_address      text NOT NULL DEFAULT '',

  gross_cents        bigint NOT NULL CHECK (gross_cents >= 0),
  discount_cents     bigint NOT NULL CHECK (discount_cents >= 0),
  taxable_cents      bigint NOT NULL CHECK (taxable_cents >= 0),
  non_taxable_cents  bigint NOT NULL CHECK (non_taxable_cents >= 0),
  vat_cents          bigint NOT NULL CHECK (vat_cents >= 0),
  total_cents        bigint NOT NULL CHECK (total_cents >= 0),
  vat_rate           numeric(5,2) NOT NULL,

  -- Annex 6 wording: Cash / Cheque / Credit / Other (comma-joined if split).
  payment_method     text NOT NULL,
  -- Electronic payment references, for Annex 5 Transaction_Id.
  transaction_id     text NOT NULL DEFAULT '',

  issued_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name     text NOT NULL,
  software_version   text NOT NULL,
  qr_payload         text NOT NULL,
  -- sha256 of the canonical invoice content (fiscal.ContentHash).
  content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (order_id),
  UNIQUE (tenant_id, fiscal_year, seq),
  UNIQUE (tenant_id, fiscal_year, number),
  CHECK (gross_cents - discount_cents = taxable_cents + non_taxable_cents),
  CHECK (total_cents = taxable_cents + non_taxable_cents + vat_cents),
  CHECK (kind = 'tax_invoice' OR (vat_cents = 0 AND taxable_cents = 0))
);

CREATE INDEX IF NOT EXISTS invoices_issued_idx ON invoices (tenant_id, issued_at);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_isolation ON invoices;
CREATE POLICY invoices_isolation ON invoices
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON invoices TO app;

-- An invoice may only be issued by a fiscal café, for a closed order of the
-- same tenant whose stamped totals it repeats exactly.
CREATE OR REPLACE FUNCTION invoices_issue_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o record;
BEGIN
  IF NOT tenant_fiscal_mode(NEW.tenant_id) THEN
    RAISE EXCEPTION 'invoices are issued only by a café in IRD fiscal mode' USING ERRCODE = 'check_violation';
  END IF;
  SELECT tenant_id, status, total_cents, tax_cents INTO o FROM orders WHERE id = NEW.order_id;
  IF o.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'invoice and order belong to different tenants' USING ERRCODE = 'check_violation';
  END IF;
  IF o.status <> 'closed' THEN
    RAISE EXCEPTION 'an invoice is issued only for a closed order (order is %)', o.status USING ERRCODE = 'check_violation';
  END IF;
  IF o.total_cents <> NEW.total_cents OR o.tax_cents <> NEW.vat_cents THEN
    RAISE EXCEPTION 'invoice totals (% / VAT %) differ from the order (% / VAT %)',
      NEW.total_cents, NEW.vat_cents, o.total_cents, o.tax_cents USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS invoices_issue_guard ON invoices;
CREATE TRIGGER invoices_issue_guard
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_issue_guard();

DROP TRIGGER IF EXISTS invoices_immutable ON invoices;
CREATE TRIGGER invoices_immutable
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

CREATE TABLE IF NOT EXISTS invoice_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  line_no          int NOT NULL CHECK (line_no >= 1),
  order_item_id    uuid REFERENCES order_items(id) ON DELETE RESTRICT,
  description      text NOT NULL,
  qty              numeric(6,2) NOT NULL CHECK (qty > 0),
  -- As charged: VAT-inclusive for a VAT café (menu price, Rule 14ख).
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (invoice_id, line_no)
);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_lines_isolation ON invoice_lines;
CREATE POLICY invoice_lines_isolation ON invoice_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON invoice_lines TO app;

DROP TRIGGER IF EXISTS invoice_lines_immutable ON invoice_lines;
CREATE TRIGGER invoice_lines_immutable
  BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- -------------------------------------------------------------------------
-- Order slips (KOT)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_slips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  fiscal_year   text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}/[0-9]{2}$'),
  seq           bigint NOT NULL CHECK (seq >= 1),
  number        text NOT NULL,
  sent_at       timestamptz NOT NULL,
  bs_date       text NOT NULL,
  sent_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_by_name  text NOT NULL,
  -- [{order_item_id, name, qty, notes, outlet_id}]
  lines         jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_year, seq)
);

CREATE INDEX IF NOT EXISTS order_slips_order_idx ON order_slips (tenant_id, order_id);

ALTER TABLE order_slips ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_slips FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_slips_isolation ON order_slips;
CREATE POLICY order_slips_isolation ON order_slips
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON order_slips TO app;

DROP TRIGGER IF EXISTS order_slips_immutable ON order_slips;
CREATE TRIGGER order_slips_immutable
  BEFORE UPDATE OR DELETE ON order_slips
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- -------------------------------------------------------------------------
-- Freeze the order behind an invoice.
-- -------------------------------------------------------------------------

-- Columns that may still move on an invoiced order's lines: the kitchen's own
-- progress (a paid guest's dish can still be marked ready/served), and
-- updated_at, which set_updated_at() bumps on any write.
CREATE OR REPLACE FUNCTION fiscal_row_diff(old_row jsonb, new_row jsonb, allowed text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(k ORDER BY k), '{}')
  FROM jsonb_object_keys(old_row) AS k
  WHERE NOT (k = ANY (allowed))
    AND old_row -> k IS DISTINCT FROM new_row -> k
    -- Erasing a person (user FK → NULL) is allowed; the invoice keeps names as text.
    AND NOT (k LIKE '%user_id' AND new_row -> k = 'null'::jsonb)
$$;

-- SECURITY DEFINER so the invoice lookup sees through RLS: a write that runs
-- without the tenant GUC (a job, a maintenance session as the app role) must
-- not slip past the freeze just because it cannot see the invoice.
CREATE OR REPLACE FUNCTION fiscal_guard_invoiced_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order uuid;
  v_changed text[];
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    v_order := OLD.id;
  ELSIF TG_TABLE_NAME = 'order_item_modifiers' THEN
    SELECT order_id INTO v_order FROM order_items WHERE id = OLD.order_item_id;
  ELSE
    v_order := OLD.order_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = v_order) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'this bill has an IRD invoice and cannot be deleted (%) / बीजक जारी भइसकेको छ', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation', HINT = 'fiscal_immutable';
  END IF;

  v_changed := fiscal_row_diff(
    to_jsonb(OLD), to_jsonb(NEW),
    CASE TG_TABLE_NAME
      WHEN 'order_items' THEN ARRAY['kitchen_status', 'sent_to_kitchen_at', 'ready_at', 'served_at', 'outlet_id', 'updated_at']
      ELSE ARRAY['updated_at']
    END);
  IF cardinality(v_changed) > 0 THEN
    RAISE EXCEPTION 'this bill has an IRD invoice and cannot be changed (% : %) / बीजक जारी भइसकेको छ', TG_TABLE_NAME, array_to_string(v_changed, ', ')
      USING ERRCODE = 'restrict_violation', HINT = 'fiscal_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_fiscal_freeze ON orders;
CREATE TRIGGER orders_fiscal_freeze
  BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION fiscal_guard_invoiced_order();

DROP TRIGGER IF EXISTS order_items_fiscal_freeze ON order_items;
CREATE TRIGGER order_items_fiscal_freeze
  BEFORE UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION fiscal_guard_invoiced_order();

DROP TRIGGER IF EXISTS order_adjustments_fiscal_freeze ON order_adjustments;
CREATE TRIGGER order_adjustments_fiscal_freeze
  BEFORE UPDATE OR DELETE ON order_adjustments
  FOR EACH ROW EXECUTE FUNCTION fiscal_guard_invoiced_order();

DROP TRIGGER IF EXISTS payments_fiscal_freeze ON payments;
CREATE TRIGGER payments_fiscal_freeze
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION fiscal_guard_invoiced_order();

DROP TRIGGER IF EXISTS order_item_modifiers_fiscal_freeze ON order_item_modifiers;
CREATE TRIGGER order_item_modifiers_fiscal_freeze
  BEFORE UPDATE OR DELETE ON order_item_modifiers
  FOR EACH ROW EXECUTE FUNCTION fiscal_guard_invoiced_order();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS order_item_modifiers_fiscal_freeze ON order_item_modifiers;
DROP TRIGGER IF EXISTS payments_fiscal_freeze ON payments;
DROP TRIGGER IF EXISTS order_adjustments_fiscal_freeze ON order_adjustments;
DROP TRIGGER IF EXISTS order_items_fiscal_freeze ON order_items;
DROP TRIGGER IF EXISTS orders_fiscal_freeze ON orders;
DROP FUNCTION IF EXISTS fiscal_guard_invoiced_order();
DROP FUNCTION IF EXISTS fiscal_row_diff(jsonb, jsonb, text[]);
DROP TABLE IF EXISTS order_slips;
DROP TABLE IF EXISTS invoice_lines;
DROP TABLE IF EXISTS invoices;
DROP FUNCTION IF EXISTS invoices_issue_guard();
DROP TABLE IF EXISTS fiscal_sequences;
DROP FUNCTION IF EXISTS fiscal_sequences_guard();
DROP FUNCTION IF EXISTS fiscal_forbid_mutation();
-- +goose StatementEnd
