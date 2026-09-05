/**
 * Expense hooks — and above all, the two server rules the mobile edit path has
 * to respect, because breaking either loses data silently.
 *
 *  1. `allocations` is a pointer server-side: omitting the key keeps the
 *     existing cost-centre split, sending it replaces it. Mobile has no
 *     allocation editor, so it must never send the key — otherwise a phone edit
 *     wipes a split that was set on the dashboard.
 *  2. The payment source is immutable; sending it returns 400 immutable_field.
 */
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTenantStore } from '@/stores/tenant';
import {
  useExpenses,
  useExpense,
  useUpdateExpense,
  useDeleteExpense,
  useCreateExpenseCategory,
  useDeleteExpenseCategory,
} from '@/api/expenses';

const SLUG = 'sahan';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Records method + url + parsed body for every call. */
function spyRoutes() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return {
      status: 200,
      ok: true,
      statusText: '',
      json: async () => ({ expenses: [], id: 'e1' }),
    } as unknown as Response;
  });
  return calls;
}

beforeEach(() => {
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan Cafe' } });
});
afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('useUpdateExpense', () => {
  it('NEVER sends allocations — a phone edit must not wipe a web-set split', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useUpdateExpense(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: 'e1',
        patch: { vendor: 'Himalayan Beans', amount_cents: 4500, notes: 'weekly' },
      });
    });

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain('/v1/expenses/e1');
    expect(patch?.body).toEqual({ vendor: 'Himalayan Beans', amount_cents: 4500, notes: 'weekly' });
    // The key must be ABSENT, not null and not []: both of those replace.
    expect(Object.keys(patch?.body as object)).not.toContain('allocations');
  });

  it('sends only the fields given, so untouched ones keep their values', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useUpdateExpense(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'e1', patch: { notes: 'just the note' } });
    });

    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ notes: 'just the note' });
  });
});

describe('useExpenses', () => {
  it('passes filters as query params and keys the cache by them', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(
      () => useExpenses({ from: '2026-09-01', to: '2026-09-05', q: 'beans', paid_from: 'drawer' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = calls.find((c) => c.url.includes('/v1/expenses'))?.url ?? '';
    expect(url).toContain('from=2026-09-01');
    expect(url).toContain('to=2026-09-05');
    expect(url).toContain('q=beans');
    expect(url).toContain('paid_from=drawer');
  });

  it('omits empty filters rather than sending blank params', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useExpenses({ q: '', from: undefined }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.find((c) => c.url.includes('/v1/expenses'))?.url).not.toContain('?');
  });
});

describe('useExpense', () => {
  it('reads one expense — the only place allocations come from', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useExpense('e1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.some((c) => c.url.includes('/v1/expenses/e1'))).toBe(true);
  });

  it('is disabled without an id', async () => {
    const calls = spyRoutes();
    await renderHook(() => useExpense(undefined), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });
});

describe('deletes', () => {
  it('DELETEs an expense', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useDeleteExpense(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('e1');
    });
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('/v1/expenses/e1');
  });

  it('DELETEs a category', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useDeleteExpenseCategory(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('c1');
    });
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain('/v1/expense-categories/c1');
  });
});

describe('useCreateExpenseCategory', () => {
  it('POSTs the new category', async () => {
    const calls = spyRoutes();
    const { result } = await renderHook(() => useCreateExpenseCategory(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ name: 'Gas', icon: 'Flame' });
    });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/v1/expense-categories');
    expect(post?.body).toEqual({ name: 'Gas', icon: 'Flame' });
  });
});
