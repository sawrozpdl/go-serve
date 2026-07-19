-- =========================================================================
-- Wipe operational data for ONE tenant, keeping menu / categories / tables /
-- staff registry / team & roles / settings so the cafe stays usable.
--
-- Tenant: 9ee8d99f-e46a-40cc-b9e3-3985ec663267
--
-- RUN AS SUPERUSER (e.g. `psql -U postgres`). RLS is bypassed for superusers,
-- so every DELETE carries an explicit `WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'` — RLS does
-- NOT scope these statements for us.
--
-- Delete order is child-first, forced by these RESTRICT / NO-ACTION FKs:
--   owner_cash_entries -> {cafe_owners, cash_drops, expenses, shifts}
--   owner_ledger       -> {cafe_owners, expenses, self}
--   staff_pay          -> expenses            (0046, no ON DELETE action)
--   payments           -> {house_tabs, shifts}
--   house_tab_settlements -> {house_tabs, shifts}
--   cash_drops         -> {expenses, shifts}  (0009, RESTRICT)
--   account_transfers  -> shifts
--   expenses           -> {cafe_owners, shifts}
--   menu_item_inventory_link -> inventory_items
-- CASCADE fold-ins relied on:
--   orders -> (order_items, order_adjustments, payments)
--   expenses -> expense_allocations
--   inventory_items -> (pack_rules, stock_movements)
--   bug_reports -> bug_report_attachments
--
-- NOTE: this deliberately does NOT reuse purge_tenant_data() from
-- 0036_tenant_purge.sql — that function deletes expenses before cash_drops
-- (RESTRICT violation) and predates staff_pay.expense_id (0046).
--
-- Review the final counts, then COMMIT (or ROLLBACK).
-- =========================================================================

BEGIN;

-- 0. Sanity: confirm the tenant exists.
SELECT id, name FROM tenants WHERE id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 1. Audit trail.
DELETE FROM audit_events WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';
DELETE FROM audit_log    WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 2. Owner ledger + cash entries (reference owners, expenses, shifts, cash_drops, self).
DELETE FROM owner_cash_entries WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';
DELETE FROM owner_ledger WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
  AND (is_correction OR parent_loan_id IS NOT NULL);   -- self-ref children first
DELETE FROM owner_ledger WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 3. Payroll payment history (references expenses). staff + staff_documents are kept.
DELETE FROM staff_pay WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 4. Credit / house-tab settlements (reference house_tabs, shifts).
DELETE FROM house_tab_settlements WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 5. Orders — cascades order_items, order_adjustments, payments.
--    payments reference house_tabs + shifts, so orders must precede both.
DELETE FROM orders WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 6. Drawer movements (reference expenses + shifts) — BEFORE expenses & shifts.
DELETE FROM account_transfers WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';
DELETE FROM cash_drops        WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 7. Expenses — cascades expense_allocations (references cafe_owners + shifts).
DELETE FROM expenses WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 8. Shifts (now unreferenced).
DELETE FROM shifts WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 9. Credit accounts + owner records (now unreferenced).
DELETE FROM house_tabs  WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';
DELETE FROM cafe_owners WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 10. Inventory: link first (RESTRICT), then items (cascades pack_rules, stock_movements).
DELETE FROM menu_item_inventory_link WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';
DELETE FROM inventory_items          WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 11. Feedback (cascades bug_report_attachments).
DELETE FROM bug_reports WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- 12. Ephemeral auth artifacts (harmless; logs out live sessions/tickets).
DELETE FROM ws_tickets WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';
DELETE FROM sessions   WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- OPTIONAL — also wipe SaaS subscription billing history (NOT run by default;
-- kept because it is platform billing, not cafe operational data):
-- DELETE FROM tenant_payments WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

-- Verify what remains for the tenant BEFORE committing.
SELECT 'menu_items'             AS t, count(*) FROM menu_items      WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'menu_categories',       count(*) FROM menu_categories WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'service_tables',        count(*) FROM service_tables  WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'staff',                 count(*) FROM staff           WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'orders (expect 0)',     count(*) FROM orders          WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'expenses (expect 0)',   count(*) FROM expenses        WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'inventory (expect 0)',  count(*) FROM inventory_items WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'house_tabs (expect 0)', count(*) FROM house_tabs      WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267'
UNION ALL SELECT 'shifts (expect 0)',     count(*) FROM shifts          WHERE tenant_id = '9ee8d99f-e46a-40cc-b9e3-3985ec663267';

COMMIT;   -- or: ROLLBACK; if the counts look wrong
