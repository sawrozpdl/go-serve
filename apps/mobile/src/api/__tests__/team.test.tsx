/**
 * Integration tests for the M9 team + feedback hooks. Team endpoints are JSON;
 * feedback is multipart, so we assert a FormData body directly.
 */
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockFetchByPath } from '@/test-utils';
import { useTenantStore } from '@/stores/tenant';
import { useMembers, useUpdateMemberRoles, useCreateInvite, useRemoveMember } from '@/api/team';
import { useSubmitFeedback } from '@/api/feedback';

const SLUG = 'sahan';
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } }));
afterEach(() => jest.restoreAllMocks());

describe('team', () => {
  it('useMembers unwraps the array', async () => {
    mockFetchByPath({ '/v1/members': () => ({ json: { members: [{ user_id: 'u1', email: 'a@b.c', name: 'A', roles: ['owner'], status: 'active' }] } }) });
    const { result } = await renderHook(() => useMembers(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].roles).toEqual(['owner']);
  });

  it('useUpdateMemberRoles PATCHes the roles', async () => {
    let body: unknown;
    mockFetchByPath({ '/v1/members/u1/roles': (b) => { body = b; return { json: {} }; } });
    const { result } = await renderHook(() => useUpdateMemberRoles(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ userId: 'u1', roles: ['waiter', 'cashier'] }); });
    expect(body).toEqual({ roles: ['waiter', 'cashier'] });
  });

  it('useRemoveMember DELETEs the member', async () => {
    const spy = mockFetchByPath({ '/v1/members/u1': () => ({ json: {} }) });
    const { result } = await renderHook(() => useRemoveMember(), { wrapper });
    await act(async () => { await result.current.mutateAsync('u1'); });
    expect(spy.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('useCreateInvite POSTs email + roles', async () => {
    let body: unknown;
    mockFetchByPath({ '/v1/invites': (b) => { body = b; return { json: { id: 'i1' } }; } });
    const { result } = await renderHook(() => useCreateInvite(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ email: 'x@y.z', roles: ['waiter'] }); });
    expect(body).toEqual({ email: 'x@y.z', roles: ['waiter'] });
  });
});

describe('feedback (multipart)', () => {
  it('POSTs a FormData body with the feedback fields', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ id: 'b1' }),
    } as unknown as Response);

    const { result } = await renderHook(() => useSubmitFeedback(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ kind: 'bug', title: 'Oops', description: 'It broke' }); });

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/v1/bug-reports');
    expect(init?.body).toBeInstanceOf(FormData);
    const fd = init?.body as FormData;
    expect(fd.get('kind')).toBe('bug');
    expect(fd.get('description')).toBe('It broke');
    expect(fd.get('title')).toBe('Oops');
    // No JSON content-type — fetch sets the multipart boundary itself.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });
});
