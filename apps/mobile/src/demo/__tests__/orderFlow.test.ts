/**
 * The whole POS round trip driven through demoRequest — no React, no fetch.
 *
 * The last assertions are the important ones: after the reviewer settles a tab,
 * the day's history and the dashboard's Sales KPI must have moved by exactly the
 * same amount. They're two folds over one ledger with frozen totals, so this test
 * is what keeps that property from being quietly refactored away.
 */
import type {
  ApiError,
  KitchenTicket,
  Order,
  OrderHistoryResp,
  OrderItemRow,
  ReportsDashboard,
  SettleQuote,
  ServiceTable,
} from '@cafe-mgmt/api-types';
import { demoRequest } from '../transport';
import { resetWorld, localDay } from '../world';
import { ITEM_ID, TABLE_ID } from '../fixtures';
import type { SendResult } from '../orders';

const get = <T>(path: string) => demoRequest<T>('GET', path);
const post = <T>(path: string, body?: unknown) => demoRequest<T>('POST', path, { body });
const patch = <T>(path: string, body?: unknown) => demoRequest<T>('PATCH', path, { body });

beforeEach(() => resetWorld());

async function expectRejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the request to be rejected');
}

it('takes an order from open to closed and moves the day’s numbers', async () => {
  const today = localDay();
  const before = await get<ReportsDashboard>('/v1/reports/dashboard?range=today');
  const historyBefore = await get<OrderHistoryResp>(`/v1/orders/history?date=${today}`);

  // --- open a tab on a free table ---------------------------------------
  const tablesBefore = await get<{ tables: ServiceTable[] }>('/v1/tables');
  const free = tablesBefore.tables.find((t) => t.status === 'free')!;
  const order = await post<Order>('/v1/orders', { service_table_id: free.id });
  expect(order.status).toBe('open');
  expect(order.service_table_name).toBe(free.name);
  expect(
    (await get<{ tables: ServiceTable[] }>('/v1/tables')).tables.find((t) => t.id === free.id)!.status,
  ).toBe('occupied');

  // --- add two lines -----------------------------------------------------
  const lines = [
    { id: 'line-a', menu_item_id: ITEM_ID['Chicken Momo'], qty: 2 },
    { id: 'line-b', menu_item_id: ITEM_ID['Cappuccino'], qty: 1 },
  ];
  const added = await post<{ items: OrderItemRow[] }>(`/v1/orders/${order.id}/items`, { items: lines });
  expect(added.items).toHaveLength(2);
  expect(added.items[0].line_cents).toBe(2 * 32000);

  // Replaying the same batch must add nothing — the server's ON CONFLICT DO
  // NOTHING is what makes the offline queue exactly-once.
  const replay = await post<{ items: OrderItemRow[] }>(`/v1/orders/${order.id}/items`, { items: lines });
  expect(replay.items).toHaveLength(0);
  expect((await get<Order>(`/v1/orders/${order.id}`)).items).toHaveLength(2);

  // --- quote -------------------------------------------------------------
  const q = await get<SettleQuote>(`/v1/orders/${order.id}/quote`);
  const subtotal = 2 * 32000 + 22000;
  expect(q.subtotal_cents).toBe(subtotal);
  expect(q.service_charge_cents).toBe(Math.floor((subtotal * 1000 + 5000) / 10000));
  expect(q.balance_cents).toBe(q.total_cents);

  // --- fire the kitchen --------------------------------------------------
  const sent = await post<SendResult>(`/v1/orders/${order.id}/send-to-kitchen`);
  expect(sent).toEqual({ sent: 2, to_kitchen: 2, marked_ready: 0, auto_served: 0 });

  const mine = (ts: KitchenTicket[]) => ts.filter((t) => t.order_id === order.id);
  let tickets = mine((await get<{ tickets: KitchenTicket[] }>('/v1/kitchen/tickets')).tickets);
  expect(tickets).toHaveLength(2);
  expect(tickets.every((t) => t.kitchen_status === 'in_progress')).toBe(true);
  // Each ticket carries the outlet resolved from its category, so the KDS filter
  // and the ticket's own label are meaningful.
  expect(tickets.find((t) => t.menu_item_name === 'Cappuccino')!.outlet_name).toBe('Bar');
  expect(tickets.find((t) => t.menu_item_name === 'Chicken Momo')!.outlet_name).toBe('Kitchen');

  // --- advance both to served -------------------------------------------
  for (const t of tickets) await patch(`/v1/kitchen/tickets/${t.item_id}`, { kitchen_status: 'ready' });
  tickets = mine((await get<{ tickets: KitchenTicket[] }>('/v1/kitchen/tickets')).tickets);
  expect(tickets.every((t) => t.kitchen_status === 'ready')).toBe(true);

  // in_progress → served skips a step; the server rejects it and so must we.
  const jump = await expectRejection(
    patch(`/v1/kitchen/tickets/${tickets[0].item_id}`, { kitchen_status: 'in_progress' }),
  );
  expect(jump.code).toBe('invalid_transition');

  for (const t of tickets) await patch(`/v1/kitchen/tickets/${t.item_id}`, { kitchen_status: 'served' });
  const served = await get<Order>(`/v1/orders/${order.id}`);
  expect(served.items_served).toBe(2);
  // A served line leaves the board.
  expect(mine((await get<{ tickets: KitchenTicket[] }>('/v1/kitchen/tickets')).tickets)).toHaveLength(0);

  // --- settle ------------------------------------------------------------
  const half = Math.floor(q.total_cents / 2);
  await post(`/v1/orders/${order.id}/payments`, { method: 'cash', amount_cents: half });

  const outstanding = await expectRejection(post(`/v1/orders/${order.id}/close`));
  expect(outstanding.code).toBe('balance_outstanding');

  const over = await expectRejection(
    post(`/v1/orders/${order.id}/payments`, { method: 'cash', amount_cents: q.total_cents }),
  );
  expect(over.code).toBe('overpayment');

  await post(`/v1/orders/${order.id}/payments`, {
    method: 'online',
    amount_cents: q.total_cents - half,
  });
  const closed = await post<SettleQuote>(`/v1/orders/${order.id}/close`);
  expect(closed.balance_cents).toBe(0);
  expect(closed.total_cents).toBe(q.total_cents);

  // Closing a second time conflicts rather than double-counting.
  expect((await expectRejection(post(`/v1/orders/${order.id}/close`))).code).toBe('already_closed');

  // The table needs cleaning (autoCleanTables is off in the demo tenant).
  expect(
    (await get<{ tables: ServiceTable[] }>('/v1/tables')).tables.find((t) => t.id === free.id)!.status,
  ).toBe('dirty');

  // --- history and the dashboard agree ----------------------------------
  const historyAfter = await get<OrderHistoryResp>(`/v1/orders/history?date=${today}`);
  expect(historyAfter.orders).toHaveLength(historyBefore.orders.length + 1);
  const row = historyAfter.orders.find((o) => o.id === order.id)!;
  expect(row.total_cents).toBe(q.total_cents);
  expect(row.payments.map((p) => p.method).sort()).toEqual(['cash', 'online']);

  const after = await get<ReportsDashboard>('/v1/reports/dashboard?range=today');
  expect(after.kpis.sales_cents - before.kpis.sales_cents).toBe(q.total_cents);
  expect(after.kpis.order_count).toBe(before.kpis.order_count + 1);
  // And the day's history rows still sum to the KPI, not merely move with it.
  expect(historyAfter.orders.reduce((s, o) => s + o.total_cents, 0)).toBe(after.kpis.sales_cents);
});

