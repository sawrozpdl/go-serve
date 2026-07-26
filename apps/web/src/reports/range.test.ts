import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RANGE,
  RANGE_PRESETS,
  exclusiveEndToInclusiveDay,
  instantToDay,
  isCalendarDay,
  monthBounds,
  monthLabel,
  parseRange,
  rangeQs,
  rangeReady,
  rangeToParams,
  rangeToQuery,
  recentMonths,
  resolvedWindowLabel,
  shiftYm,
  type ReportRange,
} from './range';

// Freeze "today" so month clamping and recentMonths are deterministic. Local
// noon avoids any chance of the fake date landing on the previous UTC day.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 25, 12, 0, 0)); // 2026-07-25 local
});
afterEach(() => {
  vi.useRealTimers();
});

describe('preset vocabulary', () => {
  // These are the presets resolveRangeFull (apps/api/internal/api/reports.go)
  // accepts. A preset we send that it doesn't know silently becomes "today"
  // server-side, so drift here is a data-correctness bug, not a cosmetic one.
  it('matches the backend resolveRangeFull switch exactly', () => {
    expect(RANGE_PRESETS.map((p) => p.value)).toEqual([
      'today',
      'yesterday',
      'dby',
      '7d',
      '30d',
      'thisweek',
      'lastweek',
      'mtd',
      'lastmonth',
      'ytd',
      'all',
    ]);
  });

  it('sends a preset as a bare range with no from/to', () => {
    expect(rangeToQuery({ kind: 'preset', preset: '30d' })).toEqual({ range: '30d' });
    expect(rangeQs({ kind: 'preset', preset: 'mtd' })).toBe('range=mtd');
  });
});

