/**
 * Stock arithmetic. Quantities are Postgres `numeric` strings on the wire, so
 * every case here is about a string that has to survive being read as a
 * number and printed back.
 */
import type { InventoryItem, StockMovement } from '@cafe-mgmt/api-types';
import {
  isNegativeStock,
  stockCounts,
  trimQty,
  formatDelta,
  runningBalances,
  movementTone,
  movementLabel,
  packRuleLabel,
} from '../stock';

const item = (over: Partial<InventoryItem> = {}): InventoryItem =>
  ({
    id: `i-${Math.random()}`,
    name: 'Cola',
    kind: 'retail',
    sale_unit: 'bottle',
    qty_on_hand_units: '10.000',
    par_low_units: '2.000',
    notes: '',
    is_low_stock: false,
    ...over,
  }) as InventoryItem;

const move = (delta: string, over: Partial<StockMovement> = {}): StockMovement =>
  ({
    id: `m-${Math.random()}`,
    inventory_item_id: 'i1',
    delta_units: delta,
    reason: 'purchase',
    notes: '',
    at: '2026-09-09T10:00:00Z',
    ...over,
  }) as StockMovement;

describe('isNegativeStock', () => {
  it('is true only below zero', () => {
    expect(isNegativeStock(item({ qty_on_hand_units: '-3.000' }))).toBe(true);
    expect(isNegativeStock(item({ qty_on_hand_units: '0.000' }))).toBe(false);
    expect(isNegativeStock(item({ qty_on_hand_units: '0.001' }))).toBe(false);
  });

  it('treats an unparseable or absent quantity as zero rather than throwing', () => {
    // An older API binary, or a column the server has not filled in: neither
    // should make the whole list blow up.
    expect(isNegativeStock(item({ qty_on_hand_units: '' }))).toBe(false);
    expect(isNegativeStock(item({ qty_on_hand_units: null as never }))).toBe(false);
    expect(isNegativeStock(item({ qty_on_hand_units: 'n/a' }))).toBe(false);
  });
});

describe('stockCounts', () => {
  it('counts a negative item once, as negative — never also as low', () => {
    // Otherwise the two badges add up to more than the list, and "3 low, 2
    // negative" over four rows reads as a bug in the page.
    const counts = stockCounts([
      item({ qty_on_hand_units: '-1', is_low_stock: true }),
      item({ qty_on_hand_units: '1', is_low_stock: true }),
      item({ qty_on_hand_units: '50', is_low_stock: false }),
    ]);
    expect(counts).toEqual({ low: 1, negative: 1 });
  });

  it('is zeroed for an empty or unloaded list', () => {
    expect(stockCounts([])).toEqual({ low: 0, negative: 0 });
    expect(stockCounts(undefined)).toEqual({ low: 0, negative: 0 });
  });
});

describe('trimQty', () => {
  it.each([
    ['200.000', '200'],
    ['12.500', '12.5'],
    ['0.001', '0.001'],
    ['5', '5'],
    ['-3.000', '-3'],
    ['0.000', '0'],
    ['', ''],
  ])('%s → %s', (input, want) => {
    expect(trimQty(input)).toBe(want);
  });

  it('survives a missing quantity', () => {
    expect(trimQty(undefined)).toBe('');
  });

  it('does not trim a bare fraction down to nothing', () => {
    // ".000" would otherwise become "" and render as a blank quantity.
    expect(trimQty('.000')).toBe('0');
    expect(trimQty('-.000')).toBe('0');
  });
});

describe('formatDelta', () => {
  it('always carries an explicit sign', () => {
    expect(formatDelta('200.000')).toBe('+200');
    expect(formatDelta('-2.500')).toBe('−2.5');
  });

  it('reads zero as an addition rather than inventing a minus', () => {
    expect(formatDelta('0.000')).toBe('+0');
  });
});

describe('runningBalances', () => {
  it('walks back up the ledger from the live on-hand figure', () => {
    // Newest first: after the newest row the balance IS on-hand.
    const rows = runningBalances([move('-2'), move('+5'), move('+10')], '13');
    expect(rows.map((r) => r.balanceAfter)).toEqual([13, 15, 10]);
  });

  it('does not print float noise on decimal quantities', () => {
    // Repeated subtraction of 0.1 otherwise yields 11.899999999999999.
    const rows = runningBalances([move('0.1'), move('0.1'), move('0.1')], '12');
    expect(rows.map((r) => r.balanceAfter)).toEqual([12, 11.9, 11.8]);
  });

  it('shows a balance that went below zero rather than clamping it', () => {
    const rows = runningBalances([move('-5')], '-3');
    expect(rows[0].balanceAfter).toBe(-3);
  });

  it('is empty for an empty ledger', () => {
    expect(runningBalances([], '10')).toEqual([]);
  });
});

describe('movementTone + movementLabel', () => {
  it('separates stock arriving, leaving and being corrected', () => {
    expect(movementTone('purchase')).toBe('success');
    expect(movementTone('waste')).toBe('danger');
    expect(movementTone('sale')).toBe('neutral');
    expect(movementTone('adjust')).toBe('warn');
    expect(movementTone('transfer')).toBe('warn');
  });

  it('never leaves a raw enum on screen', () => {
    expect(movementLabel('adjust')).toBe('Correction');
    expect(movementLabel('sale')).toBe('Sold');
  });

  it('shows an unknown reason as-is rather than blanking the row', () => {
    expect(movementLabel('teleported')).toBe('teleported');
  });
});

describe('packRuleLabel', () => {
  it('states both halves — bought in one unit, sold in another', () => {
    expect(
      packRuleLabel({
        container_qty: 1,
        container_unit: 'carton',
        sale_qty_per_container: 200,
        sale_unit: 'bottle',
      }),
    ).toBe('1 carton = 200 bottle');
  });
});
