import { describe, expect, it } from 'vitest';

import { OTHER_KEY, arcs, rollUpSlices, type MixRow } from './donut';

/**
 * `noUncheckedIndexedAccess` is on, so every `slices[0]` is `T | undefined`.
 * Assert presence once here rather than littering the assertions with `!`
 * (same helper as reports/paginate.test.ts).
 */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined)
    throw new Error(`expected an element at index ${i}, got ${arr.length} items`);
  return v;
}

/** The last element, which is where a rolled-up "Other" always lands. */
function last<T>(arr: readonly T[]): T {
  return at(arr, arr.length - 1);
}

/** A row shaped like the /v1/reports/category-mix payload. */
function row(name: string, revenue: number, qty = 1): MixRow {
  return {
    category_id: `id-${name}`,
    name,
    qty,
    revenue_cents: revenue,
    // Deliberately wrong: nothing may depend on share_pct, because the server
    // rounds it and the rounded values don't sum to 100.
    share_pct: -1,
  };
}

describe('rollUpSlices', () => {
  it('keeps every category when they are few and none is tiny', () => {
    const s = rollUpSlices([row('Coffee', 5000), row('Food', 3000), row('Cake', 2000)]);
    expect(s.map((x) => x.name)).toEqual(['Coffee', 'Food', 'Cake']);
    expect(s.map((x) => x.sharePct)).toEqual([50, 30, 20]);
  });

  it('recomputes share from cents rather than trusting the payload', () => {
    const s = rollUpSlices([row('A', 1), row('B', 2)]);
    expect(at(s, 0).sharePct).toBeCloseTo(66.667, 2);
    expect(s.reduce((n, x) => n + x.sharePct, 0)).toBeCloseTo(100, 6);
  });

  it('sorts by revenue even if the payload is not sorted', () => {
    const s = rollUpSlices([row('Small', 100), row('Big', 900)]);
    expect(s.map((x) => x.name)).toEqual(['Big', 'Small']);
  });

  it('folds everything past maxSlices into one Other', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n, i) => row(n, 1000 - i));
    const s = rollUpSlices(rows, { maxSlices: 6, minPct: 0 });
    expect(s).toHaveLength(7);
    const other = last(s);
    expect(other.key).toBe(OTHER_KEY);
    expect(other.name).toBe('Other');
    expect(other.count).toBe(2);
    // 994 + 993
    expect(other.revenueCents).toBe(1987);
  });

  it('folds sub-threshold slices even inside the top N', () => {
    // Two slivers that would each render a couple of pixels wide.
    const s = rollUpSlices(
      [row('Coffee', 9800), row('Mints', 10), row('Straws', 10), row('Napkins', 10)],
      { maxSlices: 6, minPct: 1.5 },
    );
    expect(s.map((x) => x.name)).toEqual(['Coffee', 'Other']);
    expect(at(s, 1).count).toBe(3);
    expect(at(s, 1).qty).toBe(3);
  });

  it('names a lone straggler instead of calling it Other', () => {
    // An "Other" slice standing for exactly one category tells the reader less
    // than the category's own name would.
    const s = rollUpSlices([row('Coffee', 9900), row('Mints', 100)], { minPct: 5 });
    expect(s.map((x) => x.name)).toEqual(['Coffee', 'Mints']);
    expect(s.every((x) => x.key !== OTHER_KEY)).toBe(true);
  });

  it('sums Other qty and revenue across the folded rows', () => {
    const s = rollUpSlices(
      [row('Coffee', 9000, 90), row('A', 200, 5), row('B', 200, 7), row('C', 200, 3)],
      { minPct: 5 },
    );
    const other = last(s);
    expect(other.revenueCents).toBe(600);
    expect(other.qty).toBe(15);
  });

  it('carries the category colour and icon through', () => {
    const r = { ...row('Coffee', 100), color: '#ABCDEF', icon: 'coffee' };
    expect(at(rollUpSlices([r]), 0)).toMatchObject({ color: '#ABCDEF', icon: 'coffee' });
  });

  it('drops zero and negative revenue rows', () => {
    const s = rollUpSlices([row('Coffee', 1000), row('Free', 0), row('Refund', -50)]);
    expect(s.map((x) => x.name)).toEqual(['Coffee']);
    expect(at(s, 0).sharePct).toBe(100);
  });

  it('returns nothing for an empty or all-zero window', () => {
    expect(rollUpSlices([])).toEqual([]);
    expect(rollUpSlices([row('A', 0), row('B', 0)])).toEqual([]);
  });

  it('gives a single category the whole ring', () => {
    const s = rollUpSlices([row('Coffee', 4242)]);
    expect(s).toHaveLength(1);
    expect(at(s, 0).sharePct).toBe(100);
  });
});

describe('arcs', () => {
  const CIRC = 100;

  it('lays arcs end to end, starting at zero', () => {
    const s = rollUpSlices([row('A', 5000), row('B', 3000), row('C', 2000)]);
    const a = arcs(s, CIRC);
    expect(a.map((x) => x.dashOffset)).toEqual([-0, -50, -80]);
    expect(at(a, 0).dashArray).toBe('50 50');
    expect(at(a, 1).dashArray).toBe('30 70');
  });

  it('closes the ring exactly', () => {
    // Thirds: 33.33… each. The last arc takes the remainder, so the drawn
    // lengths must total the circumference with no hairline gap at the join.
    const s = rollUpSlices([row('A', 1), row('B', 1), row('C', 1)]);
    const a = arcs(s, CIRC);
    const drawn = a.reduce((n, x) => n + Number(x.dashArray.split(' ')[0]), 0);
    expect(drawn).toBeCloseTo(CIRC, 10);
  });

  it('gives one slice the full circumference', () => {
    const a = arcs(rollUpSlices([row('Only', 900)]), CIRC);
    expect(a).toHaveLength(1);
    expect(at(a, 0).dashArray).toBe('100 0');
    expect(at(a, 0).dashOffset).toBe(-0);
  });

  it('returns nothing when there is nothing to draw', () => {
    expect(arcs([], CIRC)).toEqual([]);
  });

  it('keys each arc to its slice so React can match them up', () => {
    const s = rollUpSlices([row('A', 2), row('B', 1)]);
    expect(arcs(s, CIRC).map((x) => x.key)).toEqual(s.map((x) => x.key));
  });

  it('carries each slice on its arc, in order', () => {
    // The renderer colours arcs from this rather than indexing back into the
    // slice array, so an arc can never be painted with its neighbour's colour.
    const s = rollUpSlices([row('A', 3), row('B', 2), row('C', 1)]);
    expect(arcs(s, CIRC).map((x) => x.slice)).toEqual(s);
  });
});
