/**
 * History: fixing a payment recorded with the wrong method after the tab was
 * already settled — the "they settled it online but it was paid in cash" case.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

// No expo-router mock needed — History is a tab screen with no navigation calls.
import History from '../history';

const ORDER = {
  id: 'o1',
  service_table_name: 'Table 4',
  opened_at: '2026-07-29T08:00:00Z',
  closed_at: '2026-07-29T09:22:00Z',
  notes: '',
  subtotal_cents: 35000,
  discount_cents: 0,
  tax_cents: 0,
  service_charge_cents: 0,
  total_cents: 35000,
  item_count: 1,
  items: [{ id: 'i1', menu_item_name: 'Momo', qty: '1', line_cents: 35000 }],
  payments: [
    // Recorded as online ('other' is how the API persists the online channel).
    { id: 'p1', method: 'other', amount_cents: 35000, reference_no: '', reclassifiable: true },
  ],
};

function mockHistory(perms: string[]) {
  return mockFetchByPath({
    '/v1/me': () => ({
      json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] },
    }),
    '/v1/orders/history': () => ({ json: { orders: [ORDER], credit_collections: [] } }),
    '/v1/orders/o1/payments/p1/reclassify': (body) => ({ json: { id: 'p1', ...(body as object) } }),
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

describe('History payment reclassify', () => {
  it('swaps a settled payment from online to cash', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockHistory(['order:read', 'payment:reclassify']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    // The swap lives in the expanded body, not on the collapsed chips.
    expect(screen.queryByLabelText('reclassify-p1')).toBeNull();
    await user.press(screen.getByText('Table 4'));
    await user.press(screen.getByLabelText('reclassify-p1'));

    expect(screen.getByText('Change payment method')).toBeOnTheScreen();
    await user.press(screen.getByText('Switch to Cash'));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes('/payments/p1/reclassify'),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ method: 'cash' });
    });
  });

  it('offers no swap without payment:reclassify', async () => {
    const user = userEvent.setup();
    mockHistory(['order:read']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await user.press(screen.getByText('Table 4'));
    expect(screen.queryByLabelText('reclassify-p1')).toBeNull();
  });

  it('offers no swap once the shift has closed', async () => {
    const user = userEvent.setup();
    mockFetchByPath({
      '/v1/me': () => ({
        json: {
          user_id: 'u',
          email: 'a@b.c',
          name: 'A',
          active_permissions: ['order:read', 'payment:reclassify'],
          memberships: [],
        },
      }),
      '/v1/orders/history': () => ({
        json: {
          // The server's own gate — reconciliation is final after a close.
          orders: [{ ...ORDER, payments: [{ ...ORDER.payments[0], reclassifiable: false }] }],
          credit_collections: [],
        },
      }),
    });
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await user.press(screen.getByText('Table 4'));
    expect(screen.queryByLabelText('reclassify-p1')).toBeNull();
  });
});
