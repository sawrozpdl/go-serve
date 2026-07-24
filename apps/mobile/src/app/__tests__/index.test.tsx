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
import { setTokens } from '@/auth/tokenStore';
import { storage } from '@/lib/kv';

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
  useAuthStore.setState({ hydrated: true, hasSession: true });
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