describe('monthBounds', () => {
  it('spans a whole past month', () => {
    expect(monthBounds('2026-06')).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('clamps the current month to today', () => {
    expect(monthBounds('2026-07')).toEqual({ from: '2026-07-01', to: '2026-07-25' });
  });

  it('handles February in a leap year', () => {
    expect(monthBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('handles February in a non-leap year', () => {
    expect(monthBounds('2025-02')).toEqual({ from: '2025-02-01', to: '2025-02-28' });
  });

  it('becomes a custom window in the query, not a preset', () => {
    expect(rangeToQuery({ kind: 'month', month: '2026-06' })).toEqual({
      range: 'custom',
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });
});

describe('month arithmetic', () => {
  it('steps back across a year boundary', () => {
    expect(shiftYm('2026-01', -1)).toBe('2025-12');
  });

  it('steps forward across a year boundary', () => {
    expect(shiftYm('2025-12', 1)).toBe('2026-01');
  });

  it('lists recent months most-recent-first ending at the current month', () => {
    expect(recentMonths(4)).toEqual(['2026-07', '2026-06', '2026-05', '2026-04']);
  });

  it('labels a month readably', () => {
    expect(monthLabel('2026-06')).toBe('June 2026');
  });
});

describe('rangeReady', () => {
  it('accepts any preset', () => {
    expect(rangeReady({ kind: 'preset', preset: 'all' })).toBe(true);
  });

  it('accepts a single-day custom window (from === to)', () => {
    // resolveRangeFull advances an inclusive `to` to the next midnight, so
    // from === to is a valid whole day rather than a zero-width window.
    expect(rangeReady({ kind: 'custom', from: '2026-07-01', to: '2026-07-01' })).toBe(true);
  });

  it('rejects a half-filled custom window', () => {
    expect(rangeReady({ kind: 'custom', from: '2026-07-01', to: '' })).toBe(false);
    expect(rangeReady({ kind: 'custom', from: '', to: '2026-07-01' })).toBe(false);
  });

  it('rejects a reversed custom window', () => {
    expect(rangeReady({ kind: 'custom', from: '2026-07-10', to: '2026-07-01' })).toBe(false);
  });

  it('rejects a malformed month', () => {
    expect(rangeReady({ kind: 'month', month: '2026-6' })).toBe(false);
  });
});

describe('URL round-trip', () => {
  const cases: ReportRange[] = [
    { kind: 'preset', preset: 'lastmonth' },
    { kind: 'preset', preset: 'ytd' },
    { kind: 'month', month: '2026-06' },
    { kind: 'custom', from: '2026-01-02', to: '2026-03-04' },
  ];

  it('survives a round-trip through query params', () => {
    for (const r of cases) {
      const params = new URLSearchParams(rangeToParams(r));
      expect(parseRange(params)).toEqual(r);
    }
  });

  it('reads a bare ?from=&to= deep link as a custom window', () => {
    // History and Profitability already link this way, without ?range=custom.
    const params = new URLSearchParams({ from: '2026-05-01', to: '2026-05-31' });
    expect(parseRange(params)).toEqual({ kind: 'custom', from: '2026-05-01', to: '2026-05-31' });
  });

  it('repairs a reversed deep link instead of discarding it', () => {
    const params = new URLSearchParams({ range: 'custom', from: '2026-05-31', to: '2026-05-01' });
    expect(parseRange(params)).toEqual({ kind: 'custom', from: '2026-05-01', to: '2026-05-31' });
  });

  it('falls back to the default for an unknown preset', () => {
    expect(parseRange(new URLSearchParams({ range: 'last_fortnight' }))).toEqual(DEFAULT_RANGE);
  });

  it('falls back to the default for custom with no usable bounds', () => {
    expect(parseRange(new URLSearchParams({ range: 'custom' }))).toEqual(DEFAULT_RANGE);
    expect(parseRange(new URLSearchParams({ range: 'custom', from: 'nope', to: 'nope' }))).toEqual(
      DEFAULT_RANGE,
    );
  });

  it('falls back to the default for no params at all', () => {
    expect(parseRange(new URLSearchParams())).toEqual(DEFAULT_RANGE);
  });
});

describe('resolved window labels', () => {
  // These are the exact shapes the API returns. Analytics endpoints serialize a
  // tenant-local midnight as a UTC instant, so for Asia/Kathmandu (+05:45) the
  // UTC calendar day is the day BEFORE — reading it off the string printed "last
  // month" as "31 May — 30 Jun". The timezone has to do the work.
  const NPT = 'Asia/Kathmandu';

  it('reads the tenant calendar day, not the UTC one', () => {
    // 2026-05-31T18:15:00Z IS 2026-06-01 00:00 in Kathmandu.
    expect(resolvedWindowLabel('2026-05-31T18:15:00Z', '2026-06-30T18:15:00Z', NPT)).toBe(
      '01 Jun 2026 — 30 Jun 2026',
    );
  });

  it('names the last day covered, not the exclusive bound', () => {
    // The `to` instant is the following midnight; it must not be printed.
    expect(resolvedWindowLabel('2026-05-31T18:15:00Z', '2026-07-31T18:15:00Z', NPT)).toBe(
      '01 Jun 2026 — 31 Jul 2026',
    );
  });

  it('collapses a single covered day to one date', () => {
    expect(resolvedWindowLabel('2026-06-04T18:15:00Z', '2026-06-05T18:15:00Z', NPT)).toBe(
      '05 Jun 2026',
    );
  });

  it('steps back across a month boundary', () => {
    expect(exclusiveEndToInclusiveDay('2026-06-30T18:15:00Z', NPT)).toBe('2026-06-30');
  });

  it('steps back across a year boundary', () => {
    // 2025-12-31T18:15:00Z = 2026-01-01 00:00 NPT, exclusive -> 31 Dec 2025.
    expect(exclusiveEndToInclusiveDay('2025-12-31T18:15:00Z', NPT)).toBe('2025-12-31');
  });

  it('steps back across a leap day', () => {
    // 2024-02-29T18:15:00Z = 2024-03-01 00:00 NPT, exclusive -> 29 Feb 2024.
    expect(exclusiveEndToInclusiveDay('2024-02-29T18:15:00Z', NPT)).toBe('2024-02-29');
  });

  it('leaves calendar-day bounds alone', () => {
    // Order history echoes the inclusive days it was asked for. Subtracting a
    // day from those would drop the last day of every span.
    expect(resolvedWindowLabel('2026-06-01', '2026-06-30', NPT)).toBe('01 Jun 2026 — 30 Jun 2026');
    expect(resolvedWindowLabel('2026-06-01', '2026-06-01', NPT)).toBe('01 Jun 2026');
  });

  it('distinguishes a calendar day from an instant', () => {
    expect(isCalendarDay('2026-06-01')).toBe(true);
    expect(isCalendarDay('2026-06-01T00:00:00Z')).toBe(false);
  });

  it('converts an instant in the zone it is given', () => {
    // Same instant, two zones, two calendar days.
    expect(instantToDay('2026-05-31T18:15:00Z', NPT)).toBe('2026-06-01');
    expect(instantToDay('2026-05-31T18:15:00Z', 'UTC')).toBe('2026-05-31');
  });

  it('falls back rather than throwing on an unknown zone', () => {
    expect(instantToDay('2026-05-31T18:15:00Z', 'Mars/Olympus')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns nothing when the window is unknown or unparseable', () => {
    expect(resolvedWindowLabel(undefined, undefined, NPT)).toBeUndefined();
    expect(resolvedWindowLabel('2026-06-01T00:00:00Z', undefined, NPT)).toBeUndefined();
    expect(resolvedWindowLabel('not-a-date', 'also-not', NPT)).toBeUndefined();
  });
});
