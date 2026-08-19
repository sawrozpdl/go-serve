/**
 * Entry-resolver wiring. The important bit beyond "which href" is `withAnchor`:
 * managers land inside the More stack (/more/dashboard), and without the anchor
 * that stack has no more/index beneath it — back would leave the tab entirely
 * and the More menu became unreachable. Paired with `unstable_settings.anchor`
 * in (app)/more/_layout.tsx.
 */
import * as SecureStore from 'expo-secure-store';
import { waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { clearTokens, getRefreshToken, setTokens } from '@/auth/tokenStore';
import { storage } from '@/lib/kv';
import { enterDemo } from '@/demo/session';

const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  Redirect: (props: Record<string, unknown>) => {
    mockRedirect(props);
    return null;
  },
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Index from '../index';
// eslint-disable-next-line import/first
import { unstable_settings as moreStackSettings } from '../(app)/more/_layout';

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

async function renderWith(permissions: string[]) {
  reset();
  storage.clearAll();
  await setTokens('a', 'r');
  useAuthStore.setState({ hydrated: true, hasSession: true, demo: false });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
  mockFetchByPath({
    '/v1/me': () => ({
      json: {
        user_id: 'u',
        email: 'me@cafe.com',
        name: 'Boss',
        active_permissions: permissions,
        memberships: [],
      },
    }),
  });
  await renderWithProviders(<Index />);
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('entry resolver', () => {
  it('lands a manager on the dashboard with the More menu anchored beneath it', async () => {
    await renderWith(['report:read', 'order:create']);
    await waitFor(() =>
      expect(mockRedirect).toHaveBeenCalledWith(
        expect.objectContaining({ href: '/(app)/more/dashboard', withAnchor: true }),
      ),
    );
  });

  it('lands staff on their capability tab', async () => {
    await renderWith(['order:create']);
    await waitFor(() =>
      expect(mockRedirect).toHaveBeenCalledWith(
        expect.objectContaining({ href: '/(app)/floor' }),
      ),
    );
  });

  it('anchors the More stack at its menu', () => {
    expect(moreStackSettings.anchor).toBe('index');
  });
});

/**
 * The executable form of "guest mode makes no backend calls": a guest resolves all
 * the way into the app with an empty token store and fetch never called once.
 */
it('resolves a guest into the app with no tokens and no network', async () => {
  reset();
  storage.clearAll();
  await clearTokens();
  const fetchMock = mockFetchByPath({});
  enterDemo();

  const { unmount } = await renderWithProviders(<Index />);

  await waitFor(() => expect(mockRedirect).toHaveBeenCalled());
  // A guest holds report:read, so they land on the owner's dashboard — with the
  // More stack anchored beneath it, same as a real manager.
  const last = mockRedirect.mock.calls[mockRedirect.mock.calls.length - 1][0];
  expect(last.href).toBe('/(app)/more/dashboard');
  expect(last.withAnchor).toBe(true);

  expect(fetchMock).not.toHaveBeenCalled();
  expect(getRefreshToken()).toBeNull();

  // Unmount BEFORE clearing the flag: signOut() writes to a zustand store the
  // mounted tree subscribes to, and a store update after teardown leaves jest
  // holding an open handle (and warns about an update outside act).
  unmount();
  useAuthStore.setState({ hydrated: true, hasSession: false, demo: false });
  useTenantStore.getState().clear();
  fetchMock.mockRestore();
});
