import { classifyFailure, runReplay, execQueuedOp, type ReplayDeps } from '../replay';
import type { QueuedOp } from '../queue';
import { replayableOps, groupByOrder, removeOpFrom, setStatusIn } from '../queue';
import { api } from '../../api/client';

jest.mock('../../api/client', () => ({
  api: {
    post: jest.fn(() => Promise.resolve({})),
    patch: jest.fn(() => Promise.resolve({})),
  },
}));

const op = (over: Partial<QueuedOp>): QueuedOp => ({
  id: 'op1',
  tenantSlug: 'sahan',
  orderId: 'o1',
  kind: 'send_kitchen',
  payload: {},
  label: 'op',
  createdAt: 0,
  status: 'queued',
  ...over,
});

/** A fake in-memory queue + configurable executor, so runReplay is exercised
 * end-to-end without a network or the real store. */
function harness(initial: QueuedOp[], fail: Record<string, number> = {}) {
  let ops = [...initial];
  const execOrder: string[] = [];
  const deps: ReplayDeps & { readonly ops: QueuedOp[] } = {
    get ops() {
      return ops;
    },
    getOps: () => ops,
    setStatus: (id, status, failure) => {
      ops = setStatusIn(ops, id, status, failure);
    },
    remove: (id) => {
      ops = removeOpFrom(ops, id);
    },
    exec: async (o) => {
      execOrder.push(o.id);
      const code = fail[o.id];
      if (code != null) throw { status: code, message: `HTTP ${code}` };
      return {};
    },
    onTouched: jest.fn(),
  };
  return { deps, execOrder, snapshot: () => ops };
}

describe('classifyFailure', () => {
  it('retries on offline (0) and 5xx, reviews on 4xx', () => {
    expect(classifyFailure(0)).toBe('retry');
    expect(classifyFailure(500)).toBe('retry');
    expect(classifyFailure(503)).toBe('retry');
    expect(classifyFailure(400)).toBe('review');
    expect(classifyFailure(404)).toBe('review');
    expect(classifyFailure(409)).toBe('review');
  });
});

describe('runReplay', () => {
  it('replays everything on success, removes ops, reports touched orders', async () => {
    const { deps, snapshot } = harness([
      op({ id: 'a', orderId: 'o1' }),
      op({ id: 'b', orderId: 'o2' }),
    ]);
    const touched = await runReplay(deps);
    expect([...touched].sort()).toEqual(['o1', 'o2']);
    expect(snapshot()).toEqual([]); // all drained
    expect(deps.onTouched).toHaveBeenCalledWith(expect.arrayContaining(['o1', 'o2']));
  });

  it('preserves FIFO within an order', async () => {
    const { deps, execOrder } = harness([
      op({ id: 'a', orderId: 'o1' }),
      op({ id: 'b', orderId: 'o1' }),
      op({ id: 'c', orderId: 'o1' }),
    ]);
    await runReplay(deps);
    expect(execOrder).toEqual(['a', 'b', 'c']);
  });

  it('parks a 4xx op for review and HALTS the rest of that order chain', async () => {
    const { deps, execOrder, snapshot } = harness(
      [op({ id: 'a', orderId: 'o1' }), op({ id: 'b', orderId: 'o1' }), op({ id: 'c', orderId: 'o1' })],
      { b: 409 },
    );
    await runReplay(deps);
    // a ran + removed; b failed 4xx → needs_review; c never attempted (halted).
    expect(execOrder).toEqual(['a', 'b']);
    const ops = snapshot();
    expect(ops.find((o) => o.id === 'a')).toBeUndefined();
    const bb = ops.find((o) => o.id === 'b')!;
    expect(bb.status).toBe('needs_review');
    expect(bb.failure).toEqual({ status: 409, code: undefined, message: 'HTTP 409' });
    expect(ops.find((o) => o.id === 'c')!.status).toBe('queued');
  });

  it('requeues a 5xx/offline op (retry later) and halts the chain', async () => {
    const { deps, snapshot } = harness([op({ id: 'a', orderId: 'o1' }), op({ id: 'b', orderId: 'o1' })], {
      a: 503,
    });
    await runReplay(deps);
    const ops = snapshot();
    expect(ops.find((o) => o.id === 'a')!.status).toBe('queued'); // not parked
    expect(ops.find((o) => o.id === 'b')!.status).toBe('queued'); // never attempted
  });

  it('isolates orders — a failure in one does not block another', async () => {
    const { deps, execOrder, snapshot } = harness(
      [op({ id: 'a', orderId: 'o1' }), op({ id: 'x', orderId: 'o2' }), op({ id: 'y', orderId: 'o2' })],
      { a: 409 },
    );
    const touched = await runReplay(deps);
    expect(execOrder).toEqual(expect.arrayContaining(['a', 'x', 'y']));
    expect([...touched]).toEqual(['o2']); // o1 failed, o2 fully drained
    const ops = snapshot();
    expect(ops.find((o) => o.id === 'a')!.status).toBe('needs_review');
    expect(ops.find((o) => o.id === 'x')).toBeUndefined();
    expect(ops.find((o) => o.id === 'y')).toBeUndefined();
  });

  it('skips needs_review ops entirely and no-ops on an empty/parked queue', async () => {
    const { deps, execOrder } = harness([op({ id: 'a', orderId: 'o1', status: 'needs_review' })]);
    const touched = await runReplay(deps);
    expect(execOrder).toEqual([]);
    expect(touched.size).toBe(0);
    expect(deps.onTouched).not.toHaveBeenCalled();
  });
});

describe('execQueuedOp', () => {
  const post = api.post as jest.Mock;
  const patch = api.patch as jest.Mock;
  beforeEach(() => {
    post.mockClear();
    patch.mockClear();
  });

  it('add_items → POST /items with the client line ids', async () => {
    await execQueuedOp(op({ orderId: 'o9', kind: 'add_items', payload: { items: [{ id: 'l1', menu_item_id: 'm', qty: 2 }] } }));
    expect(post).toHaveBeenCalledWith('/v1/orders/o9/items', { items: [{ id: 'l1', menu_item_id: 'm', qty: 2 }] }, { tenantSlug: 'sahan' });
  });

  it('update_item → PATCH /items/:id with the patch', async () => {
    await execQueuedOp(op({ orderId: 'o9', kind: 'update_item', payload: { itemId: 'l1', patch: { qty: 3 } } }));
    expect(patch).toHaveBeenCalledWith('/v1/orders/o9/items/l1', { qty: 3 }, { tenantSlug: 'sahan' });
  });

  it('void_item → POST /items/:id/void with the reason', async () => {
    await execQueuedOp(op({ orderId: 'o9', kind: 'void_item', payload: { itemId: 'l1', reason: 'oops' } }));
    expect(post).toHaveBeenCalledWith('/v1/orders/o9/items/l1/void', { reason: 'oops' }, { tenantSlug: 'sahan' });
  });

  it('send_kitchen → POST /send-to-kitchen', async () => {
    await execQueuedOp(op({ orderId: 'o9', kind: 'send_kitchen', payload: {} }));
    expect(post).toHaveBeenCalledWith('/v1/orders/o9/send-to-kitchen', {}, { tenantSlug: 'sahan' });
  });
});

// A guard so the imported helpers are considered used by the type-checker even
// though the harness re-implements the store mutations inline.
describe('helpers wiring', () => {
  it('exposes replayable/group helpers', () => {
    expect(replayableOps([]).length).toBe(0);
    expect(groupByOrder([]).size).toBe(0);
  });
});
