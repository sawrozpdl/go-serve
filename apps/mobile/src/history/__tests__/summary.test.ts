import type { HistoryCreditCollection, HistoryOrder } from '@cafe-mgmt/api-types';
import { todayStr, shiftDay, formatDayLabel, isToday, summarizeHistory } from '../summary';

describe('the day helpers History imports from here', () => {
  // They live in lib/dates now (shared with Expenses) and are re-exported so
  // the screen keeps one import. Their behaviour is covered in
  // lib/__tests__/dates.test.ts; this only pins that the re-export still works.
  it('are re-exported and functional', () => {
    expect(todayStr(new Date(2026, 6, 2))).toBe('2026-07-02');
    expect(shiftDay('2026-07-01', -1)).toBe('2026-06-30');
    expect(formatDayLabel('2026-07-02', '2026-07-02')).toBe('Today');
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
      cashCount: 0,
      onlineCount: 0,
      tabCount: 0,
      creditCollectedCents: 0,
      creditCollectedCount: 0,
      // Not NaN: an average over zero serves is zero, not a division.
      avgTicketCents: 0,
      itemCount: 0,
      discountCents: 0,
      taxCents: 0,
      serviceCents: 0,
      voidCount: 0,
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

describe('the depth the summary panel needs', () => {
  /** An order with the charge breakdown and item rows the panel reads. */
  const rich = (over: Partial<HistoryOrder> = {}): HistoryOrder =>
    ({
      id: `o-${Math.random()}`,
      opened_at: '',
      closed_at: '',
      notes: '',
      subtotal_cents: 1000,
      discount_cents: 0,
      tax_cents: 0,
      service_charge_cents: 0,
      total_cents: 1000,
      item_count: 2,
      items: [],
      payments: [],
      ...over,
    }) as unknown as HistoryOrder;

  const line = (over: Record<string, unknown> = {}) =>
    ({
      id: `i-${Math.random()}`,
      menu_item_name: 'Momo',
      qty: 1,
      line_cents: 500,
      notes: '',
      ...over,
    }) as unknown as HistoryOrder['items'][number];

  it('averages the ticket over serves', () => {
    const s = summarizeHistory([rich({ total_cents: 1000 }), rich({ total_cents: 1500 })]);
    expect(s.avgTicketCents).toBe(1250);
  });

  it('rounds the average rather than trailing a fraction of a paisa', () => {
    const s = summarizeHistory([rich({ total_cents: 1000 }), rich({ total_cents: 1001 })]);
    expect(s.avgTicketCents).toBe(1001);
  });

  it('adds up items, discounts, VAT and service across the day', () => {
    const s = summarizeHistory([
      rich({ item_count: 3, discount_cents: 100, tax_cents: 130, service_charge_cents: 50 }),
      rich({ item_count: 2, discount_cents: 50, tax_cents: 65, service_charge_cents: 25 }),
    ]);
    expect(s.itemCount).toBe(5);
    expect(s.discountCents).toBe(150);
    expect(s.taxCents).toBe(195);
    expect(s.serviceCents).toBe(75);
  });

  it('counts voided LINES, not orders that contain one', () => {
    const s = summarizeHistory([
      rich({ items: [line(), line({ voided_at: '2026-09-09T10:00:00Z' }), line({ voided_at: '2026-09-09T10:01:00Z' })] }),
      rich({ items: [line()] }),
    ]);
    expect(s.voidCount).toBe(2);
  });

  it('counts payments per bucket, not just their money', () => {
    // Two Rs 500 payments and one Rs 1,000 are the same money and a different
    // day; the panel says which.
    const s = summarizeHistory([
      rich({
        payments: [
          { id: 'p1', method: 'cash', amount_cents: 500, reference_no: '', reclassifiable: false },
          { id: 'p2', method: 'cash', amount_cents: 500, reference_no: '', reclassifiable: false },
          { id: 'p3', method: 'esewa', amount_cents: 200, reference_no: '', reclassifiable: false },
          { id: 'p4', method: 'house_tab', amount_cents: 300, reference_no: '', reclassifiable: false },
        ],
      } as unknown as Partial<HistoryOrder>),
    ]);
    expect(s.cashCount).toBe(2);
    expect(s.cashCents).toBe(1000);
    // Legacy wallet methods still collapse into Online.
    expect(s.onlineCount).toBe(1);
    expect(s.tabCount).toBe(1);
  });

  it('survives an order whose items the server omitted', () => {
    expect(summarizeHistory([rich({ items: undefined as never })]).voidCount).toBe(0);
  });
});
