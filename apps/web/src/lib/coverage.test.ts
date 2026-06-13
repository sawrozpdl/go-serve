import { describe, it, expect } from 'vitest';

import {
  toMinutes,
  fromMinutes,
  staffShift,
  shiftsUnion,
  coverageForDay,
  summariseCoverage,
  dayOpenRange,
} from '@/lib/coverage';

// Minimal staff-like shapes — only `schedule` is read by the coverage maths.
const person = (sched: Record<string, { start: string; end: string }>) => ({ schedule: sched });

describe('time conversions', () => {
  it('round-trips HH:MM through minutes', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('23:45')).toBe(1425);
    expect(fromMinutes(570)).toBe('09:30');
    expect(fromMinutes(0)).toBe('00:00');
  });
});

describe('staffShift', () => {
  it('reads a day range, ignoring off / inverted days', () => {
    const p = person({ '1': { start: '08:00', end: '16:00' } });
    expect(staffShift(p, '1')).toEqual({ start: 480, end: 960 });
    expect(staffShift(p, '2')).toBeNull(); // off
    expect(staffShift(person({ '1': { start: '16:00', end: '08:00' } }), '1')).toBeNull(); // inverted
  });
});

describe('coverageForDay', () => {
  it('counts overlapping shifts per slot', () => {
    const staff = [
      person({ '1': { start: '08:00', end: '12:00' } }),
      person({ '1': { start: '10:00', end: '14:00' } }),
      person({ '2': { start: '08:00', end: '12:00' } }), // different day
    ];
    const counts = coverageForDay(staff, '1', 60); // hourly slots
    expect(counts[8]).toBe(1); // 8–9: only A
    expect(counts[10]).toBe(2); // 10–11: A + B
    expect(counts[12]).toBe(1); // 12–13: only B
    expect(counts[14]).toBe(0); // 14–15: nobody
  });
});

describe('shiftsUnion + dayOpenRange', () => {
  it('spans every shift on the day', () => {
    const staff = [
      person({ '1': { start: '09:00', end: '17:00' } }),
      person({ '1': { start: '07:00', end: '11:00' } }),
    ];
    expect(shiftsUnion(staff, '1')).toEqual({ start: 420, end: 1020 });
    expect(shiftsUnion(staff, '3')).toBeNull();
  });

  it('reads the cafe open range', () => {
    const oh = { '1': { start: '08:00', end: '20:00' } };
    expect(dayOpenRange(oh, '1')).toEqual({ start: 480, end: 1200 });
    expect(dayOpenRange(oh, '0')).toBeNull();
  });
});

describe('summariseCoverage', () => {
  const slot = 60;
  // Open 08:00–14:00. A 08–12, B 10–14 → 8:1, 9:1, 10:2, 11:2, 12:1, 13:1.
  const staff = [
    person({ '1': { start: '08:00', end: '12:00' } }),
    person({ '1': { start: '10:00', end: '14:00' } }),
  ];
  const counts = coverageForDay(staff, '1', slot);
  const open = { start: 480, end: 840 }; // 08:00–14:00

  it('reports peak and lowest within the window', () => {
    const s = summariseCoverage(counts, slot, open, 2);
    expect(s.peak).toBe(2);
    expect(s.low).toBe(1);
    expect(s.lowWindow).toEqual({ start: 480, end: 600 }); // first run at the low (08–10)
  });

  it('flags thin spans below comfort and gaps at zero', () => {
    const s = summariseCoverage(counts, slot, open, 2);
    // Below comfort (2): 08–10 and 12–14.
    expect(s.thin).toEqual([
      { start: 480, end: 600 },
      { start: 720, end: 840 },
    ]);
    expect(s.gaps).toEqual([]); // never zero inside the window
  });

  it('detects an uncovered gap', () => {
    // Open 08:00–16:00 but everyone leaves at 12 → 12–16 is a gap.
    const open2 = { start: 480, end: 960 };
    const s = summariseCoverage(counts, slot, open2, 2);
    expect(s.low).toBe(0);
    expect(s.gaps).toEqual([{ start: 840, end: 960 }]); // 14–16 (B ends 14)
  });

  it('returns an empty summary when there is no window', () => {
    const s = summariseCoverage(counts, slot, null, 2);
    expect(s).toEqual({ window: null, peak: 0, low: 0, lowWindow: null, gaps: [], thin: [] });
  });
});
