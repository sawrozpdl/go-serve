/**
 * Pure order-derivation helper, extracted from ./orders so the demo backend can
 * reuse it without importing ./client (which imports the demo transport — a
 * cycle). ./orders re-exports it, so every existing call site and test is
 * unchanged.
 */
import type { Order, KitchenStatus } from '@cafe-mgmt/api-types';

/** Recompute the cheap derived fields (live subtotal + per-status counts) after
 * an optimistic cache edit, so floor tiles + summaries stay consistent without a
 * round-trip. Pure + unit-tested. */
export function recomputeOrderDerived(o: Order): Order {
  const items = o.items ?? [];
  const live = items.filter((i) => !i.voided_at).reduce((s, i) => s + i.line_cents, 0);
  const count = (st: KitchenStatus) =>
    items.filter((i) => !i.voided_at && i.kitchen_status === st).length;
  return {
    ...o,
    live_subtotal_cents: live,
    items_pending: count('pending'),
    items_in_progress: count('in_progress'),
    items_ready: count('ready'),
    items_served: count('served'),
    items_total: items.filter((i) => !i.voided_at).length,
  };
}
