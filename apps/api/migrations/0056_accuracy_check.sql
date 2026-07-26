-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0056 — platform_accuracy_check(): prove the money invariants on real rows.
--
-- The test suite proves that handlers AGREE with each other. This proves that
-- the DATA still satisfies the invariants the handlers assume — on live
-- production rows, at any time, without shipping a new binary.
--
-- Every check below is a row-level identity that must hold for a healthy
-- tenant. Each returns the offending row plus a signed delta so the size of the
-- problem is visible, not just its existence.
--
--   order_arithmetic      total_cents must equal subtotal − discount + service
--                         (+ tax when VAT was added on top). Anything else means
--                         the stored receipt does not add up.
--   payments_vs_total     a closed order's payments must equal its total; the
--                         close guard enforced that at close time.
--   post_close_void       a line voided after its order closed permanently
--                         desyncs the frozen total from the line sum.
--   credit_without_tab    payments.method='house_tab' with no house_tab_id is a
--                         receivable that belongs to nobody: invisible on the
--                         Credit page while the order reads as settled.
--   negative_tab          a credit account collected past its balance.
--   cash_without_shift    a cash payment outside any shift can never appear in a
--                         drawer count.
--   reversal_incomplete   a reversed collection missing its actor.
--   shift_expected_cash   a closed shift's stamped expected cash must equal the
--                         recomputation from its own rows; drift means something
--                         changed after the reconciliation was signed off.
--   drawer_expense_unlinked  a drawer-paid expense with no cash_drop never left
--                         the till as far as the drawer is concerned.
--
-- SECURITY DEFINER because /super has no tenant context and RLS would otherwise
-- hide every row (the same reason platform_tenant_summaries() exists in 0025).
-- Read-only: no INSERT/UPDATE/DELETE anywhere in the body. Callers are gated on
-- is_platform_admin() by the function itself, so EXECUTE alone leaks nothing.
-- =========================================================================

