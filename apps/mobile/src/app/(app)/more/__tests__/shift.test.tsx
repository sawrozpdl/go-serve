/**
 * Shift screen: the drawer context that makes opening a shift a decision rather
 * than a guess — the last close figure, and the one-tap prefill of it.
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
import ShiftScreen from '../shift';

const LAST_CLOSE = {
  id: 'sh-old',
  opened_by_user_id: 'u',
  opened_by_email: 'saroj@cafe.com',
  opened_at: '2026-07-28T03:00:00Z',
  opening_float_cents: 500000,
  closed_at: '2026-07-28T16:00:00Z',
  closing_count_cents: 500000,
  expected_cash_cents: 500000,
  variance_cents: 0,
  notes: '',
};

/** `/v1/shifts/current` must be registered BEFORE `/v1/shifts` — the fetch mock
 *  matches keys by substring, first hit wins. */
function mockShifts(current: unknown) {
  return mockFetchByPath({
    '/v1/me': () => ({
      json: {
        user_id: 'u',
        email: 'saroj@cafe.com',
        name: 'Saroj',
        active_permissions: ['shift:read', 'shift:create', 'shift:settle'],
        memberships: [],
      },
    }),
    '/v1/shifts/current': () => ({ json: current }),
    '/v1/shifts/open': (body) => ({ json: { id: 'sh-new', ...(body as object) } }),
    '/v1/shifts': () => ({ json: [LAST_CLOSE] }),
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

describe('Shift screen with no shift open', () => {
  it('shows what the last shift closed with', async () => {
    mockShifts(null);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Last close')).toBeOnTheScreen());
    // Card headline + the recent-shifts row both carry the figure.
    expect(screen.getAllByText('Rs 5,000').length).toBeGreaterThan(0);
    expect(screen.getByText('No shift is open.')).toBeOnTheScreen();
    expect(screen.getByText('Recent shifts')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('matched expected').length).toBeGreaterThan(0);
  });

  it('fills the opening float from the last close in one tap', async () => {
    const user = userEvent.setup();
    mockShifts(null);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Last close')).toBeOnTheScreen());

    // The EmptyState action opens the sheet (the footer button shares its title).
    await user.press(screen.getAllByText('Open shift')[0]);
    await user.press(screen.getByLabelText('Same as last close · Rs 5,000'));
    expect(screen.getByTestId('open-float').props.value).toBe('5000');
  });

  it('warns when the float differs from the last close, without blocking', async () => {
    const user = userEvent.setup();
    mockShifts(null);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Last close')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Open shift')[0]);
    await user.paste(screen.getByTestId('open-float'), '4800');
    expect(screen.getByText(/vs. last close/)).toBeOnTheScreen();
    // Still submittable — cafés genuinely bank cash overnight.
    expect(screen.getAllByText('Open shift').length).toBeGreaterThan(1);
  });
});

const OPEN_SHIFT = {
  id: 'sh1',
  opened_by_user_id: 'u',
  opened_by_email: 'saroj@cafe.com',
  opened_at: '2026-07-29T03:00:00Z',
  opening_float_cents: 500000,
  notes: '',
  live_expected_cash_cents: 845000,
  live_cash_count_cents: 345000,
  live_cash_in_cents: 345000,
  live_cash_out_cents: 0,
};

describe('Closing a shift with a variance that matches one payment', () => {
  /** Keys are matched by URL substring, first hit wins — the bare `/v1/shifts`
   *  list must come last or it would swallow every shift sub-route. */
  function mockOpenShift() {
    return mockFetchByPath({
      '/v1/me': () => ({
        json: {
          user_id: 'u',
          email: 'saroj@cafe.com',
          name: 'Saroj',
          active_permissions: ['shift:read', 'shift:settle', 'payment:reclassify'],
          memberships: [],
        },
      }),
      '/v1/shifts/current': () => ({ json: OPEN_SHIFT }),
      '/v1/shifts/sh1/cash-drops': () => ({ json: { cash_drops: [] } }),
      '/v1/shifts/sh1/payments': () => ({
        json: {
          payments: [
            // Taken as cash, but the drawer is short by exactly this much.
            {
              id: 'p1',
              order_id: 'o1',
              method: 'cash',
              amount_cents: 35000,
              reference_no: '',
              recorded_at: '2026-07-29T08:22:00Z',
              table_name: 'Table 4',
            },
          ],
        },
      }),
      '/v1/orders/o1/payments/p1/reclassify': (body) => ({ json: { id: 'p1', ...(body as object) } }),
      '/v1/shifts': () => ({ json: [OPEN_SHIFT] }),
    });
  }

  it('names the culprit payment and reclassifies it in one tap', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockOpenShift();
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Expected in drawer')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Close shift')[0]);
    // Rs 8,100 counted against Rs 8,450 expected → short by exactly Rs 350.
    await user.paste(screen.getByTestId('close-count'), '8100');

    await waitFor(() => expect(screen.getByText(/Short by exactly the cash payment/)).toBeOnTheScreen());
    expect(screen.getByText(/Table 4/)).toBeOnTheScreen();

    await user.press(screen.getByText('Reclassify to Online'));
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/payments/p1/reclassify'));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ method: 'online' });
    });
  });

  it('keeps quiet for a user who cannot reclassify', async () => {
    const user = userEvent.setup();
    mockFetchByPath({
      '/v1/me': () => ({
        json: {
          user_id: 'u',
          email: 'saroj@cafe.com',
          name: 'Saroj',
          active_permissions: ['shift:read', 'shift:settle'],
          memberships: [],
        },
      }),
      '/v1/shifts/current': () => ({ json: OPEN_SHIFT }),
      '/v1/shifts/sh1/cash-drops': () => ({ json: { cash_drops: [] } }),
      '/v1/shifts': () => ({ json: [OPEN_SHIFT] }),
    });
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Expected in drawer')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Close shift')[0]);
    await user.paste(screen.getByTestId('close-count'), '8100');

    expect(screen.getByText(/short/)).toBeOnTheScreen();
    expect(screen.queryByText(/Short by exactly/)).toBeNull();
  });
});
