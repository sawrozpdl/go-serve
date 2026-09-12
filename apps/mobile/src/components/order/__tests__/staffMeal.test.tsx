/**
 * "Could not finish — Rs 260.00 of this bill hasn't been paid yet."
 *
 * A waiter rang up a staff meal, backed out before sending, then opened an
 * ordinary table's tab — and the footer offered **Finish** (close with no
 * payment) instead of **Settle**. Pressing it closed nothing: the server reads
 * staff_id off the locked order row, saw a real sale, and refused with the whole
 * total outstanding. It was sticky too, because the failure path left the flag
 * set, so every retry on every tab failed the same way.
 *
 * Two things made it possible, and both are pinned here: the draft's staff flag
 * was allowed to outvote a LOADED order, and the draft store was never reset
 * when navigating into an existing one.
 */
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { useDraftCart, startStaffMealDraft, clearDraft } from '@/stores/draftCart';
import { useOrderController } from '../useOrderController';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'l-1' }));
let mockOrderId = 'o-real'; // jest.mock factories may only close over names starting with "mock"
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ orderId: mockOrderId }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ok = (json: unknown) =>
  ({ status: 200, ok: true, statusText: '', json: async () => json }) as unknown as Response;

/** The order as the API actually sends it: staff_id present and NULL. That
 *  explicitness is half the fix — with `omitempty` the key was absent, and
 *  `undefined ?? draftStaffId` can never resolve to "not a staff meal". */
function mockWorld(order: Record<string, unknown>) {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes(`/v1/orders/${mockOrderId}/adjustments`)) return ok({ adjustments: [] });
    if (url.includes(`/v1/orders/${mockOrderId}`)) return ok(order);
    if (url.includes('/v1/menu/modifier-groups')) return ok({ groups: [] });
    if (url.includes('/v1/menu/categories')) return ok({ categories: [] });
    if (url.includes('/v1/menu/popular')) return ok({ items: [] });
    if (url.includes('/v1/menu/items')) return ok({ items: [] });
    if (url.includes('/v1/outlets')) return ok({ outlets: [] });
    if (url.includes('/v1/tables')) return ok({ tables: [] });
    if (url.includes('/v1/tenant')) return ok({ preferences: {} });
    if (url.includes('/v1/me')) {
      return ok({
        user_id: 'u',
        email: 'a@b.c',
        name: 'A',
        active_permissions: ['order:create', 'order:settle'],
        memberships: [],
      });
    }
    if (url.includes('/v1/orders')) return ok({ orders: [] });
    return ok({});
  });
}

const paidTab = {
  id: 'o-real',
  status: 'open',
  staff_id: null,
  staff_name: null,
  table_label: '',
  live_subtotal_cents: 26000,
  items: [],
};

beforeEach(() => {
  mockOrderId = 'o-real';
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  useTenantStore.setState({ active: { slug: 'sahan', id: 't1', name: 'Sahan' } });
  useConnectivity.setState({ mode: 'online' });
  clearDraft();
});
afterEach(() => {
  client.clear();
  jest.restoreAllMocks();
});

describe('a real tab is never mistaken for a staff meal', () => {
  it('ignores a stale draft staff id once the order has loaded', async () => {
    mockWorld(paidTab);
    // Exactly the leak from the field: a staff meal was started and abandoned.
    startStaffMealDraft('staff-7', 'Ramesh');

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.order.staff_id ?? null).toBeNull();
    // The footer reads this: false → "Settle", true → "Finish" (no payment).
    expect(result.current.isStaffMeal).toBe(false);
  });

  it('still trusts the draft flag while no order exists yet', async () => {
    // The flag's one legitimate job: a staff meal that hasn't been sent has no
    // server row to ask.
    mockOrderId = 'new';
    mockWorld(paidTab);
    startStaffMealDraft('staff-7', 'Ramesh');

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isStaffMeal).toBe(true);
  });

  it('honours a real staff meal the server reports', async () => {
    mockWorld({ ...paidTab, staff_id: 'staff-7', staff_name: 'Ramesh' });

    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isStaffMeal).toBe(true);
  });
});

describe('the draft never follows the device into another tab', () => {
  it('clearDraft drops the staff flag and the cart together', () => {
    startStaffMealDraft('staff-7', 'Ramesh');
    expect(useDraftCart.getState().staffId).toBe('staff-7');

    clearDraft();

    expect(useDraftCart.getState().staffId).toBeNull();
    expect(useDraftCart.getState().staffName).toBeNull();
    expect(useDraftCart.getState().items).toEqual([]);
  });
});
