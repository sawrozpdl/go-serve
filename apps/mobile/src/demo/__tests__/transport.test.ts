/**
 * The exhaustiveness guard.
 *
 * Three surfaces a guest can reach have no isError branch at all —
 * useOrderController (an order or menu read that fails renders an empty ticket
 * for the wrong tab), SettleSheet (no quote leaves its card stuck on "Loading…"
 * and the footer reading "Collect Rs 0 to close"), and the floor's order list
 * (a failure shows every table free, an empty café). On those, a route we forgot
 * is not an error message — it is silent wrongness.
 *
 * So this walks every (method, path) the in-scope screens can emit and asserts
 * none of them falls through to the demo_unsupported fallback. It is the reason
 * that fallback is safe to have.
 */
import { DEMO_UNSUPPORTED } from '../errors';
import { demoRequest } from '../transport';
import { resetWorld } from '../world';
import { ITEM_ID, TABLE_ID } from '../fixtures';
import type { ApiError, Order } from '@cafe-mgmt/api-types';

beforeEach(() => resetWorld());

/** Every path a guest's screens can produce, with the ids they'd carry. */
async function reachablePaths(): Promise<[method: string, path: string, body?: unknown][]> {
  // Build a live order so the per-order paths address something real.
  const order = await demoRequest<Order>('POST', '/v1/orders', {
    body: { service_table_id: TABLE_ID.T2 },
  });
  await demoRequest('POST', `/v1/orders/${order.id}/items`, {
    body: { items: [{ id: 'probe-1', menu_item_id: ITEM_ID['Espresso'], qty: 1 }] },
  });
  const oid = order.id;

  return [
    // app/index.tsx, more/index.tsx, every hook's tenant context
    ['GET', '/v1/me'],
    ['GET', '/v1/tenant'],
    ['PATCH', '/v1/tenant', { preferences: { stackItems: false } }],
    // floor + order screens (useOrderController)
    ['GET', '/v1/tables'],
    ['PATCH', `/v1/tables/${TABLE_ID.P2}`, { status: 'free' }],
    ['GET', '/v1/outlets'],
    ['GET', '/v1/menu/categories'],
    ['GET', '/v1/menu/items'],
    ['GET', '/v1/menu/modifier-groups'],
    ['GET', '/v1/menu/popular?limit=12'],
    ['GET', '/v1/orders?status=open'],
    ['GET', '/v1/orders?status=closed'],
    ['POST', '/v1/orders', { table_label: 'probe' }],
    ['GET', `/v1/orders/${oid}`],
    ['POST', `/v1/orders/${oid}/items`, { items: [] }],
    ['PATCH', `/v1/orders/${oid}/items/probe-1`, { qty: 2 }],
    ['POST', `/v1/orders/${oid}/rename`, { table_label: 'Renamed' }],
    ['POST', `/v1/orders/${oid}/move`, { service_table_id: null }],
    ['POST', `/v1/orders/${oid}/send-to-kitchen`],
    // settle (SettleSheet)
    ['GET', `/v1/orders/${oid}/quote`],
    ['GET', `/v1/orders/${oid}/payments`],
    ['GET', `/v1/orders/${oid}/adjustments`],
    ['GET', '/v1/house-tabs'],
    ['POST', '/v1/house-tabs', { name: 'Probe account' }],
    // kitchen
    ['GET', '/v1/kitchen/tickets'],
    // history + dashboard + top sellers
    ['GET', '/v1/orders/history?date=2026-08-19'],
    ['GET', '/v1/reports/dashboard?range=today'],
    ['GET', '/v1/reports/dashboard?range=yesterday'],
    ['GET', '/v1/reports/dashboard?range=7d'],
    ['GET', '/v1/reports/dashboard?range=30d'],
    ['GET', '/v1/reports/dashboard?range=mtd'],
    ['GET', '/v1/reports/dashboard?range=ytd'],
    ['GET', '/v1/reports/movers?range=30d&sort=revenue&order=desc&limit=50&offset=0'],
    ['GET', '/v1/reports/movers?range=7d&sort=qty&order=asc'],
    // reachable via more/menu's inventory-link picker
    ['GET', '/v1/inventory'],
    ['GET', `/v1/menu/items/${ITEM_ID['Espresso']}/inventory-link`],
  ];
}

it('answers every path the in-scope screens can emit', async () => {
  const paths = await reachablePaths();
  const unhandled: string[] = [];

  for (const [method, path, body] of paths) {
    try {
      await demoRequest(method, path, { body });
    } catch (e) {
      // A business-rule rejection is the demo working; only the fallback is a bug.
      if ((e as ApiError).code === DEMO_UNSUPPORTED) unhandled.push(`${method} ${path}`);
    }
  }

  expect(unhandled).toEqual([]);
});

it('answers the void and payment paths that carry two ids', async () => {
  const order = await demoRequest<Order>('POST', '/v1/orders', { body: { table_label: 'two-ids' } });
  await demoRequest('POST', `/v1/orders/${order.id}/items`, {
    body: { items: [{ id: 'x-1', menu_item_id: ITEM_ID['Mocha'], qty: 1 }] },
  });

  const adj = await demoRequest<{ id: string }>('POST', `/v1/orders/${order.id}/adjustments`, {
    body: { type: 'discount', amount_cents: 100 },
  });
  await expect(
    demoRequest('DELETE', `/v1/orders/${order.id}/adjustments/${adj.id}`),
  ).resolves.toBeUndefined();

  const pay = await demoRequest<{ id: string }>('POST', `/v1/orders/${order.id}/payments`, {
    body: { method: 'cash', amount_cents: 100 },
  });
  await expect(
    demoRequest('POST', `/v1/orders/${order.id}/payments/${pay.id}/reclassify`, {
      body: { method: 'online' },
    }),
  ).resolves.toBeDefined();
  await expect(
    demoRequest('DELETE', `/v1/orders/${order.id}/payments/${pay.id}`),
  ).resolves.toBeUndefined();

  await expect(
    demoRequest('POST', `/v1/orders/${order.id}/items/x-1/void`, { body: { reason: 'test' } }),
  ).resolves.toBeUndefined();
});

it('rejects an out-of-scope endpoint with a legible end state, not a crash', async () => {
  // Silence the intentional dev-only console.error the fallback emits.
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const path of ['/v1/shifts/current', '/v1/expenses', '/v1/members', '/v1/super/tenants']) {
      const err = await demoRequest('GET', path).catch((e: ApiError) => e);
      expect(err).toMatchObject({ status: 501, code: DEMO_UNSUPPORTED });
      expect((err as ApiError).message).toMatch(/guest demo/i);
    }
  } finally {
    spy.mockRestore();
  }
});

it('does not confuse /v1/orders/history for an order id', async () => {
  const res = await demoRequest<{ date: string }>('GET', '/v1/orders/history?date=2026-08-19');
  expect(res.date).toBe('2026-08-19');
});

it('never returns a live reference into the world', async () => {
  const a = await demoRequest<{ tables: unknown[] }>('GET', '/v1/tables');
  const b = await demoRequest<{ tables: unknown[] }>('GET', '/v1/tables');
  expect(a.tables).toEqual(b.tables);
  // Same values, different objects — mutating a response can't corrupt the world,
  // and react-query sees a genuinely new object each refetch.
  expect(a.tables).not.toBe(b.tables);
});
