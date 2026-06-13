// =========================================================================
// Staffing coverage maths for the staff timeline.
//
// Pure functions over the weekly schedule shape (`StaffSchedule`): given the
// active staff and a day, work out how many people are on shift through the
// day so the timeline can draw a coverage ribbon and surface thin spots.
// Coverage is purely informational — nothing here enforces a minimum.
// =========================================================================

import type { Staff, StaffSchedule } from '@/lib/api';

export const DAY_MIN = 24 * 60;

/** "HH:MM" 24h → minutes since midnight. Mirrors the helper in TimePicker. */
export function toMinutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes since midnight → "HH:MM" 24h (clamped to the day). */
export function fromMinutes(mins: number): string {
  const clamped = Math.max(0, Math.min(DAY_MIN, Math.round(mins)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A span of the day in minutes since midnight. */
export type Range = { start: number; end: number };

/** A contiguous span that holds a constant headcount. */
export type CoverRun = Range & { count: number };

/** The shift a staff member works on `dayKey`, in minutes, or null if off. */
export function staffShift(s: Pick<Staff, 'schedule'>, dayKey: string): Range | null {
  const r = s.schedule?.[dayKey];
  if (!r) return null;
  const start = toMinutes(r.start);
  const end = toMinutes(r.end);
  if (!(end > start)) return null;
  return { start, end };
}

/** The cafe's open span for `dayKey`, or null when closed / unset. */
export function dayOpenRange(openingHours: StaffSchedule | undefined, dayKey: string): Range | null {
  return staffShift({ schedule: openingHours ?? {} }, dayKey);
}

/** Smallest range covering every shift worked on `dayKey` (for axis fallback). */
export function shiftsUnion(staff: Pick<Staff, 'schedule'>[], dayKey: string): Range | null {
  let start = Infinity;
  let end = -Infinity;
  for (const s of staff) {
    const shift = staffShift(s, dayKey);
    if (!shift) continue;
    start = Math.min(start, shift.start);
    end = Math.max(end, shift.end);
  }
  return end > start ? { start, end } : null;
}

/**
 * Headcount per slot across the whole day. `counts[i]` is how many staff are on
 * shift during the slot `[i*slotMins, (i+1)*slotMins)`.
 */
export function coverageForDay(
  staff: Pick<Staff, 'schedule'>[],
  dayKey: string,
  slotMins = 15,
): number[] {
  const n = Math.ceil(DAY_MIN / slotMins);
  const counts = new Array<number>(n).fill(0);
  for (const s of staff) {
    const shift = staffShift(s, dayKey);
    if (!shift) continue;
    const from = Math.floor(shift.start / slotMins);
    const to = Math.ceil(shift.end / slotMins);
    for (let i = Math.max(0, from); i < to && i < n; i++) counts[i] = (counts[i] ?? 0) + 1;
  }
  return counts;
}

/** Group the slots inside `window` into contiguous equal-headcount runs. */
export function runsWithin(counts: number[], slotMins: number, window: Range): CoverRun[] {
  const runs: CoverRun[] = [];
  const from = Math.floor(window.start / slotMins);
  const to = Math.ceil(window.end / slotMins);
  for (let i = from; i < to; i++) {
    const count = counts[i] ?? 0;
    const start = Math.max(window.start, i * slotMins);
    const end = Math.min(window.end, (i + 1) * slotMins);
    if (end <= start) continue;
    const last = runs[runs.length - 1];
    if (last && last.count === count && last.end === start) {
      last.end = end;
    } else {
      runs.push({ start, end, count });
    }
  }
  return runs;
}

export type CoverageSummary = {
  /** The window coverage was evaluated over (open hours, else union of shifts). */
  window: Range | null;
  /** Highest headcount seen in the window. */
  peak: number;
  /** Lowest headcount seen in the window. */
  low: number;
  /** A representative span sitting at `low` (earliest such run). */
  lowWindow: Range | null;
  /** Spans where nobody is on shift during the window. */
  gaps: Range[];
  /** Spans staffed below `comfort` (includes gaps). Empty when comfort ≤ 0. */
  thin: Range[];
};

/**
 * Summarise a day's coverage within an evaluation window. Pass the cafe's open
 * range when known; otherwise the caller's fallback (e.g. union of shifts).
 */
export function summariseCoverage(
  counts: number[],
  slotMins: number,
  window: Range | null,
  comfort: number,
): CoverageSummary {
  if (!window || window.end <= window.start) {
    return { window, peak: 0, low: 0, lowWindow: null, gaps: [], thin: [] };
  }
  const runs = runsWithin(counts, slotMins, window);
  let peak = 0;
  let low = Infinity;
  for (const r of runs) {
    peak = Math.max(peak, r.count);
    low = Math.min(low, r.count);
  }
  if (!Number.isFinite(low)) low = 0;

  const lowWindow = runs.find((r) => r.count === low) ?? null;
  const gaps = mergeAdjacent(runs.filter((r) => r.count === 0));
  const thin = comfort > 0 ? mergeAdjacent(runs.filter((r) => r.count < comfort)) : [];

  return {
    window,
    peak,
    low,
    lowWindow: lowWindow ? { start: lowWindow.start, end: lowWindow.end } : null,
    gaps,
    thin,
  };
}

/** Merge ranges that touch end-to-start into single spans. */
function mergeAdjacent(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}
