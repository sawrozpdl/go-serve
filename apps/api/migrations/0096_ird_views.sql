-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0096 — The IRD Standard View (procedure 2082 §6.1(छ), Annex 5; 2074 §6(ङ)
-- "Materialized View").
--
-- One row per issued invoice with the 20 attributes IRD names, in IRD's order
-- and with IRD's column names, derived — never stored — from the immutable
-- invoice plus the append-only print log, CBMS outbox and credit notes:
--
--   Sync_with_IRD   the bill reached the REAL CBMS (synced_via='live'); a mock
--                   sync is not reporting.
--   IS_Bill_Printed / Printed_Time / Printed_by   from print copy 1.
--   Is_bill_Active  false once sales returns / reverse entries credit the
--                   whole bill.
--   VAT_Refund_Amount  0 — the consumer VAT refund on electronic payment is
--                   not offered (declared in docs/ird/COMPLIANCE.md).
--
-- security_invoker: the view runs with the CALLER's rights, so RLS on the
-- underlying tables still confines the app role to its own tenant. (A plain
-- view would run as its owner, who bypasses RLS.) IRD's own read-only role
-- gets separately filtered views in a later migration.
--
-- Amounts are rupees (numeric 14,2) because this view is what an IRD officer
-- reads directly.
-- =========================================================================

CREATE OR REPLACE VIEW ird_materialized_view WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.id                                   AS invoice_id,
  i.seq,
  i.issued_at,
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
  NULLIF(i.transaction_id, '')           AS "Transaction_Id"
FROM invoices i
LEFT JOIN cbms_submissions s ON s.doc_type = 'invoice' AND s.doc_id = i.id
LEFT JOIN print_log p ON p.doc_type = 'invoice' AND p.doc_id = i.id AND p.copy_no = 1
LEFT JOIN LATERAL (
  SELECT sum(cn.total_cents) AS credited FROM credit_notes cn WHERE cn.invoice_id = i.id
) c ON true;

GRANT SELECT ON ird_materialized_view TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP VIEW IF EXISTS ird_materialized_view;
-- +goose StatementEnd
