/**
 * Parity vectors captured by RUNNING the Go implementation
 * (apps/api/internal/api/payments.go pctOf / pctInclusive / parsePctHundredths)
 * over the same inputs. Every expectation below is Go's actual output, not a
 * hand-derived one — a paisa of drift here would put the demo's receipts out of
 * step with its own dashboard.
 */
import { buildQuote, parsePctHundredths, pctInclusive, pctOf } from '../money';
import type { Order, OrderAdjustment, Payment } from '@cafe-mgmt/api-types';

// pct | amount | pctOf | pctInclusive
const GO_VECTORS: [string, number, number, number][] = [
  ['13.00', 0, 0, 0],
  ['13.00', 1, 0, 0],
  ['13.00', 7, 1, 1],
  ['13.00', 99, 13, 11],
  ['13.00', 100, 13, 12],
  ['13.00', 12345, 1605, 1420],
  ['13.00', 119000, 15470, 13690],
  ['13.00', 999999, 130000, 115044],
  ['8.5', 0, 0, 0],
  ['8.5', 1, 0, 0],
  ['8.5', 7, 1, 1],
  ['8.5', 99, 8, 8],
  ['8.5', 100, 9, 8],
  ['8.5', 12345, 1049, 967],
  ['8.5', 119000, 10115, 9323],
  ['8.5', 999999, 85000, 78341],
  ['0', 0, 0, 0],
  ['0', 1, 0, 0],
  ['0', 7, 0, 0],
  ['0', 99, 0, 0],
  ['0', 100, 0, 0],
  ['0', 12345, 0, 0],
  ['0', 119000, 0, 0],
  ['0', 999999, 0, 0],
  ['', 0, 0, 0],
  ['', 1, 0, 0],
  ['', 7, 0, 0],
  ['', 99, 0, 0],
  ['', 100, 0, 0],
  ['', 12345, 0, 0],
  ['', 119000, 0, 0],
  ['', 999999, 0, 0],
  ['10.00', 0, 0, 0],
  ['10.00', 1, 0, 0],
  ['10.00', 7, 1, 1],
  ['10.00', 99, 10, 9],
  ['10.00', 100, 10, 9],
  ['10.00', 12345, 1235, 1122],
  ['10.00', 119000, 11900, 10818],
  ['10.00', 999999, 100000, 90909],
  ['7.777', 0, 0, 0],
  ['7.777', 1, 0, 0],
  ['7.777', 7, 1, 1],
  ['7.777', 99, 8, 7],
  ['7.777', 100, 8, 7],
  ['7.777', 12345, 959, 890],
  ['7.777', 119000, 9246, 8580],
  ['7.777', 999999, 77700, 72098],
];

describe('percentages match the Go implementation', () => {
  it.each(GO_VECTORS)('%s of %d → pctOf %d, pctInclusive %d', (pct, amount, of, incl) => {
    expect(pctOf(amount, pct)).toBe(of);
    expect(pctInclusive(amount, pct)).toBe(incl);
  });

  // These are the inputs a real column can hand us: numeric(5,2) is nullable, and
  // older rows have carried odd strings. The parser must degrade to 0% rather than
  // produce NaN and turn a bill into "Rs NaN".
  it('degrades to zero rather than NaN on junk or missing input', () => {
    expect(parsePctHundredths(null as unknown as string)).toBe(0);
    expect(parsePctHundredths(undefined as unknown as string)).toBe(0);
    expect(parsePctHundredths('abc')).toBe(0);
    // A leading dot: no whole part to parse.
    expect(parsePctHundredths('.5')).toBe(50);
    // A non-numeric fraction contributes nothing rather than poisoning the total.
    expect(parsePctHundredths('13.ab')).toBe(1300);
  });

  it('truncates beyond two decimal places, like numeric(5,2)', () => {
    expect(parsePctHundredths('13.00')).toBe(1300);
    expect(parsePctHundredths('8.5')).toBe(850);
    expect(parsePctHundredths('7.777')).toBe(777);
    expect(parsePctHundredths('0')).toBe(0);
    expect(parsePctHundredths('')).toBe(0);
    expect(parsePctHundredths('  13.00  ')).toBe(1300);
  });
});

// ---------------------------------------------------------------------------

