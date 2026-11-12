-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0097 — Read-only database access for IRD officers (procedure 2082 §11(क)–
-- (घ), §7.2; 2074 §7(ख)(३), §9).
--
-- IRD may inspect the server. On a shared multi-tenant database that must
-- mean: ONE officer, ONE login per visit, limited in time, seeing ONLY the
-- taxpayers named in IRD's written request, and able to read only the IRD
-- views — never raw tables, other cafés, credentials or settings.
--
--   ird_auditor        a NOLOGIN group role. Holds SELECT on the ird_audit_*
--                      views below and nothing else.
--   ird_<officer>      a per-visit LOGIN created by infra/datahub/ird-access.sh
--                      (VALID UNTIL, CONNECTION LIMIT, member of ird_auditor).
--   ird_access_grants  which login may see which tenant until when, why, and
--                      who granted it. Written only by the access script
--                      (as a superuser); the app has no rights on it.
--
-- The ird_audit_* views run as their owner (who bypasses RLS) and filter every
-- row through ird_can_see(tenant_id): true only for a live grant to the
-- connected login. So an officer's login sees exactly its granted cafés, and
-- the app role cannot use these views at all (no grant).
--
-- Creating the role needs CREATEROLE, which a migration runner may lack; the
-- DO block creates it when it can and otherwise leaves it to the access
-- script, which runs as a superuser and creates it on first use.
-- =========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ird_auditor') THEN
    BEGIN
      CREATE ROLE ird_auditor NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'ird_auditor not created (no CREATEROLE); infra/datahub/ird-access.sh will create it';
    END;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ird_access_grants (
  id          bigserial PRIMARY KEY,
  login       text NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  reason      text NOT NULL,
  granted_by  text NOT NULL DEFAULT session_user
);
CREATE INDEX IF NOT EXISTS ird_access_grants_login_idx ON ird_access_grants (login, tenant_id);
REVOKE ALL ON ird_access_grants FROM PUBLIC;

CREATE OR REPLACE FUNCTION ird_can_see(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM ird_access_grants
    WHERE login = session_user AND tenant_id = p_tenant
      AND revoked_at IS NULL AND expires_at > now()
  )
$fn$;
REVOKE ALL ON FUNCTION ird_can_see(uuid) FROM PUBLIC;

-- Standard View (Annex 5) across the granted taxpayers. It repeats the
-- ird_materialized_view (0096) definition on the base tables rather than
-- selecting from it: that view is security_invoker, and a nested invoker view
-- checks privileges as the CONNECTED user (the officer, who has no rights on
-- the base tables) even inside an owner-rights view. Keep the two in step.
CREATE OR REPLACE VIEW ird_audit_standard_view AS
SELECT t.slug AS org, fp.pan AS seller_pan, fp.legal_name AS seller_name,
  i.fiscal_year                          AS "Fiscal_Year",
  i.number                               AS "Bill_no",
  i.buyer_name                           AS "Customer_name",
  i.buyer_pan                            AS "Customer_pan",
  i.bs_date                              AS "Bill_Date",
  round(i.gross_cents / 100.0, 2)        AS "Amount",
  round(i.discount_cents / 100.0, 2)     AS "Discount",
  round((i.taxable_cents + i.non_taxable_cents) / 100.0, 2) AS "Taxable_Amount",
  round(i.vat_cents / 100.0, 2)          AS "Tax_Amount",
  round(i.total_cents / 100.0, 2)        AS "Total_Amount",
  COALESCE(s.status = 'synced' AND s.synced_via = 'live', false) AS "Sync_with_IRD",
  (p.printed_at IS NOT NULL)             AS "IS_Bill_Printed",
  (COALESCE(c.credited, 0) < i.total_cents) AS "Is_bill_Active",
  p.printed_at                           AS "Printed_Time",
  i.issued_by_name                       AS "Entered_By",
  p.printed_by_name                      AS "Printed_by",
  COALESCE(s.is_realtime AND s.synced_via = 'live', false) AS "Is_realtime",
  i.payment_method                       AS "Payment_Method",
  0.00::numeric(14,2)                    AS "VAT_Refund_Amount",
  NULLIF(i.transaction_id, '')           AS "Transaction_Id",
  i.seq, i.issued_at
