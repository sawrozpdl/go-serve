import type { PaymentMix, DailyPoint, Shift, ShiftPayment } from '@cafe-mgmt/api-types';
import {
  cashVariance,
  varianceTone,
  paymentMixPercents,
  barGeometry,
  findVarianceMatch,
  latestClose,
} from '../calc';

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

describe('findVarianceMatch', () => {
  const pay = (over: Partial<ShiftPayment>): ShiftPayment => ({
    id: 'p1',
    order_id: 'o1',
    method: 'cash',
    amount_cents: 35000,
    reference_no: '',
    recorded_at: '2026-07-29T09:00:00Z',
    ...over,
  });

  it('is silent without a variance to explain', () => {
    expect(findVarianceMatch([pay({})], null)).toBeNull();
    expect(findVarianceMatch([pay({})], 0)).toBeNull();
  });

  it('short by one cash payment suggests flipping it to online', () => {
    const p = pay({ id: 'pc' });
    expect(findVarianceMatch([p], -35000)).toEqual({ payment: p, to: 'online' });
  });

  it('over by one online payment suggests flipping it to cash', () => {
    const p = pay({ id: 'po', method: 'other' });
    expect(findVarianceMatch([p], 35000)).toEqual({ payment: p, to: 'cash' });
  });

  it('ignores payments on the same side as the variance', () => {
    // Short means expected holds cash that isn't there — an online payment of
    // the same amount explains nothing.
    expect(findVarianceMatch([pay({ method: 'other' })], -35000)).toBeNull();
    expect(findVarianceMatch([pay({ method: 'cash' })], 35000)).toBeNull();
  });

  it('excludes credit charges — they never touched the drawer', () => {
    expect(findVarianceMatch([pay({ method: 'house_tab' })], 35000)).toBeNull();
  });

  it('stays silent when two payments could equally be the culprit', () => {
    const a = pay({ id: 'a' });
    const b = pay({ id: 'b' });
    expect(findVarianceMatch([a, b], -35000)).toBeNull();
  });

  it('ignores amounts that do not match the variance exactly', () => {
    expect(findVarianceMatch([pay({ amount_cents: 34900 })], -35000)).toBeNull();
  });
});

describe('latestClose', () => {
  const shift = (over: Partial<Shift>): Shift =>
    ({
      id: 's1',
      opened_by_user_id: 'u1',
      opened_at: '2026-07-28T03:00:00Z',
      opening_float_cents: 500000,
      notes: '',
      live_expected_cash_cents: 0,
      live_cash_count_cents: 0,
      live_cash_in_cents: 0,
      live_cash_out_cents: 0,
      ...over,
    }) as Shift;

  it('returns undefined when there is nothing closed', () => {
    expect(latestClose([])).toBeUndefined();
    expect(latestClose([shift({})])).toBeUndefined();
  });

  it('skips a closed shift whose count was never recorded', () => {
    expect(latestClose([shift({ closed_at: '2026-07-28T15:00:00Z' })])).toBeUndefined();
  });

  it('picks the newest closed_at regardless of list order', () => {
    const older = shift({ id: 'old', closed_at: '2026-07-27T15:00:00Z', closing_count_cents: 100 });
    const newer = shift({ id: 'new', closed_at: '2026-07-28T15:00:00Z', closing_count_cents: 200 });
    // Server orders by opened_at, so the newest close can arrive second.
    expect(latestClose([older, newer])?.id).toBe('new');
    expect(latestClose([newer, older])?.id).toBe('new');
  });

  it('ignores the still-open shift alongside closed ones', () => {
    const open = shift({ id: 'open' });
    const closed = shift({ id: 'closed', closed_at: '2026-07-28T15:00:00Z', closing_count_cents: 200 });
    expect(latestClose([open, closed])?.id).toBe('closed');
  });
});
