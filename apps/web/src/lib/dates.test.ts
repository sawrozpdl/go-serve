import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  todayIso, addDaysIso, yesterdayIso, daysUntil, fmtRelative, toneForDate, toneForDueDate,
  formatElapsed, timeAgo,
} from './dates';

const DAY = 86_400_000;

/** Freeze the clock so the relative helpers are deterministic. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}
afterEach(() => vi.useRealTimers());

// Formatting helpers (fmtDay / fmtDayLong) go through toLocaleDateString and
// are therefore locale-dependent — deliberately not asserted here. What matters
// for correctness is the arithmetic below.

describe('ISO day arithmetic', () => {
  it('steps across a month boundary', () => {
    expect(addDaysIso('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles a leap day', () => {
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('derives today/yesterday from the local calendar, not UTC', () => {
    // 23:00 local on the 3rd must still be the 3rd — the classic off-by-one.
    at('2026-08-03T23:00:00');
    expect(todayIso()).toBe('2026-08-03');
    expect(yesterdayIso()).toBe('2026-08-02');
  });
});

describe('daysUntil', () => {
  it('is positive for the future and negative for the past', () => {
    at('2026-08-03T12:00:00Z');
    expect(daysUntil(new Date(Date.now() + 30 * DAY).toISOString())).toBe(30);
    expect(daysUntil(new Date(Date.now() - 5 * DAY).toISOString())).toBe(-5);
  });

  it('rounds to the nearest whole day', () => {
    at('2026-08-03T12:00:00Z');
    expect(daysUntil(new Date(Date.now() + 0.4 * DAY).toISOString())).toBe(0);
    expect(daysUntil(new Date(Date.now() + 0.6 * DAY).toISOString())).toBe(1);
  });
});

describe('fmtRelative', () => {
  it('phrases past, present and future', () => {
    at('2026-08-03T12:00:00Z');
    expect(fmtRelative(new Date(Date.now()).toISOString())).toBe('today');
    expect(fmtRelative(new Date(Date.now() + 1 * DAY).toISOString())).toBe('in 1 day');
    expect(fmtRelative(new Date(Date.now() + 3 * DAY).toISOString())).toBe('in 3 days');
    expect(fmtRelative(new Date(Date.now() - 1 * DAY).toISOString())).toBe('1 day ago');
    expect(fmtRelative(new Date(Date.now() - 5 * DAY).toISOString())).toBe('5 days ago');
  });

  it('is empty rather than "—" when there is no date', () => {
    // Callers pair it with a date line that shows its own fallback; an em dash
    // here would render "— —".
    expect(fmtRelative(undefined)).toBe('');
    expect(fmtRelative(null)).toBe('');
  });
});

describe('toneForDate', () => {
  it('grades lapsed, soon and comfortable', () => {
    at('2026-08-03T12:00:00Z');
    expect(toneForDate(new Date(Date.now() - 1 * DAY).toISOString())).toBe('critical');
    expect(toneForDate(new Date(Date.now() + 14 * DAY).toISOString())).toBe('warn');
    expect(toneForDate(new Date(Date.now() + 15 * DAY).toISOString())).toBe('ok');
  });

  it('is neutral, not alarming, when there is no date', () => {
    expect(toneForDate(undefined)).toBe('neutral');
  });
});

describe('toneForDueDate', () => {
  // The bug this exists to avoid: toneForDate runs a bare "2026-08-07" through
  // `new Date()`, which reads it as UTC midnight. Anywhere east of Greenwich
  // that is already in the past by breakfast, so a lead due TODAY renders as
  // overdue — the loudest possible way to say the wrong thing.
  it('calls a follow-up due today "warn", not "critical"', () => {
    at('2026-08-07T18:50:00+05:45');
    expect(toneForDueDate(todayIso())).toBe('warn');
    expect(toneForDate(todayIso())).toBe('critical'); // documents why the split exists
  });

  it('grades past and future days', () => {
    at('2026-08-07T09:00:00Z');
    expect(toneForDueDate('2026-08-06')).toBe('critical');
    expect(toneForDueDate('2026-08-08')).toBe('neutral');
  });

  it('is neutral when nothing is booked', () => {
    expect(toneForDueDate(undefined)).toBe('neutral');
    expect(toneForDueDate(null)).toBe('neutral');
  });
});

describe('formatElapsed / timeAgo', () => {
  const NOW = Date.parse('2026-08-21T12:00:00Z');
  const ago = (ms: number) => timeAgo(new Date(NOW - ms).toISOString(), NOW);

  it('steps through seconds, minutes and hours', () => {
    expect(ago(45_000)).toBe('45s');
    expect(ago(12 * 60_000)).toBe('12m');
    expect(ago(3 * 3_600_000)).toBe('3h');
  });

  it('rolls over into days at 24h — the "777h" bug', () => {
    expect(ago(23 * 3_600_000 + 59 * 60_000)).toBe('23h');
    expect(ago(24 * 3_600_000)).toBe('1d');
    expect(ago(777 * 3_600_000)).toBe('32d');
  });

  it('clamps a future timestamp instead of going negative', () => {
    expect(timeAgo(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe('0s');
  });

  it('is an em dash for an unparseable timestamp', () => {
    expect(timeAgo('not-a-date', NOW)).toBe('—');
    expect(formatElapsed(NaN)).toBe('—');
  });
});
