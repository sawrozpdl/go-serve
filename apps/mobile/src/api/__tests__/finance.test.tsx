/**
 * Integration tests for the M8 finance data hooks — exact endpoints, response
 * unwrapping, and mutation payloads, via the shared fetch-by-path mock.
 */
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockFetchByPath } from '@/test-utils';
import { useTenantStore } from '@/stores/tenant';
import { useCurrentShift, useCashDrops, useOpenShift, useCloseShift, useCreateCashDrop } from '@/api/shift';
import { useExpenses, useExpenseCategories, useCreateExpense } from '@/api/expenses';
import { useReportsDashboard } from '@/api/reports';

const SLUG = 'sahan';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } }));
afterEach(() => jest.restoreAllMocks());

describe('shift reads', () => {
  it('useCurrentShift fetches /shifts/current', async () => {
    mockFetchByPath({ '/v1/shifts/current': () => ({ json: { id: 'sh1', live_expected_cash_cents: 5000 } }) });
    const { result } = await renderHook(() => useCurrentShift(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ id: 'sh1' });
  });

  it('useCashDrops unwraps the array', async () => {
    mockFetchByPath({ '/v1/shifts/sh1/cash-drops': () => ({ json: { cash_drops: [{ id: 'd1', direction: 'out', amount_cents: 100 }] } }) });
    const { result } = await renderHook(() => useCashDrops('sh1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe('shift mutations', () => {
  it('useOpenShift POSTs the opening float', async () => {
    let body: unknown;
    mockFetchByPath({ '/v1/shifts/open': (b) => { body = b; return { json: { id: 'sh2' } }; } });
    const { result } = await renderHook(() => useOpenShift(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ opening_float_cents: 3000 }); });
    expect(body).toEqual({ opening_float_cents: 3000 });
  });

  it('useCloseShift POSTs the counted cash to /close', async () => {
    let body: unknown;
    mockFetchByPath({ '/v1/shifts/sh1/close': (b) => { body = b; return { json: { id: 'sh1' } }; } });
    const { result } = await renderHook(() => useCloseShift(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: 'sh1', closing_count_cents: 5200, notes: 'ok' }); });
    expect(body).toEqual({ closing_count_cents: 5200, notes: 'ok' });
  });

  it('useCreateCashDrop POSTs to the shift', async () => {
    let body: unknown;
    mockFetchByPath({ '/v1/shifts/sh1/cash-drops': (b) => { body = b; return { json: { id: 'd2' } }; } });
    const { result } = await renderHook(() => useCreateCashDrop('sh1'), { wrapper });
    await act(async () => { await result.current.mutateAsync({ kind: 'bank_deposit', amount_cents: 1000, reason: 'slip' }); });
    expect(body).toEqual({ kind: 'bank_deposit', amount_cents: 1000, reason: 'slip' });
  });
});

describe('expenses', () => {
  it('useExpenses + useExpenseCategories unwrap their arrays', async () => {
    mockFetchByPath({
      '/v1/expense-categories': () => ({ json: { categories: [{ id: 'c1', name: 'Supplies', is_active: true }] } }),
      '/v1/expenses': () => ({ json: { expenses: [{ id: 'e1', amount_cents: 500, paid_from: 'drawer', paid_at: '2026-07-02' }] } }),
    });
    const ex = await renderHook(() => useExpenses(), { wrapper });
    await waitFor(() => expect(ex.result.current.isSuccess).toBe(true));
    expect(ex.result.current.data).toHaveLength(1);
    const cats = await renderHook(() => useExpenseCategories(), { wrapper });
    await waitFor(() => expect(cats.result.current.isSuccess).toBe(true));
    expect(cats.result.current.data?.[0].name).toBe('Supplies');
  });

  it('useCreateExpense POSTs the input', async () => {
    let body: unknown;
    mockFetchByPath({ '/v1/expenses': (b) => { body = b; return { json: { id: 'e2' } }; } });
    const { result } = await renderHook(() => useCreateExpense(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ amount_cents: 800, paid_from: 'drawer', vendor: 'Dairy', expense_category_id: null, notes: '' });
    });
    expect(body).toMatchObject({ amount_cents: 800, paid_from: 'drawer', vendor: 'Dairy' });
  });
});

describe('reports', () => {
  it('useReportsDashboard hits /reports/dashboard with the range', async () => {
    const spy = mockFetchByPath({ '/v1/reports/dashboard': () => ({ json: { kpis: { sales_cents: 12345 } } }) });
    const { result } = await renderHook(() => useReportsDashboard('7d'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.kpis.sales_cents).toBe(12345);
    expect(String(spy.mock.calls[0][0])).toContain('range=7d');
  });
});
