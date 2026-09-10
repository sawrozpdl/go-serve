/**
 * Menu manager: the fields the phone could not set, and the two places where
 * the cascade or the price needed explaining rather than just storing.
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
import MenuManager from '../menu';

const CAT: Record<string, unknown> = {
  id: 'c1',
  name: 'Drinks',
  sort: 0,
  icon: '',
  is_active: true,
  kitchen_behavior: 'serve' as const,
  outlet_id: null,
  item_count: 1,
  modifier_group_ids: [],
};

const ITEM: Record<string, unknown> = {
  id: 'i1',
  category_id: 'c1',
  name: 'Latte',
  description: 'Double shot',
  price_cents: 20000,
  cost_cents: 5000,
  sku: 'LA-01',
  icon: '',
  is_active: true,
  is_featured: false,
  kitchen_behavior: 'inherit' as const,
  outlet_id: null,
  allow_half: false,
  sort: 0,
  modifier_group_ids: [],
  modifiers: null,
  preset_notes: ['extra hot'],
};

const OUTLETS = [
  { id: 'o1', name: 'Kitchen', sort: 0, is_active: true, is_default: true, printer_port: 9100, printer_width: '80' },
  { id: 'o2', name: 'Bar', sort: 1, is_active: true, is_default: false, printer_port: 9100, printer_width: '80' },
];

function mockMenu({
  cats = [CAT],
  items = [ITEM],
  outlets = OUTLETS,
  perms = ['menu:read', 'menu:create', 'menu:update', 'menu:delete'],
} = {}) {
  return mockFetchByPath({
    // Sub-routes before their prefixes: the mock matches by substring.
    '/v1/menu/items/i1/inventory-link': () => ({ json: { links: [] } }),
    '/v1/menu/categories': () => ({ json: { categories: cats } }),
    '/v1/menu/items': () => ({ json: { items } }),
    '/v1/outlets': () => ({ json: { outlets } }),
    '/v1/inventory': () => ({ json: { items: [] } }),
    '/v1/me': () => ({
      json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] },
    }),
  });
}

const bodyOf = (method: string, path: string) => {
  const call = (globalThis.fetch as jest.Mock).mock.calls.find(
    (c) => String(c[0]).includes(path) && (c[1]?.method ?? 'GET').toUpperCase() === method,
  );
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined;
};

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('the cascade explains itself', () => {
  it("names what the item's Inherit actually resolves to", async () => {
    // "Inherit" alone is honest and useless: it never says whether the drink
    // goes to the kitchen board or straight to the customer.
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() =>
      expect(screen.getByLabelText('Inherit from category (Serve immediately)')).toBeOnTheScreen(),
    );
  });

  it('stays generic when the category inherits too', async () => {
    mockMenu({ cats: [{ ...CAT, kitchen_behavior: 'inherit' }] });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByLabelText('Inherit from category')).toBeOnTheScreen());
  });

  it('names the station an inherited item lands on', async () => {
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByLabelText('Inherit (Kitchen)')).toBeOnTheScreen());
  });

  it('warns when a category routes to a station that is switched off', async () => {
    // The server's COALESCE has no is_active check, so the tickets really do
    // land on a board nobody is watching.
    mockMenu({
      cats: [{ ...CAT, outlet_id: 'o2' }],
      outlets: [OUTLETS[0], { ...OUTLETS[1], is_active: false }],
    });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Drinks')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Drinks'));
    await waitFor(() => expect(screen.getByText(/nobody is watching/)).toBeOnTheScreen());
  });
});

describe('price and cost together', () => {
  it('shows the margin the two numbers imply', async () => {
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByText(/Margin 75%/)).toBeOnTheScreen());
    expect(screen.getByText(/Rs 150 per sale/)).toBeOnTheScreen();
  });

  it('says LOSS when the item is priced under cost', async () => {
    mockMenu({ items: [{ ...ITEM, price_cents: 5000, cost_cents: 8000 }] });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByText(/Loss -60%/)).toBeOnTheScreen());
  });
});

describe('the fields the phone could not set', () => {
  it('sends SKU, sort, station and preset notes', async () => {
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByLabelText('SKU (optional)')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(bodyOf('PATCH', '/v1/menu/items/i1')).toBeDefined());
    expect(bodyOf('PATCH', '/v1/menu/items/i1')).toMatchObject({
      sku: 'LA-01',
      sort: 0,
      outlet_id: null,
      preset_notes: ['extra hot'],
    });
  });

  it('saves a blank SKU as null — the column is uniquely indexed', async () => {
    // Two items saved with '' would collide on the second.
    mockMenu({ items: [{ ...ITEM, sku: null }] });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByLabelText('SKU (optional)')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(bodyOf('PATCH', '/v1/menu/items/i1')?.sku).toBeNull());
  });

  it('splits preset notes one per line, not by comma', async () => {
    // A comma would rule out any note containing one.
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('Latte'));
    await waitFor(() => expect(screen.getByLabelText('Preset notes (optional)')).toBeOnTheScreen());
    await userEvent.clear(screen.getByLabelText('Preset notes (optional)'));
    await userEvent.type(screen.getByLabelText('Preset notes (optional)'), 'no chilli, please\nextra hot');
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() =>
      expect(bodyOf('PATCH', '/v1/menu/items/i1')?.preset_notes).toEqual([
        'no chilli, please',
        'extra hot',
      ]),
    );
  });
});

describe('the category delete guard', () => {
  it('refuses before opening a confirm that could only fail', async () => {
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Drinks')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Drinks'));
    await waitFor(() => expect(screen.getByText('Delete')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Delete'));

    // No DELETE fired: the server refuses while items remain.
    expect(
      (globalThis.fetch as jest.Mock).mock.calls.filter(
        (c) => (c[1]?.method ?? 'GET').toUpperCase() === 'DELETE',
      ),
    ).toHaveLength(0);
  });

  it('shows the item count on the row — the number IS the rule', async () => {
    mockMenu({ cats: [{ ...CAT, item_count: 7 }] });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('7')).toBeOnTheScreen());
  });
});

describe('search', () => {
  const TEA = { ...ITEM, id: 'i2', name: 'Masala Chiya', sku: 'CH-01', description: '' };

  it('finds an item by name, SKU or description', async () => {
    mockMenu({ items: [ITEM, TEA] });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Masala Chiya')).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('search-menu'), 'CH-01');
    await waitFor(() => expect(screen.queryByText('Latte')).toBeNull());
    expect(screen.getByText('Masala Chiya')).toBeOnTheScreen();
  });

  it('hides the Add item row while searching', async () => {
    // It would file the new item under a heading only reached by typing
    // something else.
    mockMenu({ items: [ITEM, TEA] });
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Add item')).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('search-menu'), 'latte');
    await waitFor(() => expect(screen.queryByText('Add item')).toBeNull());
  });

  it('offers a way out when nothing matches', async () => {
    mockMenu();
    await renderWithProviders(<MenuManager />);
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('search-menu'), 'zzzz');
    await waitFor(() => expect(screen.getByText('Nothing matches that.')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Clear search'));
    await waitFor(() => expect(screen.getByText('Latte')).toBeOnTheScreen());
  });
});