function orderWith(lines: number[]): Order {
  return {
    id: 'o1',
    status: 'open',
    opened_by_user_id: 'u1',
    opened_at: '2026-08-19T04:00:00.000Z',
    notes: '',
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    service_charge_cents: 0,
    total_cents: 0,
    live_subtotal_cents: 0,
    items_pending: 0,
    items_in_progress: 0,
    items_ready: 0,
    items_served: 0,
    items_total: 0,
    paid_cents: 0,
    items: lines.map((line_cents, i) => ({
      id: `i${i}`,
      order_id: 'o1',
      menu_item_id: 'm1',
      menu_item_name: 'Item',
      qty: 1,
      unit_price_cents: line_cents,
      line_cents,
      modifiers: null,
      notes: '',
      kitchen_status: 'pending' as const,
      created_at: '2026-08-19T04:00:00.000Z',
    })),
  };
}

const discount = (amount: number): OrderAdjustment => ({
  id: 'a1',
  order_id: 'o1',
  type: 'discount',
  amount_cents: amount,
  reason: 'regular',
  applied_by_user_id: 'u1',
  approved_by_user_id: '',
  created_at: '2026-08-19T04:00:00.000Z',
});

const payment = (amount: number, method: Payment['method'] = 'cash'): Payment => ({
  id: 'p1',
  order_id: 'o1',
  method,
  amount_cents: amount,
  reference_no: '',
  recorded_by_user_id: 'u1',
  recorded_at: '2026-08-19T04:00:00.000Z',
});

describe('buildQuote', () => {
  const rates = { service_charge_pct: '10.00', vat_pct: '13.00' } as const;

  it('adds VAT on top in exclusive mode', () => {
    const q = buildQuote(orderWith([50000, 50000]), [], [], { ...rates, vat_mode: 'exclusive' });
    expect(q.subtotal_cents).toBe(100000);
    expect(q.service_charge_cents).toBe(10000);
    expect(q.tax_cents).toBe(14300); // 13% of 110000
    expect(q.total_cents).toBe(124300);
    expect(q.balance_cents).toBe(124300);
  });

  it('extracts embedded VAT in inclusive mode, leaving the total at base', () => {
    const q = buildQuote(orderWith([100000]), [], [], { ...rates, vat_mode: 'inclusive' });
    expect(q.total_cents).toBe(110000);
    expect(q.tax_cents).toBe(pctInclusive(110000, '13.00'));
    // The extracted VAT is part of the total, not added to it.
    expect(q.total_cents).toBe(110000);
  });

  it('charges no tax in none mode', () => {
    const q = buildQuote(orderWith([100000]), [], [], { ...rates, vat_mode: 'none' });
    expect(q.tax_cents).toBe(0);
    expect(q.total_cents).toBe(110000);
  });

  it('applies a discount before service and VAT', () => {
    const q = buildQuote(orderWith([100000]), [discount(20000)], [], {
      ...rates,
      vat_mode: 'exclusive',
    });
    // Service is 10% of the UNDISCOUNTED subtotal, matching the server.
    expect(q.service_charge_cents).toBe(10000);
    expect(q.discount_cents).toBe(20000);
    expect(q.total_cents).toBe(90000 + pctOf(90000, '13.00'));
  });

  it('clamps a discount larger than the bill to a zero base', () => {
    const q = buildQuote(orderWith([10000]), [discount(999999)], [], {
      ...rates,
      vat_mode: 'exclusive',
    });
    expect(q.total_cents).toBe(0);
    expect(q.tax_cents).toBe(0);
  });

  it('ignores voided lines', () => {
    const o = orderWith([50000, 50000]);
    o.items![1].voided_at = '2026-08-19T04:10:00.000Z';
    const q = buildQuote(o, [], [], { ...rates, vat_mode: 'exclusive' });
    expect(q.subtotal_cents).toBe(50000);
  });

  it('counts credit charges toward paid, like the server', () => {
    const q = buildQuote(orderWith([100000]), [], [payment(50000, 'house_tab')], {
      ...rates,
      vat_mode: 'none',
    });
    expect(q.paid_cents).toBe(50000);
    expect(q.balance_cents).toBe(60000);
  });

  it('treats an order with no items array as an empty bill', () => {
    // A partial Order DTO (the list endpoint can omit items) must not throw.
    const bare = { ...orderWith([]), items: undefined } as Order;
    const q = buildQuote(bare, [], [], { ...rates, vat_mode: 'exclusive' });
    expect(q.subtotal_cents).toBe(0);
    expect(q.total_cents).toBe(0);
  });

  it('only counts adjustments and payments belonging to this order', () => {
    const foreign = { ...discount(50000), order_id: 'other' };
    const q = buildQuote(orderWith([100000]), [foreign], [{ ...payment(1000), order_id: 'other' }], {
      ...rates,
      vat_mode: 'none',
    });
    expect(q.discount_cents).toBe(0);
    expect(q.paid_cents).toBe(0);
  });
});
