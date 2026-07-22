/**
 * Deferred order creation: while a walk-in / table order is still a draft, the
 * cart lives on the device (the useDraftCart store) and NOTHING is created on the
 * server. Only the first "Send to kitchen" opens the tab — create → add items →
 * send — and then the draft is cleared.
 */
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MenuItem } from '@cafe-mgmt/api-types';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { useDraftCart, startDraft } from '@/stores/draftCart';
import { useOrderController } from '../useOrderController';

let uuidN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `l-${(uuidN += 1)}` }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ orderId: 'new' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const SLUG = 'sahan';
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const CREATED = {
  id: 'o-new',
  service_table_id: 'tbl1',
  service_table_name: 'T1',
  table_label: '',
  status: 'open',
  opened_by_user_id: 'u',
  opened_at: '',
  items: [],
  live_subtotal_cents: 0,
  items_pending: 0,
  items_in_progress: 0,
  items_ready: 0,
  items_served: 0,
  items_total: 0,
  paid_cents: 0,
};

function mockRoutes() {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // Order matters: most-specific paths first.
    let json: unknown = {};
    if (url.includes('send-to-kitchen')) json = { sent: 1, to_kitchen: 1, marked_ready: 0, auto_served: 0 };
    else if (url.includes('/v1/orders/o-new/items')) json = { items: [] };
    else if (url.includes('/v1/orders/o-new')) json = CREATED;
    else if (url.includes('/v1/orders')) json = body ? CREATED : { orders: [] };
    else if (url.includes('/v1/menu/categories')) json = { categories: [] };
    else if (url.includes('/v1/menu/popular')) json = { items: [] };
    else if (url.includes('/v1/menu/items')) json = { items: [] };
    else if (url.includes('/v1/outlets')) json = { outlets: [] };
    else if (url.includes('/v1/tables')) json = { tables: [] };
    else if (url.includes('/v1/tenant')) json = { preferences: {} };
    else if (url.includes('/v1/me')) json = { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: ['order:create', 'order:send_kitchen'], memberships: [] };
    return { status: 200, ok: true, statusText: '', json: async () => json } as unknown as Response;
  });
}

const menuItem = (over: Partial<MenuItem> = {}): MenuItem =>
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
    ...over,
  }) as MenuItem;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } });
  useConnectivity.setState({ mode: 'online' });
  useDraftCart.setState({ tableId: null, tableName: null, items: [] });
});
afterEach(() => {
  client.clear();
  jest.restoreAllMocks();
});

describe('deferred order creation', () => {
  it('adding items to a draft touches the device cart only — no order is created', async () => {
    const fetchSpy = mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(menuItem());
      await result.current.addMenuItem(menuItem()); // stacks onto the same line
    });

    // The cart is on the device…
    const draft = useDraftCart.getState().items;
    expect(draft).toHaveLength(1);
    expect(draft[0].qty).toBe(2);
    expect(result.current.orderId).toBeNull();
    expect(result.current.pendingCount).toBe(2);

    // …and no order was ever POSTed to the server.
    const createCalls = fetchSpy.mock.calls.filter(
      ([u, init]) => (init as RequestInit)?.method === 'POST' && String(u).endsWith('/v1/orders'),
    );
    expect(createCalls).toHaveLength(0);
  });

  it('first Send opens the tab: create → add items → send, then clears the draft', async () => {
    const fetchSpy = mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(menuItem());
    });
    await act(async () => {
      await result.current.doSend();
    });

    const posts = fetchSpy.mock.calls
      .filter(([, init]) => (init as RequestInit)?.method === 'POST')
      .map(([u]) => String(u));

    expect(posts.some((u) => u.endsWith('/v1/orders'))).toBe(true); // created
    expect(posts.some((u) => u.includes('/v1/orders/o-new/items'))).toBe(true); // items pushed
    expect(posts.some((u) => u.includes('/v1/orders/o-new/send-to-kitchen'))).toBe(true); // fired

    // The order that was created carried the draft's table.
    const createCall = fetchSpy.mock.calls.find(
      ([u, init]) => (init as RequestInit)?.method === 'POST' && String(u).endsWith('/v1/orders'),
    );
    expect(JSON.parse(String((createCall![1] as RequestInit).body))).toMatchObject({ service_table_id: 'tbl1' });

    // Draft cart is emptied and the controller now points at the real order.
    expect(useDraftCart.getState().items).toHaveLength(0);
    expect(result.current.orderId).toBe('o-new');
  });

  it('cancelling a draft just clears the on-device cart (nothing to cancel server-side)', async () => {
    const fetchSpy = mockRoutes();
    startDraft(null, null);
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await result.current.addMenuItem(menuItem());
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.cancelOrder();
    });

    expect(ok).toBe(true);
    expect(useDraftCart.getState().items).toHaveLength(0);
    const cancelCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/cancel'));
    expect(cancelCalls).toHaveLength(0);
  });
});
