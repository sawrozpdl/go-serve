/**
 * The settings hub. Nine dashboard tabs stacked into one phone scroll is a
 * screen you hunt through; each row here has to say what is inside so you can
 * choose without opening it.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

// `mock`-prefixed so the factory may close over it — jest forbids any other
// out-of-scope reference inside jest.mock().
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
  Redirect: () => null,
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import SettingsHub from '../settings/index';

function mockSettings(over: Record<string, unknown> = {}) {
  return mockFetchByPath({
    '/v1/tenant': () => ({
      json: {
        id: 't1',
        slug: 'sahan',
        name: 'Sahan Cafe',
        branding: {},
        preferences: {},
        plan: 'pro',
        status: 'active',
        timezone: 'Asia/Kathmandu',
        vat_pct: '13',
        vat_mode: 'exclusive',
        service_charge_pct: '10',
        contact_phone: '',
        created_at: '2026-01-01T00:00:00Z',
        ...over,
      },
    }),
    '/v1/me': () => ({
      json: {
        user_id: 'u',
        email: 'a@b.c',
        name: 'A',
        active_permissions: ['tenant:read', 'tenant:update'],
        memberships: [],
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

describe('the hub rows', () => {
  it('says a workspace has tuned nothing, without opening the group', async () => {
    mockSettings();
    await renderWithProviders(<SettingsHub />);
    await waitFor(() => expect(screen.getByText('All at their defaults')).toBeOnTheScreen());
  });

  it('counts only preferences that depart from their default', async () => {
    // stackItems: true IS the default — it must not count as a change.
    mockSettings({
      preferences: { stackItems: true, autoCleanTables: true, dailyBriefEmail: false },
    });
    await renderWithProviders(<SettingsHub />);
    await waitFor(() => expect(screen.getByText('2 changes from the defaults')).toBeOnTheScreen());
  });

  it('summarises the tax basis on the row', async () => {
    mockSettings();
    await renderWithProviders(<SettingsHub />);
    await waitFor(() => expect(screen.getByText('VAT 13%')).toBeOnTheScreen());
  });

  it('says so plainly when no VAT is charged', async () => {
    mockSettings({ vat_mode: 'none' });
    await renderWithProviders(<SettingsHub />);
    await waitFor(() => expect(screen.getByText('No VAT charged')).toBeOnTheScreen());
  });

  it('navigates into a group', async () => {
    mockSettings();
    await renderWithProviders(<SettingsHub />);
    await waitFor(() => expect(screen.getByText('Identity')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Identity'));
    expect(mockPush).toHaveBeenCalledWith('/more/settings/workspace');
  });

  it('keeps the device-local display control on the hub itself', async () => {
    // One segmented field does not earn a route.
    mockSettings();
    await renderWithProviders(<SettingsHub />);
    await waitFor(() => expect(screen.getByText('Floor-menu size')).toBeOnTheScreen());
  });
});
