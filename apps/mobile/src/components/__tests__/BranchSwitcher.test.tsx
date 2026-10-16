import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useBranchScope } from '@/stores/branchScope';

const mockReplace = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, navigate: mockNavigate }),
}));

// eslint-disable-next-line import/first -- import after jest.mock()
import { BranchSwitcher } from '../BranchSwitcher';

const sahan = { tenant_id: 't1', slug: 'sahan', name: 'Sahan Cafe', timezone: 'Asia/Kathmandu', roles: ['owner'] };
const thamel = { tenant_id: 't2', slug: 'sahan-thamel', name: 'Sahan Cafe Thamel', timezone: 'Asia/Kathmandu', roles: ['owner'] };
const can = { report_read: true, finance_read: true, menu_update: true };

function me(extra: Record<string, unknown> = {}) {
  return {
    user_id: 'u1',
    email: 'a@b.c',
    name: 'A',
    active_permissions: ['*:*'],
    memberships: [
      { tenant_id: 't1', tenant_slug: 'sahan', tenant_name: 'Sahan Cafe', roles: ['owner'], status: 'active' },
      { tenant_id: 't2', tenant_slug: 'sahan-thamel', tenant_name: 'Sahan Cafe Thamel', roles: ['owner'], status: 'active' },
    ],
    ...extra,
  };
}

const withBusiness = {
  business: { id: 'b1', name: 'Sahan Cafe' },
  branches: [
    { ...sahan, is_active: true },
    { ...thamel, is_active: false },
  ],
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
  useBranchScope.getState().setAll(false);
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  jest.useRealTimers();
});

describe('BranchSwitcher', () => {
  it('renders nothing for a single-workspace user', async () => {
    mockFetchByPath({
      '/v1/me': () => ({ json: { ...me(), memberships: [me().memberships[0]] } }),
    });
    await renderWithProviders(<BranchSwitcher />);
    // Positive control: /me has resolved (the store-backed tenant is set) …
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // … and still no switcher.
    expect(screen.queryByTestId('branch-switcher')).toBeNull();
  });

  it('shows the branch by its short name and switches to another branch', async () => {
    mockFetchByPath({
      '/v1/me': () => ({ json: me(withBusiness) }),
      '/v1/business/branches': () => ({
        json: { business: withBusiness.business, branches: withBusiness.branches.map((b) => ({ ...b, can })) },
      }),
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<BranchSwitcher />);
    await waitFor(() => expect(screen.getByTestId('branch-switcher')).toBeOnTheScreen());

    await user.press(screen.getByTestId('branch-switcher'));
    await waitFor(() => expect(screen.getByTestId('branch-sahan-thamel')).toBeOnTheScreen());
    expect(screen.getByText('Thamel')).toBeOnTheScreen(); // business name stripped

    await user.press(screen.getByTestId('branch-sahan-thamel'));
    expect(useTenantStore.getState().active?.slug).toBe('sahan-thamel');
    expect(useBranchScope.getState().all).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('offers All branches only when reports are readable in two branches', async () => {
    mockFetchByPath({
      '/v1/me': () => ({ json: me(withBusiness) }),
      '/v1/business/branches': () => ({
        json: {
          business: withBusiness.business,
          branches: [
            { ...sahan, is_active: true, can },
            { ...thamel, is_active: false, can: { ...can, report_read: false } },
          ],
        },
      }),
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<BranchSwitcher />);
    await waitFor(() => expect(screen.getByTestId('branch-switcher')).toBeOnTheScreen());
    await user.press(screen.getByTestId('branch-switcher'));
    await waitFor(() => expect(screen.getByTestId('branch-sahan-thamel')).toBeOnTheScreen());
    expect(screen.queryByTestId('branch-all')).toBeNull();
  });

  it('turns All branches on and goes to the dashboard', async () => {
    mockFetchByPath({
      '/v1/me': () => ({ json: me(withBusiness) }),
      '/v1/business/branches': () => ({
        json: { business: withBusiness.business, branches: withBusiness.branches.map((b) => ({ ...b, can })) },
      }),
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<BranchSwitcher />);
    await waitFor(() => expect(screen.getByTestId('branch-switcher')).toBeOnTheScreen());
    await user.press(screen.getByTestId('branch-switcher'));
    await waitFor(() => expect(screen.getByTestId('branch-all')).toBeOnTheScreen());

    await user.press(screen.getByTestId('branch-all'));
    expect(useBranchScope.getState().all).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
    // The working branch doesn't change — only the dashboard's lens does.
    expect(useTenantStore.getState().active?.slug).toBe('sahan');
  });
});
