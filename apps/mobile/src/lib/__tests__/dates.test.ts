/**
 * Day arithmetic shared by History and Expenses. Every case pins its inputs:
 * these are the functions that decide which day's money you are looking at.
 */
import {
  todayStr,
  shiftDay,
  formatDayLabel,
  isToday,
  startOfMonth,
  nowHHMM,
  shiftMonth,
  monthLabel,
  monthMatrix,
} from '../dates';

describe('todayStr', () => {
  it('reads the LOCAL calendar, not UTC', () => {
    // 2026-09-09 23:30 local. Under +05:45 the UTC date is still the 9th, but
    // under a negative offset toISOString() would say the 10th — which is why
    // this reads the local fields instead.
    const d = new Date(2026, 8, 9, 23, 30);
    expect(todayStr(d)).toBe('2026-09-09');
  });

  it('pads single-digit months and days', () => {
    expect(todayStr(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('shiftDay', () => {
  it('crosses a month boundary', () => {
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('crosses a year boundary', () => {
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('is a no-op at zero', () => {
    expect(shiftDay('2026-09-09', 0)).toBe('2026-09-09');
  });
});

describe('formatDayLabel', () => {
  it('names today and yesterday, and dates the rest', () => {
    expect(formatDayLabel('2026-09-09', '2026-09-09')).toBe('Today');
    expect(formatDayLabel('2026-09-08', '2026-09-09')).toBe('Yesterday');
    expect(formatDayLabel('2026-09-01', '2026-09-09')).toMatch(/Sep/);
  });

  it('defaults `today` to the real clock', () => {
    expect(formatDayLabel(todayStr())).toBe('Today');
  });
});

describe('isToday', () => {
  it('compares against the given day', () => {
    expect(isToday('2026-09-09', '2026-09-09')).toBe(true);
    expect(isToday('2026-09-08', '2026-09-09')).toBe(false);
  });

  it('defaults to the real clock', () => {
    expect(isToday(todayStr())).toBe(true);
  });
});

describe('startOfMonth', () => {
  it('is the 1st of the same month', () => {
    expect(startOfMonth('2026-09-23')).toBe('2026-09-01');
  });
});

describe('nowHHMM', () => {
  it('is local wall-clock, zero-padded', () => {
    expect(nowHHMM(new Date(2026, 8, 9, 9, 5))).toBe('09:05');
  });

  it('defaults to the real clock', () => {
    expect(nowHHMM()).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('shiftMonth', () => {
  it('clamps the day rather than rolling into the next month', () => {
    // Date.setMonth would answer 2026-03-03 here. An operator stepping back
    // from 31 March means February, not "somewhere in March".
    expect(shiftMonth('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonth('2028-03-31', -1)).toBe('2028-02-29');
  });

  it('keeps the day when the target month is long enough', () => {
    expect(shiftMonth('2026-09-15', -1)).toBe('2026-08-15');
    expect(shiftMonth('2026-09-15', 1)).toBe('2026-10-15');
  });

  it('crosses a year boundary', () => {
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-15');
    expect(shiftMonth('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('monthLabel', () => {
  it('names the month and year', () => {
    expect(monthLabel('2026-09-23')).toBe('September 2026');
  });
});

describe('monthMatrix', () => {
  it('lays out whole Sunday-first weeks, blanks padded with null', () => {
    // September 2026 starts on a Tuesday and has 30 days.
    const weeks = monthMatrix('2026-09-09');
    expect(weeks[0].slice(0, 2)).toEqual([null, null]);
    expect(weeks[0][2]).toBe('2026-09-01');
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
    expect(weeks.flat().at(-1)).toBeNull();
  });

  it('needs no leading blanks when the month opens on a Sunday', () => {
    // February 2026 starts on a Sunday.
    const weeks = monthMatrix('2026-02-14');
    expect(weeks[0][0]).toBe('2026-02-01');
    expect(weeks.flat().filter(Boolean)).toHaveLength(28);
  });

  it('covers a 31-day month that ends mid-week', () => {
    expect(monthMatrix('2026-01-01').flat().filter(Boolean)).toHaveLength(31);
  });
});
