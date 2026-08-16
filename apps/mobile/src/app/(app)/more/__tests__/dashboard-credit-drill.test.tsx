import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Redirect: () => null,
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Dashboard from '../dashboard';

/** A dashboard payload with credit collected split across two payers, one of
 *  whom paid more than once. */
function dashboardJson(overrides: Record<string, unknown> = {}) {
  return {
    range: 'today',
    from: '',
    to: '',
    timezone: 'Asia/Kathmandu',
    kpis: {
      sales_cents: 0,
      tab_cents: 0,
      credit_collected_cents: 65000,
      tax_cents: 0,
      service_cents: 0,
      order_count: 0,
      avg_ticket_cents: 0,
      expenses_cents: 0,
      net_cents: 0,
      void_count: 0,
      discount_cents: 0,
    },
    daily: [],
    top_sellers: [],
    slow_movers: [],
    payment_mix: { cash_cents: 0, bank_cents: 0, online_cents: 0 },
    tab_breakdown: [],
    credit_collected_breakdown: [
      { house_tab_id: 'ht1', name: 'Office next door', amount_cents: 50000, count: 3 },
      { house_tab_id: 'ht2', name: 'Ramesh', amount_cents: 15000, count: 1 },
    ],
    ...overrides,
  };
}

function mount(json: Record<string, unknown>) {
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
    '/v1/reports/dashboard': () => ({ json }),
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

describe('Dashboard — credit collected drill', () => {
  it('drills the credit-collected tile into who paid', async () => {
    mount(dashboardJson());
    const user = userEvent.setup();
    await renderWithProviders(<Dashboard />);

    // The tile itself renders the total.
    await waitFor(() => expect(screen.getByLabelText('credit-collected-drill')).toBeOnTheScreen());
    // Payers are behind the drill, not on the tile.
    expect(screen.queryByText('Office next door')).toBeNull();

    await user.press(screen.getByLabelText('credit-collected-drill'));

    await waitFor(() => expect(screen.getByText('Office next door')).toBeOnTheScreen());
    expect(screen.getByText('Ramesh')).toBeOnTheScreen();
    // A tab that paid several times says so — otherwise one figure reads as one
    // payment and can't be reconciled against the drawer.
    expect(screen.getByText('3 payments')).toBeOnTheScreen();
    // ...and a single payment must NOT be labelled "1 payments".
    expect(screen.queryByText('1 payments')).toBeNull();
  });

  it('shows no drill affordance when nothing was collected', async () => {
    mount(
      dashboardJson({
        kpis: { ...dashboardJson().kpis, credit_collected_cents: 0 },
        credit_collected_breakdown: [],
      }),
    );
    await renderWithProviders(<Dashboard />);

    // Wait for the report to land (the Orders tile is always rendered — its
    // label is uppercased in style, not in the text node), then assert the
    // credit tile is absent rather than racing an empty tree.
    await waitFor(() => expect(screen.getByText('Orders')).toBeOnTheScreen());
    expect(screen.queryByLabelText('credit-collected-drill')).toBeNull();
  });

  it('survives an API that predates the breakdown field', async () => {
    // credit_collected_breakdown is optional on the type: an older API omits it
    // entirely. The tile must still drill, just with no rows.
    const json = dashboardJson();
    delete (json as Record<string, unknown>).credit_collected_breakdown;
    mount(json);
    const user = userEvent.setup();
    await renderWithProviders(<Dashboard />);

    await waitFor(() => expect(screen.getByLabelText('credit-collected-drill')).toBeOnTheScreen());
    await user.press(screen.getByLabelText('credit-collected-drill'));
    await waitFor(() =>
      expect(screen.getByText('No credit collections in this period.')).toBeOnTheScreen(),
    );
  });
});
