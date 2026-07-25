/**
 * Pure helpers for the History screen — day arithmetic (deterministic, no
 * timezone surprises) and a day's takings summary. Unit-tested; `now` is
 * injected so tests don't depend on the clock.
 */
import type { HistoryCreditCollection, HistoryOrder } from '@cafe-mgmt/api-types';

/** Local YYYY-MM-DD for a given moment (defaults to now). */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shift a YYYY-MM-DD string by `delta` days (UTC math avoids DST drift). */
export function shiftDay(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Human label for a day: "Today", "Yesterday", else "Wed, Jul 1". */
export function formatDayLabel(dateStr: string, today: string = todayStr()): string {
  if (dateStr === today) return 'Today';
  if (dateStr === shiftDay(today, -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Is this the current day? (so the "next day" arrow can be disabled). */
export function isToday(dateStr: string, today: string = todayStr()): boolean {
  return dateStr === today;
}

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
