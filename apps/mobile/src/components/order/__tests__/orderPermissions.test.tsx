/**
 * Order-taking permission + race guards, brought level with web's TabPage.
 *
 * Two properties that used to be wrong on mobile:
 *
 *  1. Stacking a repeated item bumps an EXISTING server line's qty, which is a
 *     PATCH — so it needs `order:update_item`. An add-only waiter used to get a
 *     403 on the second tap. The DRAFT cart is device-local and PATCHes
 *     nothing, so it must keep stacking on the preference alone.
 *  2. A line whose insert is still in flight has no server row yet, so editing
 *     it 404s. Web skips those lines; mobile did not.
 */
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MenuItem, Order } from '@cafe-mgmt/api-types';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { useDraftCart, startDraft } from '@/stores/draftCart';
import { qk } from '@/api/queryKeys';
import { useOrderController } from '../useOrderController';

let uuidN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `l-${(uuidN += 1)}` }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ orderId: mockOrderId }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const SLUG = 'sahan';
/** Read by the expo-router mock above; 'new' puts the controller in draft mode.
 *  Named `mock*` because jest.mock factories may only close over such names. */
let mockOrderId = 'o1';
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const latte = (): MenuItem =>
  ({
    id: 'm1',
    category_id: 'c1',
    name: 'Latte',
    description: '',
    price_cents: 300,
    icon: '',
    is_active: true,
    is_featured: false,
    kitchen_behavior: 'inherit',
    allow_half: false,
    sort: 0,
    modifiers: null,
    preset_notes: [],
    modifier_group_ids: [],
  }) as unknown as MenuItem;

/** An open order already holding one pending Latte — the line a second tap
 *  would stack onto. */
const openOrder = (): Order =>
  ({
    id: 'o1',
    service_table_id: 'tbl1',
    status: 'open',
    opened_at: new Date().toISOString(),
    live_subtotal_cents: 300,
    items_total: 1,
    items_pending: 1,
    items_in_progress: 0,
    items_ready: 0,
    items_served: 0,
    items: [
      {
        id: 'existing-line',
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
        kitchen_status: 'pending',
        created_at: new Date().toISOString(),
      },
    ],
  }) as unknown as Order;

/** Records every request so a test can tell a PATCH (stack) from a POST (new
 *  line). `addItems` never resolves when `holdAdd` is set — that is how a line
 *  is held "in flight". */
function mockRoutes(perms: string[], opts: { holdAdd?: boolean; order?: Order } = {}) {
  const calls: { method: string; url: string }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    let json: unknown = {};
    if (url.includes('/items') && method === 'POST') {
      if (opts.holdAdd) await new Promise(() => {}); // never settles
      json = { items: [] };
    } else if (url.includes('/v1/orders/o1')) json = opts.order ?? openOrder();
    else if (url.includes('/v1/orders')) json = { orders: [] };
    else if (url.includes('/v1/menu/modifier-groups')) json = { groups: [] };
    else if (url.includes('/v1/menu/categories')) json = { categories: [] };
    else if (url.includes('/v1/menu/popular')) json = { items: [] };
    else if (url.includes('/v1/menu/items')) json = { items: [latte()] };
    else if (url.includes('/v1/outlets')) json = { outlets: [] };
    else if (url.includes('/v1/tables')) json = { tables: [] };
    else if (url.includes('/v1/tenant')) json = { preferences: { stackItems: true } };
    else if (url.includes('/v1/me')) {
      json = { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] };
    }
    return { status: 200, ok: true, statusText: '', json: async () => json } as unknown as Response;
  });
  return calls;
}

beforeEach(() => {
  mockOrderId = 'o1';
  uuidN = 0;
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  // useMe() is gated on an authenticated session, and every permission flag
  // the controller exposes reads from it.
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } });
  useConnectivity.setState({ mode: 'online' });
  useDraftCart.setState({ tableId: null, tableName: null, label: '', items: [] });
});
afterEach(() => {
  client.clear();
  jest.restoreAllMocks();
});

describe('stacking is gated on order:update_item', () => {
  it('stacks onto the existing line when the member may edit items', async () => {
    const calls = mockRoutes(['order:read', 'order:create', 'order:add_items', 'order:update_item']);
    client.setQueryData(qk.order(SLUG, 'o1'), openOrder());

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await waitFor(() => expect(result.current.canAdd).toBe(true));

    await act(async () => {
      await result.current.addMenuItem(latte());
    });

    // Bumped the existing line rather than opening a second one.
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('existing-line'))).toBe(true),
    );
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/items'))).toBe(false);
  });

  it('adds a fresh line instead of PATCHing when the member may only add', async () => {
    // No `order:update_item` — the old code PATCHed anyway and ate a 403.
    const calls = mockRoutes(['order:read', 'order:create', 'order:add_items']);
    client.setQueryData(qk.order(SLUG, 'o1'), openOrder());

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await waitFor(() => expect(result.current.canAdd).toBe(true));

    await act(async () => {
      await result.current.addMenuItem(latte());
    });

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/items'))).toBe(true),
    );
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('still stacks the device-local draft cart without that permission', async () => {
    // A draft PATCHes nothing, so the edit permission must not gate it.
    mockOrderId = 'new';
    mockRoutes(['order:read', 'order:create', 'order:add_items']);
    startDraft('tbl1', 'T1');

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await result.current.addMenuItem(latte());
      await result.current.addMenuItem(latte());
    });

    const draft = useDraftCart.getState().items;
    expect(draft).toHaveLength(1);
    expect(draft[0].qty).toBe(2);
  });
});

describe('lines whose insert is still in flight are left alone', () => {
  it('opens a second line rather than PATCHing an id the server has not accepted', async () => {
    // An order with no lines yet, so the first tap POSTs (and hangs in flight).
    const empty = { ...openOrder(), items: [] } as Order;
    const calls = mockRoutes(
      ['order:read', 'order:create', 'order:add_items', 'order:update_item'],
      { holdAdd: true, order: empty },
    );
    client.setQueryData(qk.order(SLUG, 'o1'), empty);

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await waitFor(() => expect(result.current.canAdd).toBe(true));

    await act(async () => {
      void result.current.addMenuItem(latte()); // stays in flight
    });
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').length).toBe(1));

    // Second tap: the optimistic line is present but unconfirmed, so stacking
    // must skip it and post a new line instead of PATCHing a 404.
    await act(async () => {
      void result.current.addMenuItem(latte());
    });

    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').length).toBe(2));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
