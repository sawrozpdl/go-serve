/**
 * Integration tests for the settlement + house-tab data hooks. Uses the shared
 * fetch-by-path mock so we assert the exact endpoints, bodies, and query-key
 * invalidations the settle flow depends on.
 */
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockFetchByPath } from '@/test-utils';
import { useTenantStore } from '@/stores/tenant';
import {
  useOrderPayments,
  useRecordPayment,
  useDeletePayment,
  useReclassifyPayment,
  useOrderAdjustments,
  useApplyAdjustment,
  useRemoveAdjustment,
  useCloseOrder,
} from '@/api/settle';
import { useHouseTabs } from '@/api/houseTabs';

const SLUG = 'sahan';
const ORDER = 'ord-1';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan Cafe' } });
});
afterEach(() => jest.restoreAllMocks());

describe('useOrderPayments', () => {
  it('fetches the payments list for an order', async () => {
    mockFetchByPath({
      [`/v1/orders/${ORDER}/payments`]: () => ({
        json: { payments: [{ id: 'p1', method: 'cash', amount_cents: 500 }] },
      }),
    });
    const { result } = await renderHook(() => useOrderPayments(ORDER), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'p1', method: 'cash', amount_cents: 500 }]);
  });

  it('is disabled without an orderId', async () => {
    const { result } = await renderHook(() => useOrderPayments(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useRecordPayment', () => {
  it('POSTs the payment body without the orderId field', async () => {
    let captured: unknown;
    mockFetchByPath({
      [`/v1/orders/${ORDER}/payments`]: (body) => {
        captured = body;
        return { json: { id: 'p2', method: 'cash', amount_cents: 800 } };
      },
    });
    const { result } = await renderHook(() => useRecordPayment(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: ORDER, method: 'cash', amount_cents: 800 });
    });
    expect(captured).toEqual({ method: 'cash', amount_cents: 800 });
  });

  it('passes reference + house_tab_id through for a house-tab payment', async () => {
    let captured: unknown;
    mockFetchByPath({
      [`/v1/orders/${ORDER}/payments`]: (body) => {
        captured = body;
        return { json: { id: 'p3', method: 'house_tab', amount_cents: 1200 } };
      },
    });
    const { result } = await renderHook(() => useRecordPayment(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        orderId: ORDER,
        method: 'house_tab',
        amount_cents: 1200,
        house_tab_id: 'ht-9',
      });
    });
    expect(captured).toEqual({ method: 'house_tab', amount_cents: 1200, house_tab_id: 'ht-9' });
  });
});

describe('useDeletePayment', () => {
  it('DELETEs the payment', async () => {
    const spy = mockFetchByPath({
      [`/v1/orders/${ORDER}/payments/p1`]: () => ({ json: {} }),
    });
    const { result } = await renderHook(() => useDeletePayment(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: ORDER, paymentId: 'p1' });
    });
    expect(spy).toHaveBeenCalled();
    const [, init] = spy.mock.calls[0];
    expect(init?.method).toBe('DELETE');
  });
});

describe('useReclassifyPayment', () => {
  it('POSTs the new method to the reclassify endpoint', async () => {
    let captured: unknown;
    mockFetchByPath({
      [`/v1/orders/${ORDER}/payments/p1/reclassify`]: (body) => {
        captured = body;
        return { json: { id: 'p1', method: 'online' } };
      },
    });
    const { result } = await renderHook(() => useReclassifyPayment(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ orderId: ORDER, paymentId: 'p1', method: 'online' });
    });
    expect(captured).toEqual({ method: 'online' });
  });
});

describe('adjustments', () => {
  it('fetches, applies, and removes adjustments', async () => {
    let applied: unknown;
    const spy = mockFetchByPath({
      [`/v1/orders/${ORDER}/adjustments/adj-1`]: () => ({ json: {} }),
      [`/v1/orders/${ORDER}/adjustments`]: (body) => {
        applied = body;
        return { json: { adjustments: [{ id: 'adj-1', type: 'discount', amount_cents: 300 }] } };
      },
    });

    const list = await renderHook(() => useOrderAdjustments(ORDER), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(list.result.current.data).toEqual([{ id: 'adj-1', type: 'discount', amount_cents: 300 }]);

    const apply = await renderHook(() => useApplyAdjustment(), { wrapper });
    await act(async () => {
      await apply.result.current.mutateAsync({
        orderId: ORDER,
        type: 'discount',
        amount_cents: 300,
        reason: 'Regular',
      });
    });
    expect(applied).toEqual({ type: 'discount', amount_cents: 300, reason: 'Regular' });

    const remove = await renderHook(() => useRemoveAdjustment(), { wrapper });
    await act(async () => {
      await remove.result.current.mutateAsync({ orderId: ORDER, adjId: 'adj-1' });
    });
    const del = spy.mock.calls.find(([u]) => String(u).endsWith('/adjustments/adj-1'));
    expect(del?.[1]?.method).toBe('DELETE');
  });
});

describe('useCloseOrder', () => {
  it('POSTs an empty body to close and returns the final quote', async () => {
    let captured: unknown;
    mockFetchByPath({
      [`/v1/orders/${ORDER}/close`]: (body) => {
        captured = body;
        return { json: { total_cents: 500, balance_cents: 0 } };
      },
    });
    const { result } = await renderHook(() => useCloseOrder(), { wrapper });
    let quote: unknown;
    await act(async () => {
      quote = await result.current.mutateAsync(ORDER);
    });
    expect(captured).toEqual({});
    expect(quote).toEqual({ total_cents: 500, balance_cents: 0 });
  });
});

describe('useHouseTabs', () => {
  it('unwraps the house_tabs array', async () => {
    mockFetchByPath({
      '/v1/house-tabs': () => ({ json: { house_tabs: [{ id: 'ht-9', name: 'Alice' }] } }),
    });
    const { result } = await renderHook(() => useHouseTabs(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'ht-9', name: 'Alice' }]);
  });
});