FROM invoices i
JOIN tenants t ON t.id = i.tenant_id
JOIN fiscal_profiles fp ON fp.tenant_id = i.tenant_id
LEFT JOIN cbms_submissions s ON s.doc_type = 'invoice' AND s.doc_id = i.id
LEFT JOIN print_log p ON p.doc_type = 'invoice' AND p.doc_id = i.id AND p.copy_no = 1
LEFT JOIN LATERAL (
  SELECT sum(cn.total_cents) AS credited FROM credit_notes cn WHERE cn.invoice_id = i.id
) c ON true
WHERE ird_can_see(i.tenant_id);

CREATE OR REPLACE VIEW ird_audit_credit_notes AS
SELECT t.slug AS org, c.kind, c.fiscal_year, c.number, i.number AS ref_bill_no, i.bs_date AS ref_bill_date,
       c.bs_date, c.buyer_name, c.buyer_pan, round(c.total_cents / 100.0, 2) AS total,
       round(c.taxable_cents / 100.0, 2) AS taxable, round(c.vat_cents / 100.0, 2) AS vat,
       c.reason, c.refund_method, c.issued_by_name, c.issued_at
FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id JOIN tenants t ON t.id = c.tenant_id
WHERE ird_can_see(c.tenant_id);

CREATE OR REPLACE VIEW ird_audit_purchase_book AS
SELECT t.slug AS org, b.fiscal_year, b.supplier_bill_date_bs, b.supplier_bill_no, b.supplier_name, b.supplier_pan,
       b.is_import, b.customs_declaration_no, b.is_capital,
       round(b.total_cents / 100.0, 2) AS total, round(b.exempt_cents / 100.0, 2) AS exempt,
       round(b.taxable_cents / 100.0, 2) AS taxable, round(b.vat_cents / 100.0, 2) AS vat
FROM purchase_bills b JOIN tenants t ON t.id = b.tenant_id
WHERE ird_can_see(b.tenant_id);

CREATE OR REPLACE VIEW ird_audit_trail AS
SELECT t.slug AS org, a.created_at, a.actor_name, a.action, a.entity, a.summary, host(a.ip) AS ip,
       a.chain_seq, a.prev_hash, a.hash
FROM audit_log a JOIN tenants t ON t.id = a.tenant_id
WHERE ird_can_see(a.tenant_id);

CREATE OR REPLACE VIEW ird_audit_print_log AS
SELECT t.slug AS org, p.doc_type, COALESCE(i.number, c.number) AS number, p.copy_no, p.label,
       p.printed_by_name, p.printed_at
FROM print_log p
JOIN tenants t ON t.id = p.tenant_id
LEFT JOIN invoices i ON p.doc_type = 'invoice' AND i.id = p.doc_id
LEFT JOIN credit_notes c ON p.doc_type = 'credit_note' AND c.id = p.doc_id
WHERE ird_can_see(p.tenant_id);

REVOKE ALL ON ird_audit_standard_view, ird_audit_credit_notes, ird_audit_purchase_book,
              ird_audit_trail, ird_audit_print_log FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ird_auditor') THEN
    GRANT SELECT ON ird_audit_standard_view, ird_audit_credit_notes, ird_audit_purchase_book,
                    ird_audit_trail, ird_audit_print_log TO ird_auditor;
    GRANT EXECUTE ON FUNCTION ird_can_see(uuid) TO ird_auditor;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP VIEW IF EXISTS ird_audit_print_log;
DROP VIEW IF EXISTS ird_audit_trail;
DROP VIEW IF EXISTS ird_audit_purchase_book;
DROP VIEW IF EXISTS ird_audit_credit_notes;
DROP VIEW IF EXISTS ird_audit_standard_view;
DROP FUNCTION IF EXISTS ird_can_see(uuid);
DROP TABLE IF EXISTS ird_access_grants;
-- The ird_auditor role is left in place: roles are cluster-wide and per-visit
-- logins may still be members of it.
-- +goose StatementEnd
