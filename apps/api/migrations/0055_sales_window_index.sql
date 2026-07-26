-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0055 — index the sales window.
--
-- Every sales figure in the app filters the same way:
--
--   WHERE status = 'closed' AND closed_at >= $1 AND closed_at < $2
--
-- (dashboard KPIs + daily series, hourly, heatmap, table mix, velocity, top
-- sellers, category mix, profitability, order history, shift summaries). The
-- only usable index was orders(tenant_id, status), so each of those queries
-- walked EVERY closed order the tenant had ever taken and filtered by date in
-- memory. Fine at a few thousand orders; the dashboard opens ~10 such queries
-- per page load, so it degrades in step with a cafe's lifetime volume rather
-- than with the range being looked at.
--
-- A partial index on the exact predicate keeps only closed rows and orders them
-- by the column every window filters on, so a day/week/month range is a bounded
-- index scan no matter how much history sits behind it.
--
-- No data change; index-only migration.
-- =========================================================================

CREATE INDEX IF NOT EXISTS orders_tenant_closed_at_idx
  ON orders (tenant_id, closed_at DESC)
  WHERE status = 'closed';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP INDEX IF EXISTS orders_tenant_closed_at_idx;

-- +goose StatementEnd
