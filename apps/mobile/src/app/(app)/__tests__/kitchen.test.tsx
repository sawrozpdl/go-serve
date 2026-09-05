/**
 * Kitchen board when the wifi drops.
 *
 * The board used to go blank the moment the connection went — even though the
 * queued sends were sitting right there on the device — and the mark-ready
 * button kept firing PATCHes that could only fail, because ticket status is not
 * a queueable op.
 */
import { screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { useOfflineQueue } from '@/offline/queue';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Redirect: () => null,
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Kitchen from '../kitchen';

const SLUG = 'sahan';

const ticket = (over: Record<string, unknown> = {}) => ({
  item_id: 'srv-1',
  order_id: 'o-srv',
  service_table_name: 'T9',
  table_label: '',
  menu_item_name: 'Server Latte',
  qty: 1,
  add_ons: [],
  modifiers: null,
  notes: '',
  kitchen_status: 'in_progress',
  sent_to_kitchen_at: '2026-09-05T10:00:00Z',
  ready_at: null,
  ...over,
});

function mockKitchen(tickets: unknown[] | 'fail') {
  return mockFetchByPath({
    '/v1/me': () => ({
      json: {
        user_id: 'u',
        email: 'chef@cafe.com',
        name: 'Chef',
        active_permissions: ['kitchen:read', 'kitchen:update'],
        memberships: [],
      },
    }),
    '/v1/kitchen/tickets': () =>
      tickets === 'fail' ? { status: 500, json: {} } : { json: { tickets } },
    '/v1/outlets': () => ({ json: { outlets: [] } }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: SLUG, id: 't1', name: 'Sahan Cafe' });
  useConnectivity.setState({ mode: 'online' });
  useOfflineQueue.setState({ ops: [] } as never);
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  useOfflineQueue.setState({ ops: [] } as never);
});

describe('Kitchen board', () => {
  it('shows the server board and offers the action when online', async () => {
    mockKitchen([ticket()]);
    await renderWithProviders(<Kitchen />);
    await waitFor(() => expect(screen.getByText('Server Latte')).toBeOnTheScreen());
    expect(screen.getByText('Mark ready')).toBeOnTheScreen();
  });

  it('withholds the action offline — ticket status needs server truth', async () => {
    mockKitchen([ticket()]);
    await renderWithProviders(<Kitchen />);
    await waitFor(() => expect(screen.getByText('Server Latte')).toBeOnTheScreen());

    useConnectivity.setState({ mode: 'offline' });
    await waitFor(() => expect(screen.queryByText('Mark ready')).toBeNull());
    // The queue is still readable, so the ticket itself stays on the board.
    expect(screen.getByText('Server Latte')).toBeOnTheScreen();
  });

  it('says it is offline rather than claiming the kitchen is clear', async () => {
    // The board load fails, then the connection drops. (Setting offline BEFORE
    // rendering would be a fiction: any successful request — /v1/me here —
    // marks the client online again, exactly as it does on a real device.)
    mockKitchen('fail');
    await renderWithProviders(<Kitchen />);
    await waitFor(() => expect(screen.getByText('Try again')).toBeOnTheScreen());

    useConnectivity.setState({ mode: 'offline' });

    await waitFor(() => expect(screen.getByText("You're offline")).toBeOnTheScreen());
    // The board is unknown, not empty — claiming otherwise is a lie a kitchen
    // would act on.
    expect(screen.queryByText('No tickets cooking')).toBeNull();
  });
});
