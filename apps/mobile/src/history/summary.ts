/**
 * Pure helpers for the History screen — a day's takings summary. The day
 * arithmetic it is built on lives in `lib/dates` (shared with Expenses) and is
 * re-exported here so the screen keeps one import. Unit-tested; `now` is
 * injected so tests don't depend on the clock.
 */
import type { HistoryCreditCollection, HistoryOrder } from '@cafe-mgmt/api-types';

export { todayStr, shiftDay, formatDayLabel, isToday } from '../lib/dates';

export type DaySummary = {
  orderCount: number;
  salesCents: number;
  cashCents: number;
  onlineCents: number;
  tabCents: number;
  /** Credit collected on this day for serves closed EARLIER. Money in hand, but
   *  those serves were counted as sales when they were charged — so this is
   *  never added to salesCents. */
  creditCollectedCents: number;
  creditCollectedCount: number;
};

/** Which takings bucket a payment method falls into. */
function bucketOf(method: string): 'cash' | 'tab' | 'online' {
  if (method === 'cash') return 'cash';
  if (method === 'house_tab') return 'tab';
  return 'online'; // online + legacy esewa/khalti/card/other
}

/** Aggregate a day's closed orders: order count, gross sales, and the
 * cash / online / house-tab split of what was collected. Credit collected on the
 * day is carried alongside — deliberately NOT folded into salesCents. */
export function summarizeHistory(
  orders: HistoryOrder[],
  creditCollections?: HistoryCreditCollection[] | null,
): DaySummary {
  const s: DaySummary = {
    orderCount: orders.length,
    salesCents: 0,
    cashCents: 0,
    onlineCents: 0,
    tabCents: 0,
    creditCollectedCents: (creditCollections ?? []).reduce((sum, c) => sum + c.amount_cents, 0),
    creditCollectedCount: creditCollections?.length ?? 0,
  };
  for (const o of orders) {
    s.salesCents += o.total_cents;
    for (const p of o.payments) {
      const b = bucketOf(p.method);
      if (b === 'cash') s.cashCents += p.amount_cents;
      else if (b === 'tab') s.tabCents += p.amount_cents;
      else s.onlineCents += p.amount_cents;
    }
  }
  return s;
}
