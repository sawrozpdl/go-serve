/**
 * Inventory: telling "order more" apart from "the book is wrong", and the two
 * surfaces that were only ever on the dashboard — the stock ledger and pack
 * rules.
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
import InventoryManager from '../inventory';

const OK = {
  id: 'i-ok',
  name: 'Cola',
  sku: 'CO-500',
  kind: 'retail',
  sale_unit: 'bottle',
  qty_on_hand_units: '50.000',
  par_low_units: '10.000',
  notes: '',
  is_low_stock: false,
};
const LOW = { ...OK, id: 'i-low', name: 'Chiya patti', sku: null, qty_on_hand_units: '2.000', is_low_stock: true };
// The server flags this low as well; the screen must report it only as the
// worse of the two.
const NEG = { ...OK, id: 'i-neg', name: 'Sugar', sku: null, qty_on_hand_units: '-3.000', is_low_stock: true };

const ALL_PERMS = [
  'inventory:read', 'inventory:create', 'inventory:update',
  'inventory:delete', 'inventory:adjust',
];

function mockInventory(items: unknown[], perms: string[] = ALL_PERMS, extra: Record<string, () => { json: unknown }> = {}) {
  return mockFetchByPath({
    // Sub-routes first: the mock matches by substring, first hit wins, and
    // '/v1/inventory/i-neg/movements'.includes('/v1/inventory') is true.
    '/v1/inventory/i-neg/movements': () => ({ json: { movements: [], total: 0 } }),
    '/v1/inventory/i-ok/movements': () => ({ json: { movements: [], total: 0 } }),
    '/v1/inventory/i-ok/pack-rules': () => ({ json: { pack_rules: [] } }),
    ...extra,
    '/v1/inventory': () => ({ json: { items } }),
    '/v1/me': () => ({
      json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] },
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

describe('low versus negative', () => {
  it('counts a negative item once, as negative — the badges must not exceed the list', async () => {
    mockInventory([OK, LOW, NEG]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Sugar')).toBeOnTheScreen());

    expect(screen.getByText('1 negative')).toBeOnTheScreen();
    expect(screen.getByText('1 low')).toBeOnTheScreen();
  });

  it('says what negative actually means, rather than just colouring it', async () => {
    // "Low" reads as "order more". A negative count means the book is wrong,
    // and ordering more would not fix it.
    mockInventory([NEG]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Sugar')).toBeOnTheScreen());

    expect(screen.getByText('Negative')).toBeOnTheScreen();
    expect(screen.getByText(/More has been sold than was recorded coming in/)).toBeOnTheScreen();
    // Not also stamped Low, despite the server flagging it.
    expect(screen.queryByText('Low')).toBeNull();
  });

  it('shows no badges at all when nothing needs attention', async () => {
    mockInventory([OK]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Cola')).toBeOnTheScreen());
    expect(screen.queryByText(/negative$/)).toBeNull();
    expect(screen.queryByText(/low$/)).toBeNull();
  });
});

describe('the row', () => {
  it('carries the SKU — how the item is found on a supplier invoice', async () => {
    mockInventory([OK]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText(/CO-500/)).toBeOnTheScreen());
  });

  it('trims the zeros Postgres pads a numeric with', async () => {
    // "50.000 bottle · par 10.000" is noise; the quantity is 50.
    mockInventory([OK]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('50')).toBeOnTheScreen());
    expect(screen.queryByText('50.000')).toBeNull();
  });
});

describe('the stock ledger', () => {
  it('opens, and explains a negative count with a running balance', async () => {
    // The hook existed since M7 with nothing wired to it: the phone could show
    // minus three and offer no way to find out why.
    mockInventory([NEG], ALL_PERMS, {
      '/v1/inventory/i-neg/movements': () => ({
        json: {
          movements: [
            { id: 'm1', inventory_item_id: 'i-neg', delta_units: '-5.000', reason: 'sale', notes: '', at: '2026-09-09T10:00:00Z', by_user_name: 'Bina' },
            { id: 'm2', inventory_item_id: 'i-neg', delta_units: '2.000', reason: 'purchase', notes: 'half sack', at: '2026-09-08T10:00:00Z' },
          ],
          total: 2,
        },
      }),
    });
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Sugar')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('movements-i-neg'));
    await waitFor(() => expect(screen.getByText('Sold')).toBeOnTheScreen());

    expect(screen.getByText('−5')).toBeOnTheScreen();
    expect(screen.getByText('+2')).toBeOnTheScreen();
    // Walked back from today's −3: the balance after the newest movement IS
    // the on-hand figure (so -3 appears twice, in the header and the column),
    // and the row above it stood at 2.
    expect(screen.getAllByText('-3').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('2')).toBeOnTheScreen();
    expect(screen.getByText(/Bina/)).toBeOnTheScreen();
  });

  it('says so plainly when nothing has moved', async () => {
    mockInventory([OK]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Cola')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('movements-i-ok'));
    await waitFor(() => expect(screen.getByText('Nothing has moved yet.')).toBeOnTheScreen());
  });
});

describe('pack rules', () => {
  it('states both halves of the conversion', async () => {
    // A bare "200" says nothing about what was bought.
    mockInventory([OK], ALL_PERMS, {
      '/v1/inventory/i-ok/pack-rules': () => ({
        json: {
          pack_rules: [
            {
              id: 'pr1',
              inventory_item_id: 'i-ok',
              container_unit: 'carton',
              container_qty: 1,
              sale_unit: 'bottle',
              sale_qty_per_container: 200,
              created_at: '2026-09-01T00:00:00Z',
            },
          ],
        },
      }),
    });
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Cola')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('pack-rules-i-ok'));
    await waitFor(() => expect(screen.getByText('1 carton = 200 bottle')).toBeOnTheScreen());
    expect(screen.getByLabelText('remove-pack-rule-pr1')).toBeOnTheScreen();
  });

  it('posts the item sale unit alongside the container', async () => {
    const fetchSpy = mockInventory([OK]);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Cola')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('pack-rules-i-ok'));
    await waitFor(() => expect(screen.getByLabelText('container-unit')).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('container-unit'), 'carton');
    await userEvent.type(screen.getByLabelText('sale-per-container'), '200');
    await userEvent.press(screen.getByText('Add rule'));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(
        ([url, init]) => String(url).includes('/pack-rules') && (init as RequestInit)?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post?.[1] as RequestInit)?.body))).toEqual({
        container_unit: 'carton',
        container_qty: 1,
        sale_unit: 'bottle',
        sale_qty_per_container: 200,
      });
    });
  });

  it('is read-only for a member who cannot create or delete', async () => {
    mockInventory([OK], ['inventory:read', 'inventory:adjust']);
    await renderWithProviders(<InventoryManager />);
    await waitFor(() => expect(screen.getByText('Cola')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('pack-rules-i-ok'));
    await waitFor(() => expect(screen.getByText('No pack rules.')).toBeOnTheScreen());
    expect(screen.queryByLabelText('container-unit')).toBeNull();
  });
});
