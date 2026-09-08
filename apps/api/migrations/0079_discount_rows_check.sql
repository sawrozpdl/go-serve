-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0079 — accuracy check: a closed order's discount rows must equal its column
--
-- orders.discount_cents is written once, at close, from the sum of that order's
-- order_adjustments discount rows. Until now nothing verified they stayed in
-- agreement, because nothing READ the rows again after close — the frozen
-- column was the only consumer.
--
-- Category promotions (0078) change that. Profitability now reads the rows, to
-- attribute a promotion to the category that earned it, while History still
-- reads the column. If a discount row were ever removed or altered after close
-- — impossible through the handlers, entirely possible through SQL or a future
-- code path — the two would silently disagree and an owner would be shown two
-- different discount figures with nothing to catch it.
--
-- A SEPARATE function, not an edit to platform_accuracy_check() (0056), for the
-- same reason platform_accuracy_check_addons() (0062) is separate: that function
-- is one long UNION ALL, and re-declaring it to append a check would duplicate
-- every unrelated one and guarantee the copies drift. Identical column shape and
-- the same is_platform_admin gating, so the /super/accuracy-check handler just
-- UNIONs a third source and the e2e assertClean() covers it for free.
--
-- Staff meals are excluded: CloseOrder deliberately writes zeros across the
-- board for them, so a promoted-then-made-a-staff-meal order is zero-by-design
-- rather than out of balance. (syncCategoryPromotions also refuses to write
-- promo rows for one, so this is belt and braces.)
-- =========================================================================

CREATE OR REPLACE FUNCTION platform_accuracy_check_discounts(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (
  tenant_id   uuid,
  slug        text,
  check_key   text,
  entity      text,
  entity_id   uuid,
  detail      text,
  delta_cents bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
  WITH allowed AS (
    -- Platform admins only; a non-admin caller gets an empty set rather than an
    -- error, exactly as in 0056.
    SELECT t.id, t.slug
    FROM tenants t
    WHERE is_platform_admin(current_user_id())
      AND (p_tenant IS NULL OR t.id = p_tenant)
  )
  SELECT a.id, a.slug, 'order_discount_rows', 'order', o.id,
         format('discount_cents %s but discount rows sum to %s',
                o.discount_cents, d.rows_sum),
         d.rows_sum - o.discount_cents
  FROM allowed a
  JOIN orders o ON o.tenant_id = a.id AND o.status = 'closed' AND o.staff_id IS NULL
  JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents), 0)::bigint AS rows_sum
    FROM order_adjustments
    WHERE order_id = o.id AND type = 'discount'
  ) d ON true
  WHERE d.rows_sum <> o.discount_cents
$fn$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS platform_accuracy_check_discounts(uuid);
-- +goose StatementEnd
