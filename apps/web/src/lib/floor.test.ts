import { describe, it, expect } from 'vitest';

import { bucketOpenOrders } from './floor';
import type { Order } from '@/lib/api';

/** Only the fields bucketOpenOrders reads — the rest of Order is irrelevant. */
function order(partial: Partial<Order> & { id: string }): Order {
  return partial as Order;
}

describe('bucketOpenOrders', () => {
  it('puts a seated order under its table', () => {
    const o = order({ id: 'a', service_table_id: 't1' });
    const got = bucketOpenOrders([o]);
    expect(got.byTable.get('t1')).toBe(o);
    expect(got.walkins).toEqual([]);
    expect(got.staffMeals).toEqual([]);
  });

  it('separates a staff meal from the walk-ins — the bug this fixes', () => {
    // Both are table-less. Splitting on service_table_id alone put the staff
    // meal in the walk-in grid, where it rendered as a paying guest.
    const walkin = order({ id: 'w', table_label: 'Ram' });
    const meal = order({ id: 'm', staff_id: 's1', staff_name: 'Sita' });
    const got = bucketOpenOrders([walkin, meal]);
    expect(got.walkins).toEqual([walkin]);
    expect(got.staffMeals).toEqual([meal]);
  });

  it('treats an unnamed table-less order as a walk-in', () => {
    const got = bucketOpenOrders([order({ id: 'w' })]);
    expect(got.walkins).toHaveLength(1);
    expect(got.staffMeals).toEqual([]);
  });

  it('keeps a seated order on its table even if it carries a staff_id', () => {
    // The DB forbids this combination (0076), but optimistic and offline rows
    // reach the floor before any constraint has seen them, and a tile silently
    // vanishing from the table grid means the floor believes a taken table is
    // free. The table wins, and the order is not duplicated.
    const odd = order({ id: 'x', service_table_id: 't2', staff_id: 's1' });
    const got = bucketOpenOrders([odd]);
    expect(got.byTable.get('t2')).toBe(odd);
    expect(got.staffMeals).toEqual([]);
    expect(got.walkins).toEqual([]);
  });

  it('keeps only the last order seen for a table', () => {
    const first = order({ id: '1', service_table_id: 't1' });
    const second = order({ id: '2', service_table_id: 't1' });
    expect(bucketOpenOrders([first, second]).byTable.get('t1')).toBe(second);
  });

  it('handles an empty list', () => {
    const got = bucketOpenOrders([]);
    expect(got.byTable.size).toBe(0);
    expect(got.walkins).toEqual([]);
    expect(got.staffMeals).toEqual([]);
  });
});
