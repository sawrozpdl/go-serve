import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

const mockReplace = jest.fn();
const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  Redirect: (props: { href: unknown }) => {
    mockRedirect(props.href);
    return null;
  },
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Picker from '../picker';

function meWith(memberships: unknown[]) {
  return {
    user_id: 'u1',
    email: 'a@b.c',
    name: 'A',
    active_permissions: [],
    memberships,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  useTenantStore.getState().clear();
  useAuthStore.setState({ hydrated: true, hasSession: true });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  jest.useRealTimers();
});

describe('Picker', () => {
  it('lists active memberships and selects one', async () => {
    mockFetchByPath({
      '/v1/me': () => ({
        json: meWith([
          { tenant_id: 't1', tenant_slug: 'sahan', tenant_name: 'Sahan Cafe', roles: ['owner'], status: 'active' },
          { tenant_id: 't2', tenant_slug: 'resell', tenant_name: 'Resell', roles: ['waiter'], status: 'active' },
        ]),
      }),
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<Picker />);

    await waitFor(() => expect(screen.getByText('Sahan Cafe')).toBeOnTheScreen());
    await user.press(screen.getByLabelText('workspace-resell'));

    expect(useTenantStore.getState().active?.slug).toBe('resell');
    expect(mockReplace).toHaveBeenCalledWith('/(app)/floor');
  });

  it('auto-selects when there is exactly one workspace', async () => {
    mockFetchByPath({
      '/v1/me': () => ({
        json: meWith([
          { tenant_id: 't1', tenant_slug: 'only', tenant_name: 'Only Cafe', roles: ['owner'], status: 'active' },
        ]),
      }),
    });
    await renderWithProviders(<Picker />);
    await waitFor(() => expect(useTenantStore.getState().active?.slug).toBe('only'));
    expect(mockReplace).toHaveBeenCalledWith('/(app)/floor');
  });

  // This used to be a dead end — a line of text and a Sign out button — which is
  // where a Play reviewer signing in with a fresh Google account got stuck. Both
  // shapes of "no workspace" now hand off to the access page, which can offer the
  // demo and a way to reach us.
  it('sends a pending-only membership to the access page', async () => {
    mockFetchByPath({
      '/v1/me': () => ({
        json: meWith([
          { tenant_id: 't1', tenant_slug: 'pend', tenant_name: 'Pending', roles: [], status: 'pending' },
        ]),
      }),
    });
    await renderWithProviders(<Picker />);

    await waitFor(() =>
      expect(mockRedirect).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/no-access',
          params: expect.objectContaining({ reason: 'membership-pending' }),
        }),
      ),
    );
    expect(screen.queryByText(/don't have access/i)).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('sends an account with no memberships at all to the access page', async () => {
    mockFetchByPath({ '/v1/me': () => ({ json: meWith([]) }) });
    await renderWithProviders(<Picker />);

    await waitFor(() =>
      expect(mockRedirect).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/no-access',
          params: expect.objectContaining({ reason: 'no-workspace' }),
        }),
      ),
    );
  });

  // The old copy told the user to "pull to retry" on a Screen with no
  // RefreshControl — an instruction that did nothing, which is the same shape of
  // problem as a dead button.
  it('offers a retry that actually retries when /me fails', async () => {
    let calls = 0;
    mockFetchByPath({
      '/v1/me': () => {
        calls += 1;
        return calls === 1
          ? { status: 500, json: { message: 'Could not load your workspaces.' } }
          : {
              json: meWith([
                { tenant_id: 't1', tenant_slug: 'sahan', tenant_name: 'Sahan Cafe', roles: ['owner'], status: 'active' },
              ]),
            };
      },
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<Picker />);

    await waitFor(() => expect(screen.getByLabelText('error-state')).toBeOnTheScreen());
    await user.press(screen.getByText('Try again'));

    await waitFor(() => expect(useTenantStore.getState().active?.slug).toBe('sahan'));
  });
});
