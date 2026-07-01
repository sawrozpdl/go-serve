import {
  addOp,
  removeOpFrom,
  setStatusIn,
  opsForOrder,
  needsReviewOps,
  replayableOps,
  queuedLineIds,
  groupByOrder,
  enqueueOp,
  removeOp,
  setOpStatus,
  getQueuedOps,
  useOfflineQueue,
  type QueuedOp,
} from '../queue';

let uuidN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${(uuidN += 1)}` }));

const op = (over: Partial<QueuedOp>): QueuedOp => ({
  id: 'op1',
  tenantSlug: 'sahan',
  orderId: 'o1',
  kind: 'add_items',
  payload: { items: [{ id: 'l1', menu_item_id: 'm1', qty: 1 }] },
  label: '1× Latte',
  createdAt: 0,
  status: 'queued',
  ...over,
});

describe('reducers', () => {
  it('addOp appends immutably', () => {
    const a = op({ id: 'a' });
    const b = op({ id: 'b' });
    const out = addOp([a], b);
    expect(out).toEqual([a, b]);
    expect(out).not.toBe([a]);
  });

  it('removeOpFrom drops by id', () => {
    expect(removeOpFrom([op({ id: 'a' }), op({ id: 'b' })], 'a').map((o) => o.id)).toEqual(['b']);
  });

  it('setStatusIn updates status + failure only for the match', () => {
    const out = setStatusIn([op({ id: 'a' }), op({ id: 'b' })], 'b', 'needs_review', {
      status: 409,
      message: 'gone',
    });
    expect(out.find((o) => o.id === 'a')!.status).toBe('queued');
    const bb = out.find((o) => o.id === 'b')!;
    expect(bb.status).toBe('needs_review');
    expect(bb.failure).toEqual({ status: 409, message: 'gone' });
  });
});

describe('selectors', () => {
  const ops = [
    op({ id: 'a', orderId: 'o1', status: 'queued' }),
    op({ id: 'b', orderId: 'o1', status: 'needs_review' }),
    op({ id: 'c', orderId: 'o2', status: 'queued' }),
  ];

  it('opsForOrder excludes needs_review and other orders', () => {
    expect(opsForOrder(ops, 'o1').map((o) => o.id)).toEqual(['a']);
  });

  it('needsReviewOps returns only parked ops', () => {
    expect(needsReviewOps(ops).map((o) => o.id)).toEqual(['b']);
  });

  it('replayableOps excludes needs_review', () => {
    expect(replayableOps(ops).map((o) => o.id)).toEqual(['a', 'c']);
  });
});

describe('queuedLineIds', () => {
  it('collects line ids from add / update / void ops (send has none)', () => {
    const ops = [
      op({ kind: 'add_items', payload: { items: [{ id: 'l1', menu_item_id: 'm', qty: 1 }, { id: 'l2', menu_item_id: 'm', qty: 1 }] } }),
      op({ kind: 'update_item', payload: { itemId: 'l3', patch: { qty: 2 } } }),
      op({ kind: 'void_item', payload: { itemId: 'l4', reason: '' } }),
      op({ kind: 'send_kitchen', payload: {} }),
    ];
    expect([...queuedLineIds(ops)].sort()).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('is empty for no ops', () => {
    expect(queuedLineIds([]).size).toBe(0);
  });
});

describe('groupByOrder', () => {
  it('groups preserving per-order enqueue order', () => {
    const ops = [
      op({ id: 'a', orderId: 'o1' }),
      op({ id: 'b', orderId: 'o2' }),
      op({ id: 'c', orderId: 'o1' }),
    ];
    const g = groupByOrder(ops);
    expect(g.get('o1')!.map((o) => o.id)).toEqual(['a', 'c']);
    expect(g.get('o2')!.map((o) => o.id)).toEqual(['b']);
  });
});

describe('store wrappers', () => {
  beforeEach(() => useOfflineQueue.setState({ ops: [] }));

  it('enqueueOp stamps id + createdAt + queued status and appends to the store', () => {
    const created = enqueueOp({
      tenantSlug: 'sahan',
      orderId: 'o1',
      kind: 'send_kitchen',
      payload: {},
      label: 'Send to kitchen',
    });
    expect(created.id).toMatch(/^uuid-/);
    expect(created.status).toBe('queued');
    expect(typeof created.createdAt).toBe('number');
    expect(getQueuedOps()).toHaveLength(1);
    expect(getQueuedOps()[0].label).toBe('Send to kitchen');
  });

  it('setOpStatus + removeOp mutate the stored op', () => {
    const o = enqueueOp({ tenantSlug: 's', orderId: 'o1', kind: 'send_kitchen', payload: {}, label: 'x' });
    setOpStatus(o.id, 'needs_review', { status: 409, message: 'gone' });
    expect(getQueuedOps()[0].status).toBe('needs_review');
    expect(getQueuedOps()[0].failure).toEqual({ status: 409, message: 'gone' });
    removeOp(o.id);
    expect(getQueuedOps()).toHaveLength(0);
  });
});