it('reproduces the discount rule and reflects it in the quote', async () => {
  const order = await post<Order>('/v1/orders', { table_label: 'Walk-in' });
  await post(`/v1/orders/${order.id}/items`, {
    items: [{ id: 'd-1', menu_item_id: ITEM_ID['Mocha'], qty: 1 }],
  });

  await post(`/v1/orders/${order.id}/adjustments`, {
    type: 'discount',
    amount_cents: 2800,
    reason: 'regular',
  });
  const q = await get<SettleQuote>(`/v1/orders/${order.id}/quote`);
  expect(q.discount_cents).toBe(2800);

  const tooMuch = await expectRejection(
    post(`/v1/orders/${order.id}/adjustments`, { type: 'discount', amount_cents: 999999 }),
  );
  expect(tooMuch.code).toBe('discount_exceeds_bill');
});

it('charges a tab to credit and keeps the account balance truthful', async () => {
  const tabsBefore = await get<{ house_tabs: { id: string; name: string; balance_cents: number }[] }>(
    '/v1/house-tabs',
  );
  const staff = tabsBefore.house_tabs.find((t) => t.name === 'Staff tab')!;

  const order = await post<Order>('/v1/orders', { table_label: 'Credit test' });
  await post(`/v1/orders/${order.id}/items`, {
    items: [{ id: 'c-1', menu_item_id: ITEM_ID['Espresso'], qty: 1 }],
  });
  const q = await get<SettleQuote>(`/v1/orders/${order.id}/quote`);
  await post(`/v1/orders/${order.id}/payments`, {
    method: 'house_tab',
    amount_cents: q.total_cents,
    house_tab_id: staff.id,
  });
  await post(`/v1/orders/${order.id}/close`);

  const after = await get<{ house_tabs: { id: string; balance_cents: number }[] }>('/v1/house-tabs');
  expect(after.house_tabs.find((t) => t.id === staff.id)!.balance_cents).toBe(
    staff.balance_cents + q.total_cents,
  );
});

