import type { KitchenTicket, Order, OrderItemRow } from '@cafe-mgmt/api-types';
import type { QueuedOp } from '../../offline/queue';
import {
  partitionTickets,
  elapsedLabel,
  findNewInProgress,
  ticketUrgency,
  pendingSyncTickets,
  mergeBoard,
} from '../board';

const t = (over: Partial<KitchenTicket>): KitchenTicket => ({
  item_id: 'i1',
  order_id: 'o1',
  menu_item_name: 'Latte',
  qty: 1,
  modifiers: null,
  notes: '',
  kitchen_status: 'in_progress',
  sent_to_kitchen_at: null,
  ready_at: null,
  ...over,
});

describe('partitionTickets', () => {
  it('splits ready from in-progress, preserving order', () => {
    const list = [
      t({ item_id: 'a', kitchen_status: 'in_progress' }),
      t({ item_id: 'b', kitchen_status: 'ready' }),
      t({ item_id: 'c', kitchen_status: 'in_progress' }),
    ];
    const { inProgress, ready } = partitionTickets(list);
    expect(inProgress.map((x) => x.item_id)).toEqual(['a', 'c']);
    expect(ready.map((x) => x.item_id)).toEqual(['b']);
  });

  it('handles an empty board', () => {
    expect(partitionTickets([])).toEqual({ inProgress: [], ready: [] });
  });
});

describe('elapsedLabel', () => {
  const now = new Date('2026-07-02T10:00:00Z').getTime();
  const ago = (sec: number) => new Date(now - sec * 1000).toISOString();

  it('formats seconds, minutes, and hours', () => {
    expect(elapsedLabel(now, ago(42))).toBe('42s');
    expect(elapsedLabel(now, ago(60))).toBe('1m');
    expect(elapsedLabel(now, ago(7 * 60))).toBe('7m');
    expect(elapsedLabel(now, ago(3 * 3600))).toBe('3h');
  });

  it('rolls over into days past 24h rather than counting to 777h', () => {
    expect(elapsedLabel(now, ago(24 * 3600 - 1))).toBe('23h');
    expect(elapsedLabel(now, ago(24 * 3600))).toBe('1d');
    expect(elapsedLabel(now, ago(777 * 3600))).toBe('32d');
  });

  it('prefers readyAt over sentAt', () => {
    expect(elapsedLabel(now, ago(3600), ago(30))).toBe('30s');
  });

  it('clamps negatives to 0s and returns — for missing/invalid refs', () => {
    expect(elapsedLabel(now, ago(-10))).toBe('0s');
    expect(elapsedLabel(now, null)).toBe('—');
    expect(elapsedLabel(now, 'not-a-date')).toBe('—');
  });
});

describe('findNewInProgress', () => {
  const board = [
    t({ item_id: 'a', kitchen_status: 'in_progress' }),
    t({ item_id: 'b', kitchen_status: 'ready' }),
  ];

  it('seeds without alerting on first call (prev null)', () => {
    const { ids, hasNew } = findNewInProgress(null, board);
    expect(hasNew).toBe(false);
    expect([...ids]).toEqual(['a']); // only in-progress ids are tracked
  });

  it('flags a genuinely new in-progress ticket', () => {
    const prev = new Set(['a']);
    const next = [...board, t({ item_id: 'c', kitchen_status: 'in_progress' })];
    const { ids, hasNew } = findNewInProgress(prev, next);
    expect(hasNew).toBe(true);
    expect(ids.has('c')).toBe(true);
  });

  it('does not alert when nothing new arrived', () => {
    expect(findNewInProgress(new Set(['a']), board).hasNew).toBe(false);
  });

  it('does not alert when a ticket only leaves (marked ready/served)', () => {
    const { hasNew } = findNewInProgress(new Set(['a', 'x']), board);
    expect(hasNew).toBe(false);
  });
});

