-- +goose Up

-- =========================================================================
-- 0037 — VAT mode.
--
-- VAT now has three modes instead of a bare rate that was always added on top:
--   'none'      — no VAT; the rate is ignored and the UI hides all VAT wording.
--   'inclusive' — menu prices already contain VAT; it's extracted for the bill.
--   'exclusive' — VAT is computed on the base and added to the total (legacy).
--
-- Existing rows backfill to 'none' (the column default); admins opt into VAT
-- explicitly in Settings → Locale & Tax. Closed orders are unaffected — they
-- store their own tax_cents at close time, so switching modes never rewrites
-- history.
--
-- No GRANT needed — `app` already has UPDATE on tenants (0001_initial.sql).
-- =========================================================================

ALTER TABLE tenants
  ADD COLUMN vat_mode text NOT NULL DEFAULT 'none'
  CHECK (vat_mode IN ('none', 'inclusive', 'exclusive'));

-- +goose Down

ALTER TABLE tenants DROP COLUMN vat_mode;
