/**
 * The order menu's category has to survive a remount. "Add items" is a fresh
 * `router.push` of floor/[orderId]/menu every time (and Done replaces back to
 * the ticket), so while the selection lived in component state the grid snapped
 * back to Popular after every add — losing the category mid-order.
 *
 * Assertions go through each render's own queries rather than the global
 * `screen`, which stays bound to whichever tree it saw last.
 */
import { userEvent, waitFor, type RenderResult } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useTenantStore } from '@/stores/tenant';
import { useMenuUi } from '@/stores/menuUi';
import { MenuGrid } from '../MenuGrid';
import type { OrderController } from '../useOrderController';

const CATEGORIES = [
  { id: 'c-momo', name: 'Momo', icon: '', sort: 0 },
  { id: 'c-coffee', name: 'Coffee', icon: '', sort: 1 },
];
const ITEMS = [
  { id: 'i-jhol', name: 'Jhol Momo', category_id: 'c-momo', price_cents: 18000, is_active: true, icon: '' },
  { id: 'i-latte', name: 'Latte', category_id: 'c-coffee', price_cents: 9000, is_active: true, icon: '' },
];
// Popular is a server list, not a client filter — it answers with its own rows.
const POPULAR = [{ ...ITEMS[1], qty_30d: 12 }];

/** MenuGrid only reads these three off the controller. */
function stubCtrl(): OrderController {
  return {
    pendingQtyByItem: new Map<string, number>(),
    addMenuItem: jest.fn(),
    removeMenuItem: jest.fn(),
  } as unknown as OrderController;
}

const isSelected = (view: RenderResult, label: string) =>
  view.getByLabelText(label).props.accessibilityState?.selected;

function routes(popular: unknown[] = POPULAR) {
  return mockFetchByPath({
    '/v1/menu/categories': () => ({ json: { categories: CATEGORIES } }),
    '/v1/menu/popular': () => ({ json: { items: popular } }),
    '/v1/menu/items': () => ({ json: { items: ITEMS } }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useMenuUi.setState({ catId: null });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
  routes();
});

describe('MenuGrid category selection', () => {
  it('opens on Popular, then keeps the chosen category across a remount', async () => {
    const user = userEvent.setup();
    const first = await renderWithProviders(<MenuGrid key="visit-1" ctrl={stubCtrl()} />);
    await waitFor(() => expect(first.getByLabelText('Popular')).toBeOnTheScreen());
    expect(isSelected(first, 'Popular')).toBe(true);

    await user.press(first.getByLabelText('Momo'));
    expect(isSelected(first, 'Momo')).toBe(true);
    expect(isSelected(first, 'Popular')).toBe(false);
    await waitFor(() => expect(first.getByText('Jhol Momo')).toBeOnTheScreen());

    // What the ticket round-trip does: the old MenuGrid is discarded and a brand
    // new one mounts. A changed key guarantees that (fresh component state), and
    // keeps it to one render root — calling render() twice in a single test
    // leaves RNTL's renderer detached and every later tree comes back null.
    first.rerender(<MenuGrid key="visit-2" ctrl={stubCtrl()} />);

    await waitFor(() => expect(first.getByLabelText('Momo')).toBeOnTheScreen());
    expect(isSelected(first, 'Momo')).toBe(true);
    expect(isSelected(first, 'Popular')).toBe(false);
    expect(first.getByText('Jhol Momo')).toBeOnTheScreen();
  });

  it('falls back to the default when the remembered category no longer exists', async () => {
    // e.g. it was deleted, or belongs to a workspace since switched away from.
    useMenuUi.setState({ catId: 'c-gone' });
    const view = await renderWithProviders(<MenuGrid ctrl={stubCtrl()} />);
    await waitFor(() => expect(view.getByLabelText('Popular')).toBeOnTheScreen());
    expect(isSelected(view, 'Popular')).toBe(true);
    // The chips and the rows land from two separate requests — waiting only on
    // the chip made this assertion race the popular-items response.
    await waitFor(() => expect(view.getByText('Latte')).toBeOnTheScreen());
  });

  it('falls back to the first category when the cafe has no popular items', async () => {
    routes([]);
    const view = await renderWithProviders(<MenuGrid ctrl={stubCtrl()} />);
    await waitFor(() => expect(view.getByLabelText('Momo')).toBeOnTheScreen());
    expect(view.queryByLabelText('Popular')).toBeNull();
    expect(isSelected(view, 'Momo')).toBe(true);
  });
});
