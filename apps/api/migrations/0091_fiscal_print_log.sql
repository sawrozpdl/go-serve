-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0091 — IRD print log: every print of a fiscal document, counted.
--
-- Procedure 2082 §6.2(च) / 2074 §6(च): an invoice may be printed only once as
-- the original; every later print must say "Copy of Original" with its count,
-- and the count must be stored and retrievable. Annex 3 (and the office
-- handout) also asks for the first print titled "कर बीजक / Tax Invoice" and
-- the second "बीजक / Invoice" — the seller's copy (VAT Rules 2053, rule 17(2)).
--
-- The server decides the copy number and the label; clients print what they
-- are told. copy_no is unique per document, so two devices pressing Print at
-- once get 1 and 2, never 1 and 1. Rows are append-only: the IRD Standard View
-- reads IS_Bill_Printed / Printed_Time / Printed_by from copy 1.
--
-- doc_type/doc_id are polymorphic so credit notes (P4) print through the
-- same log. Existence of the document is checked by the API in the same
-- transaction; there is no FK because Postgres has no polymorphic FK.
-- =========================================================================

CREATE TABLE IF NOT EXISTS print_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  doc_type        text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  doc_id          uuid NOT NULL,
  copy_no         int  NOT NULL CHECK (copy_no >= 1),
  label           text NOT NULL,
  printed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  printed_by_name text NOT NULL,
  device          text NOT NULL DEFAULT '',
  printed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, doc_id, copy_no)
);

CREATE INDEX IF NOT EXISTS print_log_doc_idx ON print_log (tenant_id, doc_type, doc_id);

ALTER TABLE print_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS print_log_isolation ON print_log;
CREATE POLICY print_log_isolation ON print_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON print_log TO app;

DROP TRIGGER IF EXISTS print_log_immutable ON print_log;
CREATE TRIGGER print_log_immutable
  BEFORE UPDATE OR DELETE ON print_log
  FOR EACH ROW EXECUTE FUNCTION fiscal_forbid_mutation();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS print_log;
-- +goose StatementEnd
