import type { OrderAdjustment } from '@cafe-mgmt/api-types';
import { discountTotal, checkoutChargesHint, afterDiscount } from '../totals';

const adj = (over: Partial<OrderAdjustment> = {}): OrderAdjustment =>
  ({
    id: 'a1',
    order_id: 'o1',
    type: 'discount',
    amount_cents: 100,
    reason: 'regular',
    created_at: '2026-09-05T10:00:00Z',
    ...over,
  }) as OrderAdjustment;

describe('discountTotal', () => {
  it('is zero for no adjustments', () => {
    expect(discountTotal(undefined)).toBe(0);
    expect(discountTotal([])).toBe(0);
  });

  it('sums every discount row', () => {
    expect(discountTotal([adj({ amount_cents: 150 }), adj({ id: 'a2', amount_cents: 250 })])).toBe(400);
  });

  it('counts only discounts — a service charge is not money off', () => {
    const rows = [
      adj({ amount_cents: 150 }),
      adj({ id: 'a2', type: 'service_charge', amount_cents: 999 }),
      adj({ id: 'a3', type: 'tax_override', amount_cents: 777 }),
    ];
    expect(discountTotal(rows)).toBe(150);
  });
});

describe('checkoutChargesHint', () => {
  it('says nothing when the cafe levies neither', () => {
    expect(checkoutChargesHint('none', '0', '0')).toBe('');
    expect(checkoutChargesHint(undefined, undefined, undefined)).toBe('');
  });

  it('does not warn about VAT the cafe does not charge', () => {
    // vat_pct set but mode none, and mode set but pct zero: both are "off".
    expect(checkoutChargesHint('none', '13', '0')).toBe('');
    expect(checkoutChargesHint('exclusive', '0', '0')).toBe('');
  });

  it('warns about exclusive VAT and service charge added at checkout', () => {
    expect(checkoutChargesHint('exclusive', '13', '0')).toBe('VAT applied at checkout');
    expect(checkoutChargesHint('none', '0', '10')).toBe('service charge applied at checkout');
    expect(checkoutChargesHint('exclusive', '13', '10')).toBe('VAT & service charge applied at checkout');
  });

  it('states inclusive VAT rather than warning about it', () => {
    expect(checkoutChargesHint('inclusive', '13', '0')).toBe('Prices include VAT');
    expect(checkoutChargesHint('inclusive', '13', '10')).toBe(
      'Prices include VAT · service charge at checkout',
    );
  });

  it('tolerates numeric and malformed percentages', () => {
    expect(checkoutChargesHint('exclusive', 13, 0)).toBe('VAT applied at checkout');
    expect(checkoutChargesHint('exclusive', 'abc', 'xyz')).toBe('');
  });
});

describe('afterDiscount', () => {
  it('subtracts the discount', () => {
    expect(afterDiscount(1000, 250)).toBe(750);
  });

  it('never goes negative — an over-large discount owes nothing, not a refund', () => {
    expect(afterDiscount(500, 900)).toBe(0);
  });
});
