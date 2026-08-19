/**
 * The seam itself: in guest mode nothing may reach the network, and with the flag
 * off behaviour must be byte-identical to before.
 */
import { api, request } from '../client';
import { enterDemo, exitDemo } from '../../demo/session';
import { useAuthStore } from '../../stores/auth';
import { useConnectivity } from '../../stores/connectivity';
import { useTenantStore } from '../../stores/tenant';
import { getRefreshToken } from '../../auth/tokenStore';
import { DEMO_SLUG } from '../../demo/constants';
import { mockFetchByPath } from '../../test-utils';
import type { ApiError, Me } from '@cafe-mgmt/api-types';

afterEach(async () => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  await exitDemo();
});

it('answers from the demo world without touching the network', async () => {
  const fetchMock = mockFetchByPath({});
  enterDemo();

  const me = await api.get<Me>('/v1/me');
  expect(me.name).toBe('Guest');
  await api.get('/v1/tables');
  await api.get('/v1/reports/dashboard?range=today');

  // The executable form of "no backend calls".
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sets up a session the router guards accept, with no tokens', () => {
  enterDemo();

  expect(useAuthStore.getState().hasSession).toBe(true);
  expect(useAuthStore.getState().demo).toBe(true);
  expect(useTenantStore.getState().active?.slug).toBe(DEMO_SLUG);
  // No tokens: refreshScheduler stays a no-op, so nothing ever posts /auth/refresh.
  expect(getRefreshToken()).toBeNull();
});

it('forces connectivity online, so money actions are not disabled', () => {
  // A review device with no egress may already have marked us offline, and offline
  // disables every action in SettleSheet and refuses to open a tab.
  useConnectivity.getState().markOffline();
  enterDemo();
  expect(useConnectivity.getState().mode).toBe('online');
});

it('surfaces an out-of-scope endpoint as a legible ApiError, not a logout', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  enterDemo();
  const err = await request('GET', '/v1/shifts/current').catch((e: ApiError) => e);
  spy.mockRestore();

  expect(err).toMatchObject({ status: 501, code: 'demo_unsupported' });
  // A 501 must never be mistaken for a dead session: the guard returns before the
  // refresh-on-401 branch, so the guest is not bounced to login.
  expect(useAuthStore.getState().hasSession).toBe(true);
});

it('goes back to the real network once the demo is exited', async () => {
  const fetchMock = mockFetchByPath({
    '/v1/me': () => ({ json: { user_id: 'u1', email: 'real@cafe.com', name: 'Real', memberships: [] } }),
  });
  enterDemo();
  await api.get<Me>('/v1/me');
  expect(fetchMock).not.toHaveBeenCalled();

  await exitDemo();
  const me = await api.get<Me>('/v1/me');
  expect(me.name).toBe('Real');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
