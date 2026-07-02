/**
 * M5 wiring: while offline, order mutations enqueue a replayable op and DO NOT
 * hit the network — the optimistic cache is the truth until the queue drains.
 */
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Order } from '@cafe-mgmt/api-types';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { useOfflineQueue, getQueuedOps } from '@/offline/queue';
import { qk } from '@/api/queryKeys';
import {
  useAddOrderItems,
  useUpdateOrderItem,
  useVoidOrderItem,
  useSendOrderToKitchen,
} from '@/api/orders';

let uuidN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${(uuidN += 1)}` }));

const SLUG = 'sahan';
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({
    // gcTime: Infinity — the default (5 min) schedules a GC setTimeout per
    // cache entry that outlives the test and trips Jest's open-handle check.
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } });
  useConnectivity.setState({ mode: 'offline' });
  useOfflineQueue.setState({ ops: [] });
});
afterEach(() => {
  client.clear();
  jest.restoreAllMocks();
});

const seedOrder = (over: Partial<Order> = {}) =>
  client.setQueryData<Order>(qk.order(SLUG, 'o1'), {
    id: 'o1',
    service_table_id: null,
    service_table_name: null,
    table_label: '',
    status: 'open',
    opened_by_user_id: '',
    opened_at: '',
    notes: '',
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    service_charge_cents: 0,
    total_cents: 0,
    live_subtotal_cents: 0,
    items: [],
    items_pending: 0,
    items_in_progress: 0,
    items_ready: 0,
    items_served: 0,
    items_total: 0,
    paid_cents: 0,
    ...over,
  });

describe('offline order mutations enqueue instead of fetching', () => {
  it('add_items → enqueues an add op, no network call', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { result } = await renderHook(() => useAddOrderItems(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        orderId: 'o1',
        items: [{ id: 'l1', menu_item_id: 'm1', qty: 2 }],
        optimistic: { menu_item_name: 'Latte', unit_price_cents: 100 },
      });
    });
    const ops = getQueuedOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('add_items');
    expect(ops[0].orderId).toBe('o1');
    expect(ops[0].label).toBe('2× Latte');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('update_item → enqueues an update op', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    seedOrder();
    const { result } = await renderHook(() => useUpdateOrderItem(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: 'o1', itemId: 'l1', patch: { qty: 3 } });
    });
    expect(getQueuedOps()[0].kind).toBe('update_item');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('void_item → enqueues a void op', async () => {
    seedOrder();
    const { result } = await renderHook(() => useVoidOrderItem(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: 'o1', itemId: 'l1', reason: 'oops' });
    });
    const ops = getQueuedOps();
    expect(ops[0].kind).toBe('void_item');
    expect(ops[0].payload).toEqual({ itemId: 'l1', reason: 'oops' });
  });

  it('send_kitchen → enqueues a send op and reports the pending count offline', async () => {
    seedOrder({
      items: [
        { id: 'l1', order_id: 'o1', menu_item_id: 'm1', menu_item_name: 'A', qty: 1, unit_price_cents: 0, line_cents: 0, modifiers: null, notes: '', kitchen_status: 'pending', created_at: '' },
        { id: 'l2', order_id: 'o1', menu_item_id: 'm2', menu_item_name: 'B', qty: 1, unit_price_cents: 0, line_cents: 0, modifiers: null, notes: '', kitchen_status: 'pending', created_at: '' },
      ],
    });
    const { result } = await renderHook(() => useSendOrderToKitchen(), { wrapper });
    let res: { sent: number } | undefined;
    await act(async () => {
      res = await result.current.mutateAsync('o1');
    });
    expect(res?.sent).toBe(2);
    expect(getQueuedOps()[0].kind).toBe('send_kitchen');
    // Optimistic flip: pending lines are now in_progress in the cache.
    const cached = client.getQueryData<Order>(qk.order(SLUG, 'o1'));
    expect(cached?.items?.every((i) => i.kitchen_status === 'in_progress')).toBe(true);
  });
});
