import { describe, it, expect } from 'vitest';

import { chartPeriodLabel, dailyAverage, isoDayInTz, type DailyPointLike } from './dailyAverage';

/** Build a contiguous series ending on `last`, one point per day. */
function series(last: string, days: number, cents: (i: number) => number): DailyPointLike[] {
  const out: DailyPointLike[] = [];
  const end = new Date(`${last}T00:00:00`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    out.push({ day: key, sales_cents: cents(days - 1 - i) });
  }
  return out;
}

describe('isoDayInTz', () => {
  it('rolls an evening UTC instant forward into the cafe\'s next day', () => {
    // 18:20Z is 00:05 the next day in Kathmandu (UTC+05:45) — the exact case
    // that made a UTC day key mark the wrong bar as today.
    expect(isoDayInTz('2026-09-15T18:20:00Z', 'Asia/Kathmandu')).toBe('2026-09-16');
  });

  it('keeps a midday instant on the same day', () => {
    expect(isoDayInTz('2026-09-15T06:00:00Z', 'Asia/Kathmandu')).toBe('2026-09-15');
  });

  it('falls back to the local calendar for an unknown zone rather than throwing', () => {
    expect(isoDayInTz('2026-09-15T06:00:00Z', 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty for an unparseable instant', () => {
    expect(isoDayInTz('nonsense', 'Asia/Kathmandu')).toBe('');
  });
});

describe('dailyAverage', () => {
  it('range=today: averages the completed days the chart DRAWS, not today alone', () => {
    // THE REGRESSION. The dashboard opens on range=today, and the API charts
    // that month-to-date. Clamping the average to the requested one-day window
    // left zero completed days and printed today's half-finished takings under
    // a label reading "avg /day".
    //
    // The caller passes daily_from/daily_to — the span `daily` actually covers
    // and the span maxBar scales the average line against.
    const daily = series('2026-09-27', 27, (i) => (i === 26 ? 5_000 : 100_000));
    const got = dailyAverage(daily, {
      from: '2026-09-01', // daily_from: the 1st, not today
      to: '2026-09-27', // daily_to
      timezone: 'Asia/Kathmandu',
      today: '2026-09-27',
    });
    expect(got.basis).toBe('completed');
    expect(got.days).toBe(26); // 01–26 Sep, every finished day on the chart
    expect(got.avgCents).toBe(100_000); // NOT dragged down by today's 5_000
    expect(got.caption).toContain('26 completed days');
  });

  it('range=yesterday: month-to-date through yesterday, every bar finished', () => {
    const daily = series('2026-09-26', 26, () => 40_000);
    const got = dailyAverage(daily, {
      from: '2026-09-01',
      to: '2026-09-26',
      timezone: 'Asia/Kathmandu',
      today: '2026-09-27',
    });
    expect(got.days).toBe(26);
    expect(got.avgCents).toBe(40_000);
  });

  it('range=today on the 1st: the only bar is today, shown as partial', () => {
    const daily = series('2026-10-01', 1, () => 3_000);
    const got = dailyAverage(daily, {
      from: '2026-10-01',
      to: '2026-10-01',
      timezone: 'Asia/Kathmandu',
      today: '2026-10-01',
    });
    expect(got.basis).toBe('includes-today');
    expect(got.avgCents).toBe(3_000);
  });

  it('reproduces the production figures that surfaced the bug', () => {
    // Sahan Cafe, 2026-09-16. Fifteen real days off the production database.
    // The owner expected ~10k/day and the dashboard showed ~1.8k — today's
    // takings so far, which is what a one-day window averages to.
    const rupees = [
      7_275, 9_755, 8_660, 9_975, 14_630, 12_765, 9_665, 13_105, 10_380, 12_980,
      13_440, 9_990, 9_105, 12_190, 10_375,
    ];
    const daily: DailyPointLike[] = rupees.map((r, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, '0')}`,
      sales_cents: r * 100,
    }));
    daily.push({ day: '2026-09-16', sales_cents: 1_800 * 100 }); // today, partial

    const got = dailyAverage(daily, {
      from: '2026-09-01', // daily_from: month-to-date
      to: '2026-09-16',
      timezone: 'Asia/Kathmandu',
      today: '2026-09-16',
    });
    expect(got.basis).toBe('completed');
    expect(got.days).toBe(15); // 01–15 Sep
    // Σ 164_290 / 15 = ₹10,952.67/day — the ten-thousand-ish figure the owner
    // knows, and nowhere near the ₹1,800 the clamped version reported.
    expect(got.avgCents).toBe(1_095_267);
  });

  it('a from–to range averages exactly the days requested', () => {
    // 30d is charted exactly as picked, so daily_from === from and the clamp is
    // a no-op.
    const daily = series('2026-09-15', 30, () => 10_000);
    const got = dailyAverage(daily, {
      from: '2026-08-17',
      to: '2026-09-15',
      timezone: 'Asia/Kathmandu',
      today: '2026-09-15',
    });
    expect(got.basis).toBe('completed');
    expect(got.days).toBe(29); // the 15th is still being traded
    expect(got.avgCents).toBe(10_000);
  });

  it('counts a completed zero-sales day — a closed day is a real zero', () => {
    const daily: DailyPointLike[] = [
      { day: '2026-09-12', sales_cents: 30_000 },
      { day: '2026-09-13', sales_cents: 0 },
      { day: '2026-09-14', sales_cents: 30_000 },
    ];
    const got = dailyAverage(daily, {
      from: '2026-09-12',
      to: '2026-09-14',
      timezone: 'Asia/Kathmandu',
      today: '2026-09-15',
    });
    expect(got.days).toBe(3);
    expect(got.avgCents).toBe(20_000);
  });

  it('a fully past custom range counts every day in it', () => {
    const daily = series('2026-08-31', 31, () => 12_345);
    const got = dailyAverage(daily, {
      from: '2026-08-01',
      to: '2026-08-31',
      timezone: 'Asia/Kathmandu',
      today: '2026-09-15',
    });
    expect(got.basis).toBe('completed');
    expect(got.days).toBe(31);
    expect(got.avgCents).toBe(12_345);
  });

  it('rounds to whole paisa', () => {
    const daily: DailyPointLike[] = [
      { day: '2026-09-13', sales_cents: 100 },
      { day: '2026-09-14', sales_cents: 101 },
    ];
    const got = dailyAverage(daily, { from: '2026-09-13', to: '2026-09-14', today: '2026-09-15' });
    expect(got.avgCents).toBe(101); // 100.5 → 101, never a fractional paisa
  });

  it('reports "none" for an empty series rather than a confident zero', () => {
    const got = dailyAverage([], { from: '2026-09-01', to: '2026-09-07', today: '2026-09-15' });
    expect(got.basis).toBe('none');
    expect(got.days).toBe(0);
    expect(got.avgCents).toBe(0);
  });

  it('without from/to still excludes today', () => {
    const daily = series('2026-09-15', 3, () => 8_000);
    const got = dailyAverage(daily, { today: '2026-09-15' });
    expect(got.days).toBe(2);
  });

  it('captions name the span so the basis is visible, not implied', () => {
    const daily = series('2026-09-14', 3, () => 1_000);
    const got = dailyAverage(daily, {
      from: '2026-09-12',
      to: '2026-09-14',
      today: '2026-09-15',
    });
    expect(got.caption).toContain('3 completed days');
    expect(got.caption).toContain('Sep');
  });
});

describe('chartPeriodLabel', () => {
  it('names the span the bars cover', () => {
    expect(chartPeriodLabel('2026-09-01', '2026-09-27')).toBe('Sep 1 – Sep 27');
    expect(chartPeriodLabel('2026-08-28', '2026-09-03')).toBe('Aug 28 – Sep 3');
  });

  it('is one date for a single bar', () => {
    expect(chartPeriodLabel('2026-10-01', '2026-10-01')).toBe('Oct 1');
  });

  it('adds years when the span crosses one', () => {
    expect(chartPeriodLabel('2026-12-29', '2027-01-04')).toBe('Dec 29, 2026 – Jan 4, 2027');
  });

  it('is empty with no bars', () => {
    expect(chartPeriodLabel(undefined, undefined)).toBe('');
  });
});
