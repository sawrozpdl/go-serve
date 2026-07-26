// The one report range model.
//
// The app grew four incompatible range models — Dashboard's URL-persisted
// preset/month/custom, Profitability's day/span/custom, Movers' preset + from/to,
// Expenses' plain from/to, and Activity's ISO-*timestamp* presets. The report
// builder has to drive every section at once, so it needs a single model.
//
// The preset vocabulary below is deliberately the SAME set `resolveRangeFull`
// understands (apps/api/internal/api/reports.go) — anything else would 400 or,
// worse, silently fall back to "today" server-side.
//
// Note what this module does NOT do: it never computes the actual window for a
// preset. That resolution is tenant-timezone-dependent and belongs to the server
// (a cafe on Asia/Kathmandu rolling over at 00:00 NPT is not the browser's
// midnight). The report prints the `from`/`to` the API echoes back, so the
// document's stated coverage always matches the numbers in it.

import { todayIso } from '@/lib/dates';

/** Presets `resolveRangeFull` accepts. Keep in sync with reports.go. */
export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'dby'
  | '7d'
  | '30d'
  | 'thisweek'
  | 'lastweek'
  | 'mtd'
  | 'lastmonth'
  | 'ytd'
  | 'all';

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'dby', label: 'Day before' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'thisweek', label: 'This week' },
  { value: 'lastweek', label: 'Last week' },
  { value: 'mtd', label: 'This month' },
  { value: 'lastmonth', label: 'Last month' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all', label: 'All time' },
];

const PRESET_VALUES = RANGE_PRESETS.map((r) => r.value);

export type ReportRange =
  | { kind: 'preset'; preset: RangePreset }
  | { kind: 'month'; month: string } // YYYY-MM
  | { kind: 'custom'; from: string; to: string }; // both inclusive YYYY-MM-DD

export const YM_RE = /^\d{4}-\d{2}$/;
export const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_RANGE: ReportRange = { kind: 'preset', preset: 'lastmonth' };

// ---------------------------------------------------------------------------
// Month helpers (local-calendar arithmetic, mirroring lib/dates.ts)
// ---------------------------------------------------------------------------

/** First-of-month → last-of-month, clamped to today. Both inclusive. */
export function monthBounds(ym: string): { from: string; to: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  // Day 0 of the next month is the last day of this one — handles leap years.
  const lastDay = new Date(y, m, 0).getDate();
  const lastIso = `${ym}-${String(lastDay).padStart(2, '0')}`;
  const today = todayIso();
  return { from: `${ym}-01`, to: lastIso > today ? today : lastIso };
}