CREATE OR REPLACE FUNCTION platform_accuracy_check(p_tenant uuid DEFAULT NULL)
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
AS $$
  WITH allowed AS (
    -- Platform admins only. A non-admin caller gets an empty set rather than an
    -- error, so this can never become an information leak.
    SELECT t.id, t.slug
    FROM tenants t
    WHERE is_platform_admin(current_user_id())
      AND (p_tenant IS NULL OR t.id = p_tenant)
  )

  -- total_cents must reconcile with its own components.
  SELECT a.id, a.slug, 'order_arithmetic', 'order', o.id,
         format('subtotal %s − discount %s + service %s (tax %s) but total %s',
                o.subtotal_cents, o.discount_cents, o.service_charge_cents,
                o.tax_cents, o.total_cents),
         o.total_cents - (o.subtotal_cents - o.discount_cents + o.service_charge_cents)
  FROM allowed a JOIN orders o ON o.tenant_id = a.id
  WHERE o.status = 'closed'
    AND o.total_cents NOT IN (
      o.subtotal_cents - o.discount_cents + o.service_charge_cents,
      o.subtotal_cents - o.discount_cents + o.service_charge_cents + o.tax_cents
    )

  UNION ALL
  -- A closed order's payments must equal its total.
  SELECT a.id, a.slug, 'payments_vs_total', 'order', o.id,
         format('total %s but payments %s', o.total_cents, p.paid),
         p.paid - o.total_cents
  FROM allowed a
  JOIN orders o ON o.tenant_id = a.id AND o.status = 'closed'
  JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents), 0)::bigint AS paid
    FROM payments WHERE order_id = o.id
  ) p ON true
  WHERE p.paid <> o.total_cents

  UNION ALL
  -- Lines voided after the order closed.
  SELECT a.id, a.slug, 'post_close_void', 'order_item', oi.id,
         format('voided %s, order closed %s', oi.voided_at, o.closed_at),
         (oi.qty * oi.unit_price_cents)::bigint
  FROM allowed a
  JOIN orders o ON o.tenant_id = a.id AND o.status = 'closed'
  JOIN order_items oi ON oi.order_id = o.id
  WHERE oi.voided_at IS NOT NULL AND o.closed_at IS NOT NULL
    AND oi.voided_at > o.closed_at

  UNION ALL
  -- A credit charge that belongs to no credit account.
  SELECT a.id, a.slug, 'credit_without_tab', 'payment', p.id,
         'method=house_tab with no house_tab_id', p.amount_cents
  FROM allowed a JOIN payments p ON p.tenant_id = a.id
  WHERE p.method = 'house_tab' AND p.house_tab_id IS NULL

  UNION ALL
  -- Over-collected credit account.
  SELECT a.id, a.slug, 'negative_tab', 'house_tab', ht.id,
         format('charged %s, collected %s', b.charged, b.settled),
         b.charged - b.settled
  FROM allowed a
  JOIN house_tabs ht ON ht.tenant_id = a.id AND ht.deleted_at IS NULL
  JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(amount_cents) FROM payments
                WHERE house_tab_id = ht.id AND method = 'house_tab'), 0)::bigint AS charged,
      COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
                WHERE house_tab_id = ht.id AND reversed_at IS NULL), 0)::bigint AS settled
  ) b ON true
  WHERE b.charged - b.settled < 0

  UNION ALL
  -- Cash that no drawer count can ever see.
  SELECT a.id, a.slug, 'cash_without_shift', 'payment', p.id,
         'cash payment with no shift', p.amount_cents
  FROM allowed a JOIN payments p ON p.tenant_id = a.id
  WHERE p.method = 'cash' AND p.shift_id IS NULL

  UNION ALL
  -- Half-recorded reversal.
  SELECT a.id, a.slug, 'reversal_incomplete', 'house_tab_settlement', s.id,
         'reversed_at set without reversed_by_user_id', s.amount_cents
  FROM allowed a JOIN house_tab_settlements s ON s.tenant_id = a.id
  WHERE s.reversed_at IS NOT NULL AND s.reversed_by_user_id IS NULL

  UNION ALL
  -- A closed shift whose stamped expected cash no longer matches its rows.
  SELECT a.id, a.slug, 'shift_expected_cash', 'shift', sh.id,
         format('stamped %s, recomputes to %s', sh.expected_cash_cents, r.expected),
         sh.expected_cash_cents - r.expected
  FROM allowed a
  JOIN shifts sh ON sh.tenant_id = a.id
    AND sh.closed_at IS NOT NULL AND sh.expected_cash_cents IS NOT NULL
  JOIN LATERAL (
    SELECT (sh.opening_float_cents
      + COALESCE((SELECT SUM(amount_cents) FROM payments
                  WHERE shift_id = sh.id AND method = 'cash'), 0)
      + COALESCE((SELECT SUM(amount_cents) FROM house_tab_settlements
                  WHERE shift_id = sh.id AND payment_method = 'cash'
                    AND reversed_at IS NULL), 0)
      + COALESCE((SELECT SUM(amount_cents) FROM cash_drops
                  WHERE shift_id = sh.id AND direction = 'in'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM cash_drops
                  WHERE shift_id = sh.id AND direction = 'out'), 0))::bigint AS expected
  ) r ON true
  WHERE sh.expected_cash_cents <> r.expected

  UNION ALL
  -- A drawer-paid expense that never moved the drawer.
  SELECT a.id, a.slug, 'drawer_expense_unlinked', 'expense', e.id,
         format('paid_from=drawer, vendor %s, no cash_drop', e.vendor),
         e.amount_cents
  FROM allowed a JOIN expenses e ON e.tenant_id = a.id
  WHERE e.deleted_at IS NULL AND e.paid_from = 'drawer'
    AND NOT EXISTS (SELECT 1 FROM cash_drops d WHERE d.expense_id = e.id)

  ORDER BY 3, 1, 5
$$;

REVOKE ALL ON FUNCTION platform_accuracy_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_accuracy_check(uuid) TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP FUNCTION IF EXISTS platform_accuracy_check(uuid);

-- +goose StatementEnd
