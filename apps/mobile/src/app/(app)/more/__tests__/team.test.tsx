/**
 * Team screen guards, brought level with web's TeamPage.
 *
 * A workspace must always keep one active owner, and nobody may remove
 * themselves. Both used to be left entirely to the API to refuse, so the phone
 * offered actions that could only ever fail.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Redirect: () => null,
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Team from '../team';

const ME = 'u-me';

const member = (over: Record<string, unknown> = {}) => ({
  user_id: 'u-other',
  email: 'chef@cafe.com',
  name: 'Chef',
  status: 'active',
  roles: ['manager'],
  ...over,
});

function mockTeam(members: unknown[], perms: string[] = ['member:read', 'member:update_role', 'member:delete']) {
  // `/v1/members` MUST be registered before `/v1/me` — the fetch mock matches
  // keys by substring and '/v1/members'.includes('/v1/me') is true.
  return mockFetchByPath({
    '/v1/members': () => ({ json: { members } }),
    '/v1/me': () => ({
      json: {
        user_id: ME,
        email: 'owner@cafe.com',
        name: 'Owner',
        active_permissions: perms,
        memberships: [],
      },
    }),
    '/v1/invites': () => ({ json: { invites: [] } }),
    '/v1/roles': () => ({
      json: {
        roles: [
          { id: 'r1', key: 'owner', name: 'Owner', description: '', is_system: true, permissions: [] },
          { id: 'r2', key: 'manager', name: 'Manager', description: '', is_system: true, permissions: [] },
        ],
      },
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('Team', () => {
  it('marks which member you are, so you cannot mistake yourself for someone else', async () => {
    mockTeam([member({ user_id: ME, email: 'owner@cafe.com', name: 'Owner', roles: ['owner'] }), member()]);
    await renderWithProviders(<Team />);
    await waitFor(() => expect(screen.getByText('Chef')).toBeOnTheScreen());
    expect(screen.getByText('  (you)')).toBeOnTheScreen();
  });

  it('refuses to remove you from your own workspace', async () => {
    mockTeam([
      member({ user_id: ME, email: 'owner@cafe.com', name: 'Owner', roles: ['owner'] }),
      // A second owner, so the block below is about self-removal and not the
      // last-owner rule.
      member({ user_id: 'u-two', email: 'two@cafe.com', name: 'Two', roles: ['owner'] }),
    ]);
    await renderWithProviders(<Team />);
    await waitFor(() => expect(screen.getByText('Two')).toBeOnTheScreen());

    await userEvent.press(screen.getByText(/^Owner/));
    await waitFor(() => expect(screen.getByText('Roles')).toBeOnTheScreen());
    expect(screen.queryByText('Remove from workspace')).toBeNull();
    expect(screen.getByText('You cannot remove yourself.')).toBeOnTheScreen();
  });

  it('locks the last active owner: neither removable nor demotable', async () => {
    mockTeam([
      member({ user_id: 'u-solo', email: 'solo@cafe.com', name: 'Solo', roles: ['owner'] }),
      member(),
    ]);
    await renderWithProviders(<Team />);
    await waitFor(() => expect(screen.getByText('Solo')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Solo'));
    await waitFor(() => expect(screen.getByText('Roles')).toBeOnTheScreen());

    expect(screen.queryByText('Remove from workspace')).toBeNull();
    expect(screen.getByText('Last owner — promote someone else first.')).toBeOnTheScreen();
    // The owner chip itself is disabled, so the constraint is visible before
    // the member ever taps Save.
    expect(screen.getByText('Owner')).toBeDisabled();
  });

  it('still offers removal for an ordinary member', async () => {
    mockTeam([
      member({ user_id: 'u-solo', email: 'solo@cafe.com', name: 'Solo', roles: ['owner'] }),
      member(),
    ]);
    await renderWithProviders(<Team />);
    await waitFor(() => expect(screen.getByText('Chef')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Chef'));
    await waitFor(() => expect(screen.getByText('Roles')).toBeOnTheScreen());
    expect(screen.getByText('Remove from workspace')).toBeOnTheScreen();
  });

  it('hides the invite revoke action without invite:delete', async () => {
    mockFetchByPath({
      '/v1/members': () => ({ json: { members: [member()] } }),
      '/v1/me': () => ({
        json: {
          user_id: ME,
          email: 'owner@cafe.com',
          name: 'Owner',
          active_permissions: ['member:read', 'invite:read'],
          memberships: [],
        },
      }),
      '/v1/invites': () => ({
        json: { invites: [{ id: 'i1', email: 'new@cafe.com', roles: ['manager'], created_at: '2026-09-01T00:00:00Z' }] },
      }),
      '/v1/roles': () => ({ json: { roles: [] } }),
    });
    await renderWithProviders(<Team />);
    await waitFor(() => expect(screen.getByText('new@cafe.com')).toBeOnTheScreen());
    expect(screen.queryByLabelText('revoke-invite')).toBeNull();
  });
});