export function monthLabel(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function currentYm(): string {
  return todayIso().slice(0, 7);
}

export function shiftYm(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Last `n` months (YYYY-MM), most recent first. */
export function recentMonths(n: number): string[] {
  const out: string[] = [];
  let ym = currentYm();
  for (let i = 0; i < n; i++) {
    out.push(ym);
    ym = shiftYm(ym, -1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

export type RangeQuery = { range: string; from?: string; to?: string };

/**
 * Collapse a ReportRange into the `range`/`from`/`to` trio every analytics
 * endpoint takes. Months become an explicit custom window rather than a preset
 * so the server doesn't have to know about them.
 */
export function rangeToQuery(r: ReportRange): RangeQuery {
  if (r.kind === 'preset') return { range: r.preset };
  if (r.kind === 'month') {
    const { from, to } = monthBounds(r.month);
    return { range: 'custom', from, to };
  }
  return { range: 'custom', from: r.from, to: r.to };
}

/** Query string for an analytics endpoint. Mirrors api.ts's dashRangeQS. */
export function rangeQs(r: ReportRange): string {
  const q = rangeToQuery(r);
  const qs = new URLSearchParams({ range: q.range });
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  return qs.toString();
}

/** A custom window is only fetchable once both ends are picked and ordered. */
export function rangeReady(r: ReportRange): boolean {
  if (r.kind === 'preset') return true;
  if (r.kind === 'month') return YM_RE.test(r.month);
  return ISO_RE.test(r.from) && ISO_RE.test(r.to) && r.from <= r.to;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What the user picked — the request, not the resolved window. */
export function rangeLabel(r: ReportRange): string {
  if (r.kind === 'preset') {
    return RANGE_PRESETS.find((p) => p.value === r.preset)?.label ?? r.preset;
  }
  if (r.kind === 'month') return monthLabel(r.month);
  return r.from === r.to
    ? formatIsoLong(r.from)
    : `${formatIsoLong(r.from)} — ${formatIsoLong(r.to)}`;
}

/**
 * The window the data actually covers, for the cover page and running footers.
 *
 * Two shapes arrive here, and conflating them prints the wrong dates:
 *
 *  - **Instants** (`2026-05-31T18:15:00Z`) from the analytics endpoints. These
 *    are tenant-local midnights serialized as UTC, and `to` is EXCLUSIVE (the
 *    following midnight). Slicing the date off the string reads the UTC calendar
 *    day, which for Asia/Kathmandu (+05:45) is the day *before* — "last month"
 *    printed as "31 May — 30 Jun". The instant has to be converted in the
 *    tenant's timezone, which is why `timezone` is required for this shape.
 *  - **Calendar days** (`2026-06-01`) from the order-history endpoint, which
 *    echoes the inclusive days it was asked for. Those need no conversion, and
 *    must NOT have a day subtracted.
 */
export function resolvedWindowLabel(
  from?: string,
  to?: string,
  timezone?: string,
): string | undefined {
  if (!from || !to) return undefined;
  const fromDay = isCalendarDay(from) ? from : instantToDay(from, timezone);
  const toDay = isCalendarDay(to) ? to : exclusiveEndToInclusiveDay(to, timezone);
  if (!fromDay || !toDay) return undefined;
  if (fromDay === toDay) return formatIsoLong(fromDay);
  return `${formatIsoLong(fromDay)} — ${formatIsoLong(toDay)}`;
}

/** True for a bare `YYYY-MM-DD`, which names a day rather than an instant. */
export function isCalendarDay(s: string): boolean {
  return ISO_RE.test(s);
}

/**
 * Calendar day an instant falls on, in `timezone` (the browser's zone when
 * none is given). Uses en-CA because it formats as YYYY-MM-DD.
 */
export function instantToDay(iso: string, timezone?: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    // An unknown IANA zone would throw; fall back to the browser's rather than
    // failing the whole export over a label.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }
}

/**
 * Last day an exclusive end bound actually covers.
 *
 * Backing off one millisecond lands inside the final day whatever the bound is,
 * so this needs no special case for "is it exactly midnight" — which is the
 * check that made the previous version wrong for a +05:45 tenant.
 */
export function exclusiveEndToInclusiveDay(to: string, timezone?: string): string | undefined {
  const d = new Date(to);
  if (Number.isNaN(d.getTime())) return undefined;
  return instantToDay(new Date(d.getTime() - 1).toISOString(), timezone);
}

export function formatIsoLong(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// URL round-trip — lets a page deep-link the builder at its own current range
// ---------------------------------------------------------------------------

export function rangeToParams(r: ReportRange): Record<string, string> {
  if (r.kind === 'preset') return { range: r.preset };
  if (r.kind === 'month') return { range: 'custom', month: r.month };
  return { range: 'custom', from: r.from, to: r.to };
}

export function parseRange(params: URLSearchParams): ReportRange {
  const raw = params.get('range') || '';
  if (raw === 'custom') {
    const month = params.get('month');
    if (month && YM_RE.test(month)) return { kind: 'month', month };
    const from = params.get('from');
    const to = params.get('to');
    if (from && to && ISO_RE.test(from) && ISO_RE.test(to)) {
      // Tolerate a reversed deep link rather than dropping to the default.
      return from <= to ? { kind: 'custom', from, to } : { kind: 'custom', from: to, to: from };
    }
    return DEFAULT_RANGE;
  }
  // A bare ?from=&to= (how History and Profitability deep-link today) is a
  // custom window even without ?range=custom.
  const from = params.get('from');
  const to = params.get('to');
  if (!raw && from && to && ISO_RE.test(from) && ISO_RE.test(to)) {
    return from <= to ? { kind: 'custom', from, to } : { kind: 'custom', from: to, to: from };
  }
  if (raw && (PRESET_VALUES as string[]).includes(raw)) {
    return { kind: 'preset', preset: raw as RangePreset };
  }
  return DEFAULT_RANGE;
}
