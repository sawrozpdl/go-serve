import { describe, it, expect, vi, afterEach } from 'vitest';

import { todayIso, addDaysIso, yesterdayIso, daysUntil, fmtRelative, toneForDate } from './dates';

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
