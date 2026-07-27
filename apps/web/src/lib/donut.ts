/* Donut-chart maths for the category mix.
 *
 * Two jobs, both of which the old stacked bar got wrong:
 *
 * 1. Roll up the tail. The endpoint returns every category a tenant has, so a
 *    24-category menu produced a dozen sub-1% segments — several of them
 *    narrower than the bar's own corner radius, i.e. invisible. Everything past
 *    the top N, plus anything under a minimum share, collapses into one "Other".
 *
 * 2. Derive arcs from revenue, never from `share_pct`. The server rounds share
 *    to 2dp, so the shares sum to 99.98–100.02 and a ring built from them either
 *    overlaps or leaves a hairline gap at the 12 o'clock join. Summing cents and
 *    dividing keeps the ring exactly closed.
 */

export type MixRow = {
  category_id: string;
  name: string;
  color?: string | null;
  icon?: string;
  qty: number;
  revenue_cents: number;
  share_pct: number;
};

export type Slice = {
  /** `__other__` for the rolled-up bucket, else the category id. */
  key: string;
  name: string;
  color?: string | null;
  icon?: string;
  qty: number;
  revenueCents: number;
  /** Recomputed from cents, so the slices always total 100. */
  sharePct: number;
  /** How many categories this slice stands for (>1 only for "Other"). */
  count: number;
};

export const OTHER_KEY = '__other__';

export type RollUpOptions = {
  /** Named slices to keep before the rest becomes "Other". */
  maxSlices?: number;
  /** Slices under this share are rolled up even inside the top N. */
  minPct?: number;
};

/**
 * Reduce the raw rows to a drawable set of slices, largest first, with a single
 * trailing "Other" when anything was folded in.
 *
 * Rows arrive revenue-sorted from the API, but we sort defensively — the roll-up
 * is only correct if the tail really is the tail.
 */
export function rollUpSlices(rows: MixRow[], opts: RollUpOptions = {}): Slice[] {
  const maxSlices = opts.maxSlices ?? 6;
  const minPct = opts.minPct ?? 1.5;

  const positive = rows.filter((r) => r.revenue_cents > 0);
  const total = positive.reduce((n, r) => n + r.revenue_cents, 0);
  if (total <= 0) return [];

  const sorted = [...positive].sort((a, b) => b.revenue_cents - a.revenue_cents);
  const pct = (cents: number) => (cents / total) * 100;

  const kept: Slice[] = [];
  const folded: MixRow[] = [];
  for (const r of sorted) {
    const share = pct(r.revenue_cents);
    if (kept.length < maxSlices && share >= minPct) {
      kept.push({
        key: r.category_id,
        name: r.name,
        color: r.color,
        icon: r.icon,
        qty: r.qty,
        revenueCents: r.revenue_cents,
        sharePct: share,
        count: 1,
      });
    } else {
      folded.push(r);
    }
  }

  // One straggler is worth naming — an "Other" slice standing for a single
  // category is strictly less informative than the category itself.
  const only = folded.length === 1 ? folded[0] : undefined;
  if (only) {
    const r = only;
    kept.push({
      key: r.category_id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      qty: r.qty,
      revenueCents: r.revenue_cents,
      sharePct: pct(r.revenue_cents),
      count: 1,
    });
    return kept;
  }

  if (folded.length > 1) {
    const cents = folded.reduce((n, r) => n + r.revenue_cents, 0);
    kept.push({
      key: OTHER_KEY,
      name: 'Other',
      qty: folded.reduce((n, r) => n + r.qty, 0),
      revenueCents: cents,
      sharePct: pct(cents),
      count: folded.length,
    });
  }

  return kept;
}

export type Arc = {
  key: string;
  /** The slice this arc draws, carried along so the caller never has to pair
   *  arcs back to slices by index. */
  slice: Slice;
  /** `stroke-dasharray` for an SVG circle: drawn length, then the remainder. */
  dashArray: string;
  /** `stroke-dashoffset` placing this arc after the previous ones. */
  dashOffset: number;
};

/**
 * Turn slices into SVG circle stroke dashes on a ring of circumference `circ`.
 *
 * SVG dashes start at 3 o'clock and run clockwise; the caller rotates the group
 * -90° so the first slice begins at the top. Offsets are negative cumulative
 * lengths, which is how you push a dash *forward* along the path.
 */
export function arcs(slices: Slice[], circ: number): Arc[] {
  const total = slices.reduce((n, s) => n + s.revenueCents, 0);
  if (total <= 0) return [];

  const out: Arc[] = [];
  let used = 0;
  slices.forEach((s, i) => {
    // Give the last slice whatever length is left rather than its own rounded
    // share, so accumulated float error can't leave a gap at the join.
    const len =
      i === slices.length - 1 ? circ - used : (s.revenueCents / total) * circ;
    out.push({
      key: s.key,
      slice: s,
      dashArray: `${len} ${circ - len}`,
      dashOffset: -used,
    });
    used += len;
  });
  return out;
}
