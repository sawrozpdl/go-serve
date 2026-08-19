/**
 * Guest mode must start no socket, no NetInfo listener, and no replay sweep.
 *
 * The connectivity watcher is the load-bearing one: a review device with no
 * working egress reports isInternetReachable false, which flips the app offline —
 * and offline disables every money action in SettleSheet and refuses to open a tab
 * in useOrderController. The demo would look broken for exactly the usual reason.
 *
 * Every case here is paired with a positive control for the same hook OUTSIDE demo
 * mode. Without that, an assertion of the form "was not called" passes just as
 * happily when the effect never ran at all — and in this setup effects only flush
 * on an AWAITED render, which is a trap worth spelling out.
 */
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { useRealtime } from '../../realtime/useRealtime';
import { useConnectivityWatcher } from '../../realtime/useConnectivityWatcher';
import { useOfflineReplay } from '../../offline/useOfflineReplay';
import { useConnectivity } from '../../stores/connectivity';
import { useTenantStore } from '../../stores/tenant';
import { enterDemo, exitDemo } from '../session';
import { mockFetchByPath } from '../../test-utils';

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
}));

const netInfoSpy = NetInfo.addEventListener as jest.Mock;

function Harness({ hook }: { hook: () => void }) {
  hook();
  return <Text>harness</Text>;
}

function mount(hook: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<Harness hook={hook} />, { wrapper: wrap });
}

let fetchMock: ReturnType<typeof mockFetchByPath>;
let sockets: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock = mockFetchByPath({ '/v1/ws-ticket': () => ({ json: { ticket: 't' } }) });
  // Enough of a socket for useRealtime to hold and then close on unmount — a bare
  // jest.fn() constructor yields an instance with no close(), which blows up in the
  // cleanup effect rather than in the assertion.
  sockets = jest.fn(function FakeSocket(this: Record<string, unknown>) {
    this.close = jest.fn();
    this.send = jest.fn();
    this.readyState = 1;
  });
  // @ts-expect-error -- stand in for the Hermes global
  globalThis.WebSocket = sockets;
});

afterEach(async () => {
  await exitDemo();
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('realtime', () => {
  it('opens no socket and fetches no ticket in demo mode', async () => {
    enterDemo();
    await mount(useRealtime);
    await waitFor(() => expect(useTenantStore.getState().active).not.toBeNull());

    expect(sockets).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('positive control: a real session does fetch a ticket', async () => {
    await exitDemo();
    useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
    await mount(useRealtime);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/ws-ticket');
  });
});

describe('connectivity', () => {
  it('registers no NetInfo listener in demo mode, so it cannot be flipped offline', async () => {
    enterDemo();
    await mount(useConnectivityWatcher);
    await waitFor(() => expect(useConnectivity.getState().mode).toBe('online'));

    expect(netInfoSpy).not.toHaveBeenCalled();
  });

  it('positive control: a real session subscribes to NetInfo', async () => {
    await exitDemo();
    await mount(useConnectivityWatcher);
    await waitFor(() => expect(netInfoSpy).toHaveBeenCalled());
  });
});

describe('offline replay', () => {
  it('does not drain the queue into the demo world', async () => {
    enterDemo();
    const { unmount } = await mount(useOfflineReplay);
    await waitFor(() => expect(useConnectivity.getState().mode).toBe('online'));

    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });
});
