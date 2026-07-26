import type { HistoryCreditCollection, HistoryOrder } from '@cafe-mgmt/api-types';
import { todayStr, shiftDay, formatDayLabel, isToday, summarizeHistory } from '../summary';

describe('todayStr', () => {
  it('formats local Y-M-D with zero-padding', () => {
    expect(todayStr(new Date(2026, 6, 2))).toBe('2026-07-02');
    expect(todayStr(new Date(2026, 0, 9))).toBe('2026-01-09');
  });
});

describe('default-arg paths (use the real clock)', () => {
  it('run without throwing when no date/today is passed', () => {
    expect(typeof todayStr()).toBe('string');
    expect(typeof formatDayLabel(todayStr())).toBe('string');
    expect(typeof isToday(todayStr())).toBe('boolean');
    expect(isToday(todayStr())).toBe(true);
  });
});

describe('shiftDay', () => {
  it('adds/subtracts days across month + year boundaries', () => {
    expect(shiftDay('2026-07-02', -1)).toBe('2026-07-01');
    expect(shiftDay('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('formatDayLabel', () => {
  const today = '2026-07-02';
  it('labels today + yesterday, else a weekday date', () => {
    expect(formatDayLabel('2026-07-02', today)).toBe('Today');
    expect(formatDayLabel('2026-07-01', today)).toBe('Yesterday');
    expect(formatDayLabel('2026-06-15', today)).toMatch(/Jun 15/);
  });
});

describe('isToday', () => {
  it('is true only for the current day', () => {
    expect(isToday('2026-07-02', '2026-07-02')).toBe(true);
    expect(isToday('2026-07-01', '2026-07-02')).toBe(false);
  });
});

describe('summarizeHistory', () => {
  const order = (total: number, payments: { method: string; amount_cents: number }[]): HistoryOrder =>
    ({
      id: 'o',
      opened_at: '',
      closed_at: '',
      notes: '',
      subtotal_cents: total,
      discount_cents: 0,
      tax_cents: 0,
      service_charge_cents: 0,
      total_cents: total,
      item_count: 1,
      items: [],
      payments: payments.map((p, i) => ({ id: `p${i}`, reference_no: '', reclassifiable: false, ...p })),
    }) as unknown as HistoryOrder;

  const collection = (amount: number, method = 'cash'): HistoryCreditCollection =>
    ({
      id: `c-${amount}-${method}`,
      house_tab_id: 'ht',
      house_tab_name: 'Regular',
      method,
      amount_cents: amount,
      reference_no: '',
      recorded_at: '',
    }) as unknown as HistoryCreditCollection;

  it('is zeroed for an empty day', () => {
    expect(summarizeHistory([])).toEqual({
      orderCount: 0,
      salesCents: 0,
      cashCents: 0,
      onlineCents: 0,
      tabCents: 0,
      creditCollectedCents: 0,
      creditCollectedCount: 0,
    });
  });

  it('sums sales and splits payments cash / online / house-tab', () => {
    const s = summarizeHistory([
      order(1000, [{ method: 'cash', amount_cents: 1000 }]),
      order(500, [{ method: 'online', amount_cents: 500 }]),
      order(800, [{ method: 'house_tab', amount_cents: 800 }]),
      order(600, [{ method: 'cash', amount_cents: 200 }, { method: 'esewa', amount_cents: 400 }]),
    ]);
    expect(s.orderCount).toBe(4);
    expect(s.salesCents).toBe(2900);
    expect(s.cashCents).toBe(1200);
    expect(s.onlineCents).toBe(900); // 500 online + 400 esewa (legacy → online)
    expect(s.tabCents).toBe(800);
  });

  // The whole point of the credit-collected field: it is money in, but it must
  // never move the day's sales total.
  it('carries credit collected without adding it to sales', () => {
    const s = summarizeHistory(
      [order(1000, [{ method: 'cash', amount_cents: 1000 }])],
      [collection(700), collection(300, 'other')],
    );
    expect(s.salesCents).toBe(1000);
    expect(s.cashCents).toBe(1000);
    expect(s.creditCollectedCents).toBe(1000);
    expect(s.creditCollectedCount).toBe(2);
  });

  it('reports credit collected on a day with no serves at all', () => {
    const s = summarizeHistory([], [collection(2500)]);
    expect(s.orderCount).toBe(0);
    expect(s.salesCents).toBe(0);
    expect(s.creditCollectedCents).toBe(2500);
  });
});
