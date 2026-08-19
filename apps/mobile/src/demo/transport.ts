/**
 * The demo backend's front door. src/api/client.ts routes every request here when
 * guest mode is on, so no fetch, socket, or poll leaves the device.
 *
 * Matching is an ordered list of {method, pattern, handler}. Query strings are
 * stripped before matching and parsed inside the handler, because the hooks build
 * paths like `/v1/menu/popular?limit=12` and `/v1/reports/dashboard?range=7d`.
 *
 * The table must be EXHAUSTIVE for every screen a guest can reach — not merely
 * "good enough". Three in-scope surfaces have no error branch at all
 * (useOrderController, SettleSheet's quote, floor's order list), so a route we
 * forget renders as silent wrongness rather than a legible message: an empty
 * ticket, a card stuck on "Loading…", a café where every table looks free. The
 * unsupported() fallback logs loudly in dev and
 * src/demo/__tests__/transport.test.ts asserts every reachable path resolves.
 */
import type { RequestOpts } from '../api/client';
import { unsupported } from './errors';
import { getWorld } from './world';
import './seed'; // registers the seeder with the world module
import * as orders from './orders';
import * as settle from './settle';
import * as kitchen from './kitchen';
import * as reports from './reports';
import type { DashboardRange, KitchenStatus, MoversQuery, PaymentMethod } from '@cafe-mgmt/api-types';

/** A touch of latency so skeleton states actually render and the demo reads as a
 *  real app rather than a static mock. Zero under test. */
const LATENCY_MS = process.env.NODE_ENV === 'test' ? 0 : 120;

type Ctx = {
  /** Path segments captured by the route pattern, in order. */
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
};

type Handler = (ctx: Ctx) => unknown;
type Route = { method: string; pattern: RegExp; handler: Handler };

const UUID = '([^/?]+)';

const route = (method: string, pattern: string, handler: Handler): Route => ({
  method,
  pattern: new RegExp(`^${pattern}$`),
  handler,
});

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