it('voids a line without losing it, and drops it from the totals', async () => {
  const order = await post<Order>('/v1/orders', { table_label: 'Void test' });
  await post(`/v1/orders/${order.id}/items`, {
    items: [
      { id: 'v-1', menu_item_id: ITEM_ID['Espresso'], qty: 1 },
      { id: 'v-2', menu_item_id: ITEM_ID['Mocha'], qty: 1 },
    ],
  });
  await post(`/v1/orders/${order.id}/items/v-2/void`, { reason: 'wrong order' });

  const after = await get<Order>(`/v1/orders/${order.id}`);
  expect(after.items).toHaveLength(2); // kept, for the audit trail
  expect(after.items_total).toBe(1);
  expect((await get<SettleQuote>(`/v1/orders/${order.id}/quote`)).subtotal_cents).toBe(18000);
});

it('moves a tab, merging into the target table’s existing tab', async () => {
  const a = await post<Order>('/v1/orders', { service_table_id: TABLE_ID.G3 });
  await post(`/v1/orders/${a.id}/items`, {
    items: [{ id: 'm-1', menu_item_id: ITEM_ID['Espresso'], qty: 1 }],
  });
  const b = await post<Order>('/v1/orders', { service_table_id: TABLE_ID.G4 });
  await post(`/v1/orders/${b.id}/items`, {
    items: [{ id: 'm-2', menu_item_id: ITEM_ID['Mocha'], qty: 1 }],
  });

  const moved = await post<{ order_id: string; merged: boolean }>(`/v1/orders/${a.id}/move`, {
    service_table_id: TABLE_ID.G4,
  });
  expect(moved).toEqual({ order_id: b.id, merged: true });
  expect((await get<Order>(`/v1/orders/${b.id}`)).items).toHaveLength(2);
  expect(
    (await get<{ tables: ServiceTable[] }>('/v1/tables')).tables.find((t) => t.id === TABLE_ID.G3)!.status,
  ).toBe('free');
});

it('rejects closing an empty tab, and cancels it instead', async () => {
  const order = await post<Order>('/v1/orders', { table_label: 'Empty' });
  expect((await expectRejection(post(`/v1/orders/${order.id}/close`))).code).toBe('empty_order');
  await post(`/v1/orders/${order.id}/cancel`);
  expect((await get<Order>(`/v1/orders/${order.id}`)).status).toBe('cancelled');
});
