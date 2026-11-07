-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0094 — Purchase side of the IRD registers: supplier bills and purchase
-- returns (procedure 2082 §6.3(क), Annex 6 §3 Purchase Book).
--
-- A café already records what it spends as expenses (0006 …). For a VAT café
-- the purchase register needs more than an expense says: the supplier's PAN,
-- the supplier's bill number and date, and the bill split into exempt,
-- taxable and VAT — separately for imports and capital goods. That detail
-- lives here, ONE purchase bill per expense, so the expense money model
-- (drawer, accounts, owner cash) is untouched: the expense still says what
-- left which account; the purchase bill says what the supplier billed.
--
-- A purchase bill is a record of a document someone else issued, so like our
-- own invoices it is never edited or deleted. The expense behind it cannot be
-- deleted either (trigger below) — a mistake is corrected with a purchase
-- return (the supplier's debit/credit note), numbered PR-n per fiscal year.
--
-- AMOUNTS (paisa): total = exempt + taxable + vat, and total must equal the
-- expense amount. The 13% VAT on the taxable part is checked by the API with a
-- small tolerance (suppliers round per line) and never silently "fixed".
-- =========================================================================

CREATE TABLE IF NOT EXISTS purchase_bills (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  expense_id             uuid NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  supplier_name          text NOT NULL CHECK (length(btrim(supplier_name)) > 0),
  -- '' = an unregistered supplier (allowed; such purchases carry no input VAT).
  supplier_pan           text NOT NULL DEFAULT '' CHECK (supplier_pan = '' OR supplier_pan ~ '^[0-9]{9}$'),
  supplier_bill_no       text NOT NULL CHECK (length(btrim(supplier_bill_no)) > 0),
  supplier_bill_date_bs  text NOT NULL CHECK (supplier_bill_date_bs ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  supplier_bill_date     date NOT NULL,
  fiscal_year            text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}/[0-9]{2}$'),
  is_import              boolean NOT NULL DEFAULT false,
  customs_declaration_no text NOT NULL DEFAULT '',
  is_capital             boolean NOT NULL DEFAULT false,
  total_cents            bigint NOT NULL CHECK (total_cents > 0),
  exempt_cents           bigint NOT NULL DEFAULT 0 CHECK (exempt_cents >= 0),
  taxable_cents          bigint NOT NULL DEFAULT 0 CHECK (taxable_cents >= 0),
  vat_cents              bigint NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
  recorded_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cents = exempt_cents + taxable_cents + vat_cents),
  CHECK (supplier_pan <> '' OR vat_cents = 0),
  CHECK (NOT is_import OR customs_declaration_no <> '')
);

-- The same supplier bill cannot be booked twice in a fiscal year.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_bills_supplier_bill_uniq
  ON purchase_bills (tenant_id, supplier_pan, supplier_bill_no, fiscal_year) WHERE supplier_pan <> '';
CREATE INDEX IF NOT EXISTS purchase_bills_date_idx ON purchase_bills (tenant_id, supplier_bill_date);

ALTER TABLE purchase_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_bills_isolation ON purchase_bills;
CREATE POLICY purchase_bills_isolation ON purchase_bills
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON purchase_bills TO app;

DROP TRIGGER IF EXISTS purchase_bills_immutable ON purchase_bills;
CREATE TRIGGER purchase_bills_immutable
  BEFORE UPDATE OR DELETE ON purchase_bills
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- The bill's total must equal its expense, and both belong to one tenant.
CREATE OR REPLACE FUNCTION purchase_bills_issue_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e record;
BEGIN
  SELECT tenant_id, amount_cents, deleted_at INTO e FROM expenses WHERE id = NEW.expense_id;
  IF e.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'purchase bill and expense belong to different tenants' USING ERRCODE = 'check_violation';
  END IF;
  IF e.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'the expense has been deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF e.amount_cents <> NEW.total_cents THEN
    RAISE EXCEPTION 'purchase bill total % differs from the expense amount %', NEW.total_cents, e.amount_cents
      USING ERRCODE = 'check_violation', HINT = 'fiscal_purchase_total';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS purchase_bills_issue_guard ON purchase_bills;