const ROUTES: Route[] = [
  // --- identity + tenant -------------------------------------------------
  route('GET', '/v1/me', () => getWorld().me),
  route('GET', '/v1/tenant', () => getWorld().tenant),
  route('PATCH', '/v1/tenant', ({ body }) => {
    const t = getWorld().tenant;
    if (body.preferences && typeof body.preferences === 'object') {
      t.preferences = { ...t.preferences, ...(body.preferences as object) };
    }
    for (const key of ['name', 'contact_phone'] as const) {
      if (typeof body[key] === 'string') t[key] = body[key] as string;
    }
    return t;
  }),
  // Logout is never constructed in demo mode (more/index.tsx branches first), but
  // answering it keeps any future caller from hitting the real API.
  route('POST', '/auth/logout', () => undefined),
  route('GET', '/auth/config', () => ({
    google_enabled: true,
    dev_login_enabled: false,
    email_otp_enabled: false,
  })),

  // --- catalog -----------------------------------------------------------
  route('GET', '/v1/menu/categories', () => ({ categories: getWorld().categories })),
  route('GET', '/v1/menu/items', () => ({ items: getWorld().items })),
  route('GET', '/v1/menu/modifier-groups', () => ({ groups: getWorld().groups })),
  route('GET', '/v1/menu/popular', ({ query }) => {
    const w = getWorld();
    const limit = num(query.get('limit'), 12);
    // Featured first, then catalog order — the same "operator pin, then velocity"
    // spirit as the real endpoint.
    const ranked = [...w.items].sort(
      (a, b) => Number(b.is_featured) - Number(a.is_featured) || a.sort - b.sort,
    );
    return {
      items: ranked.slice(0, limit).map((i) => ({ ...i, qty_30d: i.is_featured ? 120 : 30 })),
    };
  }),
  route('GET', `/v1/menu/items/${UUID}/inventory-link`, () => ({ links: [] })),
  route('PUT', `/v1/menu/items/${UUID}/inventory-link`, () => ({ links: [] })),
  route('GET', '/v1/tables', () => ({ tables: getWorld().tables })),
  route('PATCH', `/v1/tables/${UUID}`, ({ params, body }) => {
    const table = getWorld().tables.find((t) => t.id === params[0]);
    if (!table) throw unsupported('PATCH', '/v1/tables');
    // The floor's sweep sends { status: 'free' }.
    if (typeof body.status === 'string') table.status = body.status as typeof table.status;
    return table;
  }),
  route('GET', '/v1/outlets', () => ({ outlets: getWorld().outlets })),
  route('GET', '/v1/inventory', () => ({ items: getWorld().inventory })),
  route('GET', '/v1/house-tabs', () => ({ house_tabs: getWorld().houseTabs })),
  route('POST', '/v1/house-tabs', ({ body }) => {
    const w = getWorld();
    const tab = {
      id: `d0000000-0000-4000-8000-9${String(w.houseTabs.length).padStart(11, '0')}`,
      name: String(body.name ?? 'New account'),
      notes: String(body.notes ?? ''),
      contact_phone: String(body.contact_phone ?? ''),
      is_active: true,
      charged_cents: num(body.opening_balance_cents, 0),
      settled_cents: 0,
      balance_cents: num(body.opening_balance_cents, 0),
      open_charge_count: 0,
      created_at: new Date().toISOString(),
      archived_at: null,
    };
    w.houseTabs.push(tab);
    return tab;
  }),

  // --- orders ------------------------------------------------------------
  route('GET', '/v1/orders', ({ query }) => {
    const status = query.get('status') ?? 'open';
    return { orders: getWorld().orders.filter((o) => o.status === status) };
  }),
  route('POST', '/v1/orders', ({ body }) => orders.openOrder(body as never)),
  // Must sit AFTER /v1/orders/history so the literal wins over the id capture.
  route('GET', '/v1/orders/history', ({ query }) =>
    reports.history(query.get('date') ?? new Date().toISOString().slice(0, 10)),
  ),
  route('GET', `/v1/orders/${UUID}/quote`, ({ params }) => settle.quote(params[0])),
  route('GET', `/v1/orders/${UUID}/payments`, ({ params }) => ({
    payments: settle.paymentsFor(params[0]),
  })),
  route('POST', `/v1/orders/${UUID}/payments`, ({ params, body }) =>
    settle.recordPayment(params[0], {
      method: body.method as PaymentMethod,
      amount_cents: num(body.amount_cents, 0),
      reference_no: body.reference_no as string | undefined,
      house_tab_id: (body.house_tab_id as string | null | undefined) ?? null,
    }),
  ),
  route('DELETE', `/v1/orders/${UUID}/payments/${UUID}`, ({ params }) =>
    settle.deletePayment(params[0], params[1]),
  ),
  route('POST', `/v1/orders/${UUID}/payments/${UUID}/reclassify`, ({ params, body }) =>
    settle.reclassifyPayment(params[0], params[1], body.method as PaymentMethod),
  ),
  route('GET', `/v1/orders/${UUID}/adjustments`, ({ params }) => ({
    adjustments: settle.adjustmentsFor(params[0]),
  })),
  route('POST', `/v1/orders/${UUID}/adjustments`, ({ params, body }) =>
    settle.applyAdjustment(params[0], {
      type: (body.type as 'discount') ?? 'discount',
      amount_cents: num(body.amount_cents, 0),
      reason: body.reason as string | undefined,
    }),
  ),
  route('DELETE', `/v1/orders/${UUID}/adjustments/${UUID}`, ({ params }) =>
    settle.removeAdjustment(params[0], params[1]),
  ),
  route('POST', `/v1/orders/${UUID}/close`, ({ params }) => settle.closeOrder(params[0])),
  route('POST', `/v1/orders/${UUID}/send-to-kitchen`, ({ params }) =>
    orders.sendToKitchen(params[0]),
  ),
  route('POST', `/v1/orders/${UUID}/cancel`, ({ params }) => orders.cancelOrder(params[0])),
  route('POST', `/v1/orders/${UUID}/rename`, ({ params, body }) =>
    orders.renameOrder(params[0], String(body.table_label ?? '')),
  ),
  route('POST', `/v1/orders/${UUID}/move`, ({ params, body }) =>
    orders.moveOrder(params[0], (body.service_table_id as string | null) ?? null),
  ),
  route('POST', `/v1/orders/${UUID}/items`, ({ params, body }) =>
    orders.addItems(params[0], body as never),
  ),
  route('PATCH', `/v1/orders/${UUID}/items/${UUID}`, ({ params, body }) =>
    orders.updateItem(params[0], params[1], body as never),
  ),
  route('POST', `/v1/orders/${UUID}/items/${UUID}/void`, ({ params, body }) =>
    orders.voidItem(params[0], params[1], body.reason as string | undefined),
  ),
  route('GET', `/v1/orders/${UUID}`, ({ params }) =>
    getWorld().orders.find((o) => o.id === params[0]) ?? null,
  ),

  // --- kitchen -----------------------------------------------------------
  route('GET', '/v1/kitchen/tickets', () => ({ tickets: kitchen.tickets() })),
  route('PATCH', `/v1/kitchen/tickets/${UUID}`, ({ params, body }) =>
    kitchen.advance(params[0], body.kitchen_status as KitchenStatus),
  ),

  // --- reports -----------------------------------------------------------
  route('GET', '/v1/reports/dashboard', ({ query }) =>
    reports.dashboard((query.get('range') ?? 'today') as DashboardRange),
  ),
  route('GET', '/v1/reports/movers', ({ query }) => {
    const q: MoversQuery = {};
    const cat = query.get('category_id');
    const needle = query.get('q');
    if (cat) q.category_id = cat;
    if (needle) q.q = needle;
    if (query.get('sort')) q.sort = query.get('sort') as MoversQuery['sort'];
    if (query.get('order')) q.order = query.get('order') as MoversQuery['order'];
    if (query.get('limit')) q.limit = num(query.get('limit'), 100);
    if (query.get('offset')) q.offset = num(query.get('offset'), 0);
    return reports.movers((query.get('range') ?? '30d') as DashboardRange, q);
  }),
];

