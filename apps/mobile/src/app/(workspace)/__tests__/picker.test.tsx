import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));

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

  it('shows an empty-state when there are no active memberships', async () => {
    mockFetchByPath({
      '/v1/me': () => ({
        json: meWith([
          { tenant_id: 't1', tenant_slug: 'pend', tenant_name: 'Pending', roles: [], status: 'pending' },
        ]),
      }),
    });
    await renderWithProviders(<Picker />);
    await waitFor(() => expect(screen.getByText(/don't have access/i)).toBeOnTheScreen());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
