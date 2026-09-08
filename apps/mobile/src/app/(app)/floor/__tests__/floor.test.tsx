import { screen, waitFor, fireEvent } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Floor from '../index';

/** ui/Grid renders its children only after its onLayout gives it a width, and
 * RNTL never fires onLayout on its own — feed it one so the tiles mount. */
function layoutGrid() {
  fireEvent(screen.getByTestId('tables-grid'), 'layout', {
    nativeEvent: { layout: { width: 360, height: 400 } },
  });
}

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
        active_permissions: ['order:create', 'order:read', 'table:update'],
        memberships: [],
      },
    }),
    '/v1/tables': () => ({
      json: {
        tables: [
          { id: 'tbl1', name: 'T1', capacity: 2, area: 'Indoor', status: 'free', icon: '', sort: 0 },
          { id: 'tbl2', name: 'T2', capacity: 4, area: '', status: 'occupied', icon: '', sort: 1 },
          { id: 'tbl3', name: 'T3', capacity: 2, area: '', status: 'dirty', icon: '', sort: 2 },
          { id: 'tbl4', name: 'T4', capacity: 2, area: '', status: 'reserved', icon: '', sort: 3 },
        ],
      },
    }),
    '/v1/orders': () => ({
      json: {
        orders: [
          {
            id: 'o-table',
            service_table_id: 'tbl2',
            status: 'open',
            opened_at: new Date().toISOString(),
            live_subtotal_cents: 1250,
            items_total: 3,
            items_pending: 1,
            items_in_progress: 2,
            items_ready: 0,
            items_served: 0,
          },
          {
            id: 'o-walk',
            service_table_id: null,
            table_label: 'Ram',
            status: 'open',
            opened_at: new Date().toISOString(),
            live_subtotal_cents: 500,
            items_total: 1,
            items_pending: 1,
            items_in_progress: 0,
            items_ready: 0,
            items_served: 0,
          },
        ],
      },
    }),
  });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('Floor', () => {
  it('renders tables and walk-in tabs with live amounts', async () => {
    await renderWithProviders(<Floor />);
    await screen.findByTestId('tables-grid');
    layoutGrid();
    await waitFor(() => expect(screen.getByLabelText('table-T1')).toBeOnTheScreen());
    expect(screen.getByLabelText('table-T2')).toBeOnTheScreen();
    // Walk-in "Ram" tab card + the occupied table's live amount.
    expect(screen.getByText('Ram')).toBeOnTheScreen();
    expect(screen.getByText('Rs 12.5')).toBeOnTheScreen(); // occupied table amount (1250 paisa)
  });

  it('shows a dirty table with a sweep affordance', async () => {
    await renderWithProviders(<Floor />);
    await screen.findByTestId('tables-grid');
    layoutGrid();
    await waitFor(() => expect(screen.getByLabelText('table-T3')).toBeOnTheScreen());
    // The tile carries no "Dirty" stamp any more — the dashed recessed card and
    // the warn-tinted glyph say that. What's left is one actionable row.
    // (textTransform is style, not text, so the match is the pre-transform string.)
    expect(screen.getByText('Clear')).toBeOnTheScreen();
    expect(screen.getByLabelText('Mark T3 clean')).toHaveProp('accessibilityRole', 'button');
    expect(screen.queryByText('Dirty')).toBeNull();
  });

  it('sweeps a dirty table clean when the Clear row is pressed', async () => {
    await renderWithProviders(<Floor />);
    await screen.findByTestId('tables-grid');
    layoutGrid();
    await waitFor(() => expect(screen.getByLabelText('table-T3')).toBeOnTheScreen());

    fireEvent.press(screen.getByLabelText('Mark T3 clean'));

    await waitFor(() => {
      const patched = (globalThis.fetch as jest.Mock).mock.calls.find(
        ([url, init]) => String(url).includes('/v1/tables/tbl3') && init?.method === 'PATCH',
      );
      expect(patched).toBeDefined();
      expect(JSON.parse(patched![1].body)).toEqual({ status: 'free' });
    });
  });

  it('holds a reserved table apart from a free one, and offers no way to open it', async () => {
    await renderWithProviders(<Floor />);
    await screen.findByTestId('tables-grid');
    layoutGrid();
    await waitFor(() => expect(screen.getByLabelText('table-T4')).toBeOnTheScreen());
    expect(screen.getByText('Reserved')).toBeOnTheScreen();
    // A reserved table is not a free one: it must not invite a tab. Card only
    // becomes a PressableScale (accessibilityRole="button") when it has an
    // onPress, so the absent role IS the absent affordance.
    expect(screen.getByLabelText('table-T4')).not.toHaveProp('accessibilityRole', 'button');
    expect(screen.getByLabelText('table-T1')).toHaveProp('accessibilityRole', 'button');
  });

  it('withholds the sweep affordance from a member who cannot edit tables', async () => {
    // Same floor, but no `table:update` — the dirty tile must still SAY it is
    // dirty while offering no way to clear it (the API would refuse anyway).
    mockFetchByPath({
      '/v1/me': () => ({
        json: {
          user_id: 'u',
          email: 'a@b.c',
          name: 'A',
          active_permissions: ['order:create', 'order:read'],
          memberships: [],
        },
      }),
      '/v1/tables': () => ({
        json: {
          tables: [{ id: 'tbl3', name: 'T3', capacity: 2, area: '', status: 'dirty', icon: '', sort: 0 }],
        },
      }),
      '/v1/orders': () => ({ json: { orders: [] } }),
    });

    await renderWithProviders(<Floor />);
    await screen.findByTestId('tables-grid');
    layoutGrid();
    await waitFor(() => expect(screen.getByLabelText('table-T3')).toBeOnTheScreen());
    // Still SAYS it is dirty, but the row is inert: no 'Clear', and — as with
    // the reserved tile above — no 'button' role to press.
    expect(screen.getByText('Needs clearing')).toBeOnTheScreen();
    expect(screen.queryByText('Clear')).toBeNull();
    expect(screen.queryByLabelText('Mark T3 clean')).toBeNull();
    expect(screen.getByLabelText('T3 needs clearing')).not.toHaveProp('accessibilityRole', 'button');
  });

  it('opens a new walk-in from the floating action button', async () => {
    await renderWithProviders(<Floor />);
    const fab = await screen.findByLabelText('new-walkin');
    fireEvent.press(fab);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/floor/[orderId]/menu',
      params: { orderId: 'new' },
    });
  });
});