CREATE TRIGGER purchase_bills_issue_guard
  BEFORE INSERT ON purchase_bills
  FOR EACH ROW EXECUTE FUNCTION purchase_bills_issue_guard();

-- An expense that carries a purchase bill is part of the purchase register:
-- it may not be deleted (soft or hard) or have its amount changed.
CREATE OR REPLACE FUNCTION expenses_purchase_bill_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_bills WHERE expense_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE'
     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
     OR NEW.amount_cents <> OLD.amount_cents THEN
    RAISE EXCEPTION 'this expense is a supplier bill in the IRD purchase register — record a purchase return instead / खरिद खातामा परिसकेको बिल परिवर्तन गर्न मिल्दैन'
      USING ERRCODE = 'restrict_violation', HINT = 'fiscal_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS expenses_purchase_bill_guard ON expenses;
CREATE TRIGGER expenses_purchase_bill_guard
  BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION expenses_purchase_bill_guard();

CREATE TABLE IF NOT EXISTS purchase_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  purchase_bill_id  uuid NOT NULL REFERENCES purchase_bills(id) ON DELETE RESTRICT,
  fiscal_year       text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}/[0-9]{2}$'),
  seq               bigint NOT NULL CHECK (seq >= 1),
  number            text NOT NULL,
  return_date_bs    text NOT NULL CHECK (return_date_bs ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  return_date       date NOT NULL,
  -- The supplier's debit / credit note number for the return, if any.
  supplier_note_no  text NOT NULL DEFAULT '',
  reason            text NOT NULL CHECK (length(btrim(reason)) > 0),
  total_cents       bigint NOT NULL CHECK (total_cents > 0),
  exempt_cents      bigint NOT NULL DEFAULT 0 CHECK (exempt_cents >= 0),
  taxable_cents     bigint NOT NULL DEFAULT 0 CHECK (taxable_cents >= 0),
  vat_cents         bigint NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
  recorded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_year, seq),
  CHECK (total_cents = exempt_cents + taxable_cents + vat_cents)
);

ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_returns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_returns_isolation ON purchase_returns;
CREATE POLICY purchase_returns_isolation ON purchase_returns
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON purchase_returns TO app;

DROP TRIGGER IF EXISTS purchase_returns_immutable ON purchase_returns;
CREATE TRIGGER purchase_returns_immutable
  BEFORE UPDATE OR DELETE ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- Never return more than was bought, per amount column.
CREATE OR REPLACE FUNCTION purchase_returns_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b record; p record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase_return:' || NEW.purchase_bill_id::text, 0));
  SELECT tenant_id, total_cents, exempt_cents, taxable_cents, vat_cents INTO b FROM purchase_bills WHERE id = NEW.purchase_bill_id;
  IF b.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'purchase return and bill belong to different tenants' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(exempt_cents),0) AS ex, COALESCE(sum(taxable_cents),0) AS tx, COALESCE(sum(vat_cents),0) AS vat
  INTO p FROM purchase_returns WHERE purchase_bill_id = NEW.purchase_bill_id;
  IF p.ex + NEW.exempt_cents > b.exempt_cents OR p.tx + NEW.taxable_cents > b.taxable_cents OR p.vat + NEW.vat_cents > b.vat_cents THEN
    RAISE EXCEPTION 'purchase returns would exceed the supplier bill' USING ERRCODE = 'check_violation', HINT = 'fiscal_over_credit';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS purchase_returns_guard ON purchase_returns;
CREATE TRIGGER purchase_returns_guard
  BEFORE INSERT ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION purchase_returns_guard();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS purchase_returns;
DROP FUNCTION IF EXISTS purchase_returns_guard();
DROP TRIGGER IF EXISTS expenses_purchase_bill_guard ON expenses;
DROP FUNCTION IF EXISTS expenses_purchase_bill_guard();
DROP TABLE IF EXISTS purchase_bills;
DROP FUNCTION IF EXISTS purchase_bills_issue_guard();
-- +goose StatementEnd
