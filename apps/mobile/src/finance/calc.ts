/**
 * Pure finance helpers for the shift + dashboard screens. No React, no I/O —
 * exhaustively unit-tested.
 */
import type { PaymentMix, DailyPoint } from '@cafe-mgmt/api-types';

/** Cash-count variance: counted − expected. Positive = over, negative = short. */
export function cashVariance(countedCents: number, expectedCents: number): number {
  return Math.round(countedCents) - Math.round(expectedCents);
}

export type VarianceTone = 'balanced' | 'over' | 'short';

/** Classify a variance for display (a tiny tolerance counts as balanced). */
export function varianceTone(varianceCents: number, toleranceCents = 0): VarianceTone {
  if (Math.abs(varianceCents) <= toleranceCents) return 'balanced';
  return varianceCents > 0 ? 'over' : 'short';
}

/** Split a payment mix into rounded percentages that sum to 100 (largest-
 * remainder), so the dashboard bar segments never over/underflow. */
export function paymentMixPercents(mix: PaymentMix): { cash: number; online: number; bank: number } {
  const raw = { cash: mix.cash_cents, online: mix.online_cents, bank: mix.bank_cents };
  const total = raw.cash + raw.online + raw.bank;
  if (total <= 0) return { cash: 0, online: 0, bank: 0 };
  const exact = {
    cash: (raw.cash / total) * 100,
    online: (raw.online / total) * 100,
    bank: (raw.bank / total) * 100,
  };
  const out = { cash: Math.floor(exact.cash), online: Math.floor(exact.online), bank: Math.floor(exact.bank) };
  let remainder = 100 - (out.cash + out.online + out.bank);
  // Hand the leftover points to the largest fractional parts first.
  const keys: ('cash' | 'online' | 'bank')[] = ['cash', 'online', 'bank'];
  keys.sort((a, b) => (exact[b] - out[b]) - (exact[a] - out[a]));
  for (const k of keys) {
    if (remainder <= 0) break;
    out[k] += 1;
    remainder -= 1;
  }
  return out;
}

export type Bar = { x: number; y: number; width: number; height: number };

/**
 * Lay out a simple bar chart for daily sales. Bars fill `width` with `gap`
 * between them; the tallest maps to `height`. Returns one Bar per point (x/y
 * from the top-left, SVG-style). An all-zero series yields zero-height bars.
 */
export function barGeometry(points: DailyPoint[], width: number, height: number, gap = 4): Bar[] {
  const n = points.length;
  if (n === 0 || width <= 0) return [];
  const max = Math.max(...points.map((p) => p.sales_cents), 0);
  const barWidth = Math.max(1, (width - gap * (n - 1)) / n);
  return points.map((p, i) => {
    const h = max > 0 ? (p.sales_cents / max) * height : 0;
    return { x: i * (barWidth + gap), y: height - h, width: barWidth, height: h };
  });
}
