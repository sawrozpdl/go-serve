/**
 * Expense list filters as pure data.
 *
 * Web filters with a from/to date pair behind two calendar popovers. A phone
 * has no room for that and a date-picker dependency was ruled out, so the same
 * ground is covered by a day stepper plus three range presets — the operator
 * can still reach any single day, the last week, the month, or everything,
 * which is every range the dashboard's pickers are actually used for.
 *
 * Everything here is a pure function of the filter state so the query params,
 * the "N expenses · Rs X" summary and the "is anything filtered" badge can be
 * unit-tested without mounting the screen.
 */
import type { Expense, ExpensePaidFrom } from '@cafe-mgmt/api-types';
import type { ExpenseFilters } from '@/api/expenses';
import { todayStr, shiftDay, formatDayLabel, startOfMonth } from '@/lib/dates';

export type ExpenseRange = 'day' | 'week' | 'month' | 'all';

export type ExpenseFilterState = {
  range: ExpenseRange;
  /** Anchor day (YYYY-MM-DD). The stepper moves this; the windows end on it. */
  day: string;
  q: string;
  categoryId: string;
  paidFrom: '' | ExpensePaidFrom;
};

/** Opens on today, exactly as web does — "what did I spend today", not an
 *  undifferentiated all-time list. */
export function initialFilters(today: string = todayStr()): ExpenseFilterState {
  return { range: 'day', day: today, q: '', categoryId: '', paidFrom: '' };
}

/** The inclusive day bounds a range covers. `all` has none. */
export function rangeBounds(s: ExpenseFilterState): { from?: string; to?: string } {
  switch (s.range) {
    case 'day':
      return { from: s.day, to: s.day };
    case 'week':
      // Rolling 7 days *including* the anchor, so "Last 7 days" is 7, not 8.
      return { from: shiftDay(s.day, -6), to: s.day };
    case 'month':
      return { from: startOfMonth(s.day), to: s.day };
    case 'all':
      return {};
  }
}

/** Filter state → server query params. */
export function toQuery(s: ExpenseFilterState): ExpenseFilters {
  const { from, to } = rangeBounds(s);
  return {
    from,
    // Plain dates on purpose. The server reads `from`/`to` as whole TENANT-LOCAL
    // days and compares half-open, [from 00:00, to+1 00:00) in the cafe's
    // timezone — so the boundary follows the cafe, not the phone. Web still
    // sends a `T23:59:59` suffix, which was a workaround for an older handler
    // that compared in the database session's timezone; the cast to ::date
    // discards it now, so it is dead weight rather than a difference.
    to,
    q: s.q.trim() || undefined,
    expense_category_id: s.categoryId || undefined,
    paid_from: s.paidFrom || undefined,
  };
}

/** How many filters depart from the default (today, no text/category/source).
 *  Drives the badge on the Filters button and whether "Clear" is offered. */
export function activeFilterCount(s: ExpenseFilterState, today: string = todayStr()): number {
  let n = 0;
  if (s.q.trim()) n += 1;
  if (s.categoryId) n += 1;
  if (s.paidFrom) n += 1;
  if (s.range !== 'day' || s.day !== today) n += 1;
  return n;
}

export function filtersActive(s: ExpenseFilterState, today: string = todayStr()): boolean {
  return activeFilterCount(s, today) > 0;
}

/** What the header says the list is showing. */
export function rangeLabel(s: ExpenseFilterState, today: string = todayStr()): string {
  switch (s.range) {
    case 'day':
      return formatDayLabel(s.day, today);
    case 'week':
      return 'Last 7 days';
    case 'month':
      return s.day.slice(0, 7) === today.slice(0, 7)
        ? 'This month'
        : new Date(`${startOfMonth(s.day)}T00:00:00Z`).toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          });
    case 'all':
      return 'All time';
  }
}

/** Running count + total for whatever the filters matched. */
export function summarize(rows: Expense[] | undefined): { count: number; totalCents: number } {
  const list = rows ?? [];
  return { count: list.length, totalCents: list.reduce((sum, e) => sum + e.amount_cents, 0) };
}

/** Where the money came from, in words. The raw enum used to leak into the UI
 *  as "owner_cash". `ownerName` is the row's own owner when it has one. */
export function paidFromLabel(paidFrom: string, ownerName?: string | null): string {
  switch (paidFrom) {
    case 'drawer':
      return 'Cash drawer';
    case 'bank':
      return 'Bank';
    case 'owner':
      return `${ownerName || 'Owner'} paid`;
    case 'owner_cash':
      return `${ownerName || 'Owner'}'s cafe cash`;
    default:
      return paidFrom;
  }
}

/**
 * Vendor autocomplete. Web hands the whole list to a `<datalist>` and lets the
 * browser match; a phone has no datalist, so the matching is done here and the
 * top few are offered as chips.
 *
 * Matches anywhere in the name, not just the start — "mill" should find "Local
 * Mill" — and an exact match is dropped, since offering what is already typed
 * is just noise.
 */
export function vendorSuggestions(all: string[] | undefined, typed: string, limit = 4): string[] {
  const q = typed.trim().toLowerCase();
  const list = all ?? [];
  if (!q) return list.slice(0, limit);
  return list.filter((v) => v.toLowerCase().includes(q) && v.toLowerCase() !== q).slice(0, limit);
}

/**
 * Combine the "paid at" day and HH:MM into an ISO instant.
 *
 * Built through the local-time `Date` constructor on purpose: the operator
 * types a wall-clock time in the cafe, and the server stores an instant. An
 * unparseable or empty time falls back to midday rather than midnight, so a
 * back-dated expense can't slide into the previous day under a negative UTC
 * offset.
 */
export function paidAtIso(day: string, hhmm: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  const h = match ? Math.min(23, Number(match[1])) : 12;
  const min = match ? Math.min(59, Number(match[2])) : 0;
  return new Date(y, m - 1, d, h, min, 0).toISOString();
}

/** True when HH:MM is a real 24h time — the field shows an error otherwise. */
export function isValidHHMM(hhmm: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}
