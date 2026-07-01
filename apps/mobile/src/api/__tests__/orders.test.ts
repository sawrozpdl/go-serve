import type { Order, OrderItemRow } from '@cafe-mgmt/api-types';
import { recomputeOrderDerived } from '../orders';

function line(over: Partial<OrderItemRow>): OrderItemRow {
  return {
    id: over.id ?? 'i',
    order_id: 'o',
    menu_item_id: 'm',
    menu_item_name: 'X',
    qty: over.qty ?? 1,
    unit_price_cents: 0,
    line_cents: over.line_cents ?? 0,
    modifiers: null,
    notes: '',
    kitchen_status: over.kitchen_status ?? 'pending',
    created_at: '',
    voided_at: over.voided_at ?? null,
  };
}

describe('recomputeOrderDerived', () => {
  it('sums non-voided line_cents into live subtotal and counts by status', () => {
    const order = {
      items: [
        line({ id: 'a', line_cents: 500, kitchen_status: 'pending' }),
        line({ id: 'b', line_cents: 300, kitchen_status: 'in_progress' }),
        line({ id: 'c', line_cents: 200, kitchen_status: 'ready' }),
        line({ id: 'd', line_cents: 100, kitchen_status: 'served' }),
        line({ id: 'e', line_cents: 999, kitchen_status: 'pending', voided_at: 'x' }), // excluded
      ],
    } as Order;
    const out = recomputeOrderDerived(order);
    expect(out.live_subtotal_cents).toBe(1100);
    expect(out.items_pending).toBe(1);
    expect(out.items_in_progress).toBe(1);
    expect(out.items_ready).toBe(1);
    expect(out.items_served).toBe(1);
    expect(out.items_total).toBe(4); // voided excluded
  });

  it('handles an order with no items', () => {
    const out = recomputeOrderDerived({ items: undefined } as unknown as Order);
    expect(out.live_subtotal_cents).toBe(0);
    expect(out.items_total).toBe(0);
  });
});
