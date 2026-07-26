/**
 * Credit collection + reversal from the phone.
 *
 * The reversal endpoint is the only correction path for a mis-entered collection
 * (the ledger is append-only by design), so the payload and the cache
 * invalidation matter: reversing money out of an account without refreshing the
 * drawer and the day's figures leaves the operator looking at numbers that are
 * wrong in the direction of "we have more cash than we do".
 */
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockFetchByPath } from '@/test-utils';
import { useTenantStore } from '@/stores/tenant';
import {
  useHouseTab,
  useCreateHouseTabSettlement,
  useReverseHouseTabSettlement,
} from '@/api/houseTabs';

const SLUG = 'sahan';
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } });
});
afterEach(() => jest.restoreAllMocks());

describe('collecting credit', () => {
  it('POSTs the amount and method to the tab', async () => {
    let body: unknown;
    mockFetchByPath({
      '/v1/house-tabs/ht1/settlements': (b) => {
        body = b;
        return { json: { id: 's1', amount_cents: 2500 } };
      },
    });
    const { result } = await renderHook(() => useCreateHouseTabSettlement(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        id: 'ht1',
        amount_cents: 2500,
        payment_method: 'cash',
        notes: 'month end',
      });
    });
    expect(body).toEqual({
      amount_cents: 2500,
      payment_method: 'cash',
      reference_no: undefined,
      notes: 'month end',
    });
  });
});

describe('reversing a collection', () => {
  it('POSTs the reason to the settlement reverse route', async () => {
    let body: unknown;
    const fetchSpy = mockFetchByPath({
      '/v1/house-tabs/ht1/settlements/s1/reverse': (b) => {
        body = b;
        return { json: {} };
      },
    });
    const { result } = await renderHook(() => useReverseHouseTabSettlement(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ht1', settlementId: 's1', reason: 'wrong tab' });
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/v1/house-tabs/ht1/settlements/s1/reverse',
    );
    expect(body).toEqual({ reason: 'wrong tab' });
  });

  it('refreshes the drawer and the day after the money moves back out', async () => {
    mockFetchByPath({
      '/v1/house-tabs/ht1/settlements/s1/reverse': () => ({ json: {} }),
    });
    const spy = jest.spyOn(client, 'invalidateQueries');
    const { result } = await renderHook(() => useReverseHouseTabSettlement(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ht1', settlementId: 's1', reason: 'duplicate' });
    });
    const invalidated = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    // jest's expect takes one argument, so name the expectation in the matcher's
    // subject instead: a miss reports which key was not refreshed.
    const missing = [
      'house-tabs',
      'house-tab',
      'current-shift',
      'reports-dashboard',
      'order-history',
    ].filter((key) => !invalidated.some((k) => k?.includes(key)));
    expect(missing).toEqual([]); // anything listed here would keep showing pre-reversal money
  });

  it('a reversed row is reported by the detail read so the ledger can show it', async () => {
    mockFetchByPath({
      '/v1/house-tabs/ht1': () => ({
        json: {
          house_tab: { id: 'ht1', name: 'Ramesh', charged_cents: 5000, settled_cents: 0, balance_cents: 5000 },
          charges: [],
          settlements: [
            {
              id: 's1',
              amount_cents: 2500,
              payment_method: 'cash',
              reference_no: '',
              notes: '',
              recorded_at: '2026-07-20T04:00:00Z',
              reversed_at: '2026-07-20T05:00:00Z',
              reversal_reason: 'wrong tab',
            },
          ],
        },
      }),
    });
    const { result } = await renderHook(() => useHouseTab('ht1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const settlement = result.current.data!.settlements[0];
    expect(settlement.reversed_at).toBeTruthy();
    expect(settlement.reversal_reason).toBe('wrong tab');
    // The balance already excludes it server-side: settled is 0 while a
    // Rs 25 collection exists on the row.
    expect(result.current.data!.house_tab.balance_cents).toBe(5000);
  });
});
