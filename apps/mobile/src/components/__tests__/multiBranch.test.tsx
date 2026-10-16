import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, navigate: jest.fn(), push: jest.fn() }),
}));

// eslint-disable-next-line import/first -- import after jest.mock()
import { CombinedCredit } from '../houseTabs/CombinedCredit';
// eslint-disable-next-line import/first
import { SendStockSheet } from '../inventory/SendStockSheet';
// eslint-disable-next-line import/first
import { syncChanges } from '../menu/SyncMenuSheet';

const can = { report_read: true, finance_read: true, menu_update: true, inventory_adjust: true };
const branches = [
  { tenant_id: 't1', slug: 'sahan', name: 'Sahan Cafe', timezone: 'Asia/Kathmandu', roles: ['owner'], is_active: true, can },
  { tenant_id: 't2', slug: 'sahan-thamel', name: 'Sahan Cafe Thamel', timezone: 'Asia/Kathmandu', roles: ['owner'], is_active: false, can },
];
const me = {
  user_id: 'u1',
  email: 'a@b.c',
  name: 'A',
  active_permissions: ['*:*'],
  memberships: [],
  business: { id: 'b1', name: 'Sahan Cafe' },
  branches: branches.map(({ can: _c, ...b }) => b),
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  jest.useRealTimers();
});

describe('CombinedCredit', () => {
  it('shows one customer across branches and opens the other branch’s part there', async () => {
    mockFetchByPath({
      '/v1/me': () => ({ json: me }),
      '/v1/business/branches': () => ({ json: { business: me.business, branches } }),
      '/v1/business/credit': () => ({
        json: {
          business: me.business,
          branches: [],
          complete: true,
          total_owed_cents: 150000,
          customers: [
            {
              key: '9812345678',
              name: 'Ram',
              phone: '9812345678',
              linked: true,
              balance_cents: 150000,
              accounts: [
                { tenant_id: 't1', branch_slug: 'sahan', branch_name: 'Sahan Cafe', house_tab_id: 'h1', name: 'Ram', is_active: true, balance_cents: 120000 },
                { tenant_id: 't2', branch_slug: 'sahan-thamel', branch_name: 'Sahan Cafe Thamel', house_tab_id: 'h2', name: 'Ram', is_active: true, balance_cents: 30000 },
              ],
            },
          ],
        },
      }),
    });
    const openHere = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<CombinedCredit onOpenHere={openHere} />);
    await waitFor(() => expect(screen.getByTestId('credit-customer-9812345678')).toBeOnTheScreen());

    // This branch's part opens in place…
    await user.press(screen.getByTestId('credit-account-h1'));
    expect(openHere).toHaveBeenCalledWith('h1');
    expect(useTenantStore.getState().active?.slug).toBe('sahan');

    // …the other branch's part switches branch first, then opens it there.
    await user.press(screen.getByTestId('credit-account-h2'));
    expect(useTenantStore.getState().active?.slug).toBe('sahan-thamel');
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/more/house-tabs', params: { open: 'h2' } });
  });
});

describe('SendStockSheet', () => {
  const milk = {
    id: 'i1',
    name: 'Milk',
    sale_unit: 'ml',
    qty_on_hand_units: '500.000',
  } as unknown as Parameters<typeof SendStockSheet>[0]['item'];

  it('refuses more than is on hand, then sends a valid quantity to the picked branch', async () => {
    let posted: unknown;
    mockFetchByPath({
      '/v1/me': () => ({ json: me }),
      '/v1/business/branches': () => ({ json: { business: me.business, branches } }),
      '/v1/business/stock-transfers': (body) => {
        posted = body;
        return {
          status: 201,
          json: {
            id: 'x1',
            from: { slug: 'sahan', name: 'Sahan Cafe' },
            to: { slug: 'sahan-thamel', name: 'Sahan Cafe Thamel' },
            lines: [{ item: 'Milk', created_at_destination: true }],
          },
        };
      },
    });
    const onClose = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<SendStockSheet item={milk} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('send-to-sahan-thamel')).toBeOnTheScreen());

    await user.type(screen.getByLabelText('Quantity to send'), '900');
    expect(screen.getByText('Only 500 ml on hand')).toBeOnTheScreen();
    expect(posted).toBeUndefined();

    await user.clear(screen.getByLabelText('Quantity to send'));
    await user.type(screen.getByLabelText('Quantity to send'), '200');
    await user.press(screen.getByText('Send to Thamel'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posted).toEqual({ to: 'sahan-thamel', lines: [{ inventory_item_id: 'i1', qty_units: '200' }] });
  });
});

describe('syncChanges', () => {
  it('counts item and extras changes only for branches that answered', () => {
    const t = (status: string, items: number, links: number) => ({
      tenant_id: '',
      slug: status,
      name: '',
      status,
      result: { categories: { created: 0, updated: 0, skipped: 0 }, items: { created: items, updated: 0, skipped: 0 } },
      extras: { photos: 0, stations: 0, add_on_groups_new: 0, add_on_groups_updated: 0, add_on_options_new: 0, add_on_options_updated: 0, add_on_links: links },
    });
    const res = { dry_run: true, source: { tenant_id: '', slug: '', name: '' }, not_synced: [], targets: [t('ok', 2, 3), t('forbidden', 9, 9)] };
    expect(syncChanges(res as never)).toBe(5);
    expect(syncChanges(null)).toBe(0);
  });
});
