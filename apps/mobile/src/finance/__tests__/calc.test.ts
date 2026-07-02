import type { PaymentMix, DailyPoint } from '@cafe-mgmt/api-types';
import { cashVariance, varianceTone, paymentMixPercents, barGeometry } from '../calc';

describe('cashVariance', () => {
  it('is counted minus expected', () => {
    expect(cashVariance(10000, 9500)).toBe(500);
    expect(cashVariance(9000, 9500)).toBe(-500);
    expect(cashVariance(9500, 9500)).toBe(0);
  });
  it('rounds fractional cents', () => {
    expect(cashVariance(100.4, 0)).toBe(100);
  });
});

describe('varianceTone', () => {
  it('classifies over / short / balanced', () => {
    expect(varianceTone(500)).toBe('over');
    expect(varianceTone(-500)).toBe('short');
    expect(varianceTone(0)).toBe('balanced');
  });
  it('honours a tolerance band', () => {
    expect(varianceTone(50, 100)).toBe('balanced');
    expect(varianceTone(-50, 100)).toBe('balanced');
    expect(varianceTone(150, 100)).toBe('over');
  });
});

describe('paymentMixPercents', () => {
  const mix = (cash: number, online: number, bank: number): PaymentMix => ({
    cash_cents: cash,
    online_cents: online,
    bank_cents: bank,
  });

  it('is all zero for an empty mix', () => {
    expect(paymentMixPercents(mix(0, 0, 0))).toEqual({ cash: 0, online: 0, bank: 0 });
  });

  it('splits evenly', () => {
    expect(paymentMixPercents(mix(100, 100, 100))).toEqual({ cash: 34, online: 33, bank: 33 });
  });

  it('always sums to 100 (largest-remainder)', () => {
    const p = paymentMixPercents(mix(1, 1, 1));
    expect(p.cash + p.online + p.bank).toBe(100);
    const q = paymentMixPercents(mix(333, 333, 334));
    expect(q.cash + q.online + q.bank).toBe(100);
  });

  it('handles a single bucket', () => {
    expect(paymentMixPercents(mix(500, 0, 0))).toEqual({ cash: 100, online: 0, bank: 0 });
  });
});

describe('barGeometry', () => {
  const pts = (vals: number[]): DailyPoint[] => vals.map((v, i) => ({ day: `d${i}`, sales_cents: v }));

  it('returns empty for no points or zero width', () => {
    expect(barGeometry([], 100, 50)).toEqual([]);
    expect(barGeometry(pts([1, 2]), 0, 50)).toEqual([]);
  });

  it('maps the tallest bar to full height and positions from top-left', () => {
    const bars = barGeometry(pts([50, 100]), 100, 40, 0);
    expect(bars).toHaveLength(2);
    expect(bars[1].height).toBe(40); // tallest → full height
    expect(bars[0].height).toBe(20); // half
    expect(bars[1].y).toBe(0); // full bar starts at the top
    expect(bars[0].y).toBe(20);
    expect(bars[0].x).toBe(0);
    expect(bars[1].x).toBeCloseTo(50); // second bar offset by barWidth (gap 0)
  });

  it('gives zero-height bars for an all-zero series', () => {
    const bars = barGeometry(pts([0, 0, 0]), 90, 30);
    expect(bars.every((b) => b.height === 0)).toBe(true);
    expect(bars).toHaveLength(3);
  });

  it('accounts for gaps in bar width', () => {
    const [b0] = barGeometry(pts([1, 1]), 100, 20, 10);
    expect(b0.width).toBe(45); // (100 - 10) / 2
  });
});
