import { screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Redirect: () => null,
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import TopSellers from '../top-sellers';

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
  mockFetchByPath({
    '/v1/me': () => ({
      json: {
        user_id: 'u',
        email: 'a@b.c',
        name: 'A',
        active_permissions: ['report:read'],
        memberships: [],
      },
    }),
    '/v1/reports/movers': () => ({
      json: {
        range: '30d',
        from: '',
        to: '',
        prev_from: '',
        prev_to: '',
        total: 2,
        rows: [
          { menu_item_id: 'm1', name: 'Espresso', icon: '', category_name: 'Coffee', qty: 42, revenue_cents: 21000, prev_qty: 0, prev_revenue_cents: 0 },
          { menu_item_id: 'm2', name: 'Momo', icon: '', category_name: 'Food', qty: 30, revenue_cents: 45000, prev_qty: 0, prev_revenue_cents: 0 },
        ],
      },
    }),
  });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('TopSellers', () => {
  it('renders the full movers list from the endpoint', async () => {
    await renderWithProviders(<TopSellers />);
    await waitFor(() => expect(screen.getByText('Espresso')).toBeOnTheScreen());
    expect(screen.getByText('Momo')).toBeOnTheScreen();
    // qty stamps
    expect(screen.getByText('42×')).toBeOnTheScreen();
  });
});
