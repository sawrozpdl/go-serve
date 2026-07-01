import { mapEventToInvalidations, pollInvalidations, type WSEvent } from '@cafe-mgmt/api-types';

const slug = 'sahan';
const keys = (ev: WSEvent) => mapEventToInvalidations(ev, slug).map((k) => k.join('|'));

describe('mapEventToInvalidations', () => {
  it('kitchen → kitchen tickets', () => {
    expect(keys({ topic: 'kitchen', action: 'ticket.ready' })).toEqual(['kitchen-tickets|sahan']);
  });

  it('tables → tables + orders (floor overlays amounts)', () => {
    expect(keys({ topic: 'tables', action: 'table.updated' })).toEqual(['tables|sahan', 'orders']);
  });

  it('orders base → orders list only', () => {
    expect(keys({ topic: 'orders', action: 'order.opened' })).toEqual(['orders']);
  });

  it('orders with order_id → adds the single-order key', () => {
    expect(keys({ topic: 'orders', action: 'order.opened', ref: { order_id: 'o1' } })).toEqual([
      'orders',
      'order|sahan|o1',
    ]);
  });

  it('item-level events refresh kitchen tickets + quote', () => {
    expect(keys({ topic: 'orders', action: 'order.item.added', ref: { order_id: 'o1' } })).toEqual([
      'orders',
      'order|sahan|o1',
      'kitchen-tickets|sahan',
      'order-quote|sahan|o1',
    ]);
  });

  it('order.items.sent also refreshes kitchen tickets', () => {
    expect(keys({ topic: 'orders', action: 'order.items.sent', ref: { order_id: 'o1' } })).toContain(
      'kitchen-tickets|sahan',
    );
  });

  it('payment events refresh payments, quote, and shift', () => {
    expect(keys({ topic: 'orders', action: 'order.payment.recorded', ref: { order_id: 'o1' } })).toEqual([
      'orders',
      'order|sahan|o1',
      'order-payments|sahan|o1',
      'order-quote|sahan|o1',
      'current-shift|sahan',
      'shift-payments|sahan',
    ]);
  });

  it('payment event without order_id still refreshes the shift', () => {
    const k = keys({ topic: 'orders', action: 'order.payment.recorded' });
    expect(k).toContain('current-shift|sahan');
    expect(k).not.toContain('order-payments|sahan|undefined');
  });

  it('finance → money-shaped keys', () => {
    expect(keys({ topic: 'finance', action: 'owner.payout' })).toEqual([
      'cafe-balance',
      'cafe-owners',
      'owner-ledger',
      'accounts-balances',
    ]);
  });

  it('unknown topic → nothing', () => {
    expect(keys({ topic: 'bogus' as WSEvent['topic'], action: 'x' })).toEqual([]);
  });
});

describe('pollInvalidations', () => {
  it('refreshes the operational query families', () => {
    expect(pollInvalidations(slug).map((k) => k.join('|'))).toEqual([
      'kitchen-tickets|sahan',
      'tables|sahan',
      'orders',
      'order',
    ]);
  });
});