/**
 * Snapshot the handler's result, the way a real HTTP response is a snapshot.
 *
 * Without this the transport hands back live references into the mutable world,
 * and two things break. react-query compares a refetch against the cached value
 * structurally, so an in-place mutation to an object it already holds looks
 * "unchanged" — it keeps the old reference and skips the re-render, leaving a
 * stale number on screen. And a component holding a returned object would see the
 * world change under it between renders. Cloning at the boundary makes the demo
 * behave like a network, which is the only behaviour the hooks were written for.
 *
 * Payloads here are small (a day of history, a menu), so the copy is cheap.
 */
function snapshot<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  // Multipart uploads reach the transport as FormData; nothing in the demo's scope
  // uploads, so treat it as empty rather than pretending to read it.
  if (typeof FormData !== 'undefined' && body instanceof FormData) return {};
  return body as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Answer a request from the in-memory demo world. Rejects with a plain ApiError,
 *  exactly like the real fetch layer, so every existing catch site works. */
export async function demoRequest<T>(
  method: string,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  if (LATENCY_MS > 0) await sleep(LATENCY_MS);

  const qIndex = path.indexOf('?');
  const pathname = qIndex === -1 ? path : path.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : path.slice(qIndex + 1));

  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    return snapshot(
      r.handler({
        params: m.slice(1),
        query,
        body: parseBody(opts.body),
      }),
    ) as T;
  }
  throw unsupported(method, pathname);
}