describe('ticketUrgency', () => {
  const now = new Date('2026-07-02T10:00:00Z').getTime();
  const minAgo = (m: number) => new Date(now - m * 60000).toISOString();

  it('tiers by minutes waited', () => {
    expect(ticketUrgency(now, minAgo(2))).toBe('fresh');
    expect(ticketUrgency(now, minAgo(6))).toBe('warn');
    expect(ticketUrgency(now, minAgo(15))).toBe('urgent');
  });

  it('is fresh for missing/invalid refs', () => {
    expect(ticketUrgency(now, null)).toBe('fresh');
    expect(ticketUrgency(now, 'nope')).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// Offline board — the kitchen used to go blank the moment the wifi dropped,
// even though the queued sends were sitting right there on the device.
// ---------------------------------------------------------------------------

const line = (over: Partial<OrderItemRow> = {}): OrderItemRow =>
  ({
    id: 'l1',
    order_id: 'o1',
    menu_item_id: 'm1',
    menu_item_name: 'Latte',
    qty: 1,
    unit_price_cents: 300,
    base_price_cents: 300,
    line_cents: 300,
    add_ons: [],
    modifiers: null,
    notes: '',
    kitchen_status: 'in_progress',
    created_at: '2026-09-05T10:00:00Z',
    ...over,
  }) as unknown as OrderItemRow;

const order = (items: OrderItemRow[], over: Partial<Order> = {}): Order =>
  ({
    id: 'o1',
    service_table_name: 'T1',
    table_label: '',
    items,
    ...over,
  }) as unknown as Order;

const op = (over: Partial<QueuedOp> = {}): QueuedOp =>
  ({
    id: 'q1',
    tenantSlug: 'sahan',
    orderId: 'o1',
    kind: 'send_kitchen',
    payload: {},
    createdAt: 1,
    status: 'queued',
    ...over,
  }) as QueuedOp;

describe('pendingSyncTickets', () => {
  const read = (o: Order | undefined) => () => o;

  it('projects the in-progress lines of a queued send onto the board', () => {
    const out = pendingSyncTickets([op()], 'sahan', read(order([line()])));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      item_id: 'l1',
      menu_item_name: 'Latte',
      kitchen_status: 'in_progress',
      service_table_name: 'T1',
      pendingSync: true,
    });
  });

  it('ignores voided lines and lines that were never sent', () => {
    const items = [
      line({ id: 'voided', voided_at: '2026-09-05T10:01:00Z' }),
      line({ id: 'still-pending', kitchen_status: 'pending' }),
      line({ id: 'sent' }),
    ];
    const out = pendingSyncTickets([op()], 'sahan', read(order(items)));
    expect(out.map((o) => o.item_id)).toEqual(['sent']);
  });

  it('ignores ops that are not sends, belong to another cafe, or need review', () => {
    const ops = [
      op({ id: 'a', kind: 'add_items' }),
      op({ id: 'b', tenantSlug: 'other-cafe' }),
      op({ id: 'c', status: 'needs_review' }),
    ];
    expect(pendingSyncTickets(ops, 'sahan', read(order([line()])))).toEqual([]);
  });

  it('yields nothing when there is no active workspace', () => {
    expect(pendingSyncTickets([op()], null, read(order([line()])))).toEqual([]);
  });

  it('survives an order that is no longer in the cache', () => {
    expect(pendingSyncTickets([op()], 'sahan', read(undefined))).toEqual([]);
  });
});

describe('mergeBoard', () => {
  it('keeps both sources, and the server wins on a conflicting id', () => {
    const server = [t({ item_id: 'shared', menu_item_name: 'From server' })];
    const pending = [
      { ...t({ item_id: 'shared', menu_item_name: 'From queue' }), pendingSync: true },
      { ...t({ item_id: 'queued-only', menu_item_name: 'Only queued' }), pendingSync: true },
    ];
    const merged = mergeBoard(server, pending);
    expect(merged.map((m) => m.menu_item_name)).toEqual(['From server', 'Only queued']);
  });

  it('still shows queued tickets before the server has ever answered', () => {
    const pending = [{ ...t({ item_id: 'q' }), pendingSync: true }];
    expect(mergeBoard(undefined, pending)).toHaveLength(1);
  });
});
