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
    // The real endpoint answers an envelope, not a bare array — mocking the
    // array is what let a crash-on-render ship.
    '/v1/shifts': () => ({ json: { shifts: [LAST_CLOSE] } }),
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
      '/v1/shifts': () => ({ json: { shifts: [OPEN_SHIFT] } }),
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
      '/v1/shifts': () => ({ json: { shifts: [OPEN_SHIFT] } }),
    });
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Expected in drawer')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Close shift')[0]);
    await user.paste(screen.getByTestId('close-count'), '8100');

    expect(screen.getByText(/short/)).toBeOnTheScreen();
    expect(screen.queryByText(/Short by exactly/)).toBeNull();
  });
});

// -------------------------------------------------------------------------
// The drawer ledger — deleting a movement, and refusing to delete a mirror.
// -------------------------------------------------------------------------

const DROP = {
  id: 'd1',
  shift_id: 'sh1',
  direction: 'out' as const,
  kind: 'bank_deposit' as const,
  amount_cents: 800000,
  reason: 'NIBL slip 2034',
  notes: '',
  recorded_by_user_id: 'u2',
  // Deliberately not the shift's opener: the header already prints that
  // address, and a shared string makes the assertion below ambiguous.
  recorded_by_email: 'bina@cafe.com',
  recorded_at: '2026-07-29T09:00:00Z',
};

/** A drawer row written by an expense — the API owns it, not this panel. */
const LINKED_DROP = {
  ...DROP,
  id: 'd2',
  kind: 'expense' as const,
  reason: 'Local Mill',
  amount_cents: 45000,
  expense_id: 'e1',
};

function mockDrawer(drops: unknown[], perms: string[]) {
  return mockFetchByPath({
    '/v1/me': () => ({
      json: { user_id: 'u', email: 'saroj@cafe.com', name: 'Saroj', active_permissions: perms, memberships: [] },
    }),
    '/v1/shifts/current': () => ({ json: OPEN_SHIFT }),
    '/v1/shifts/sh1/cash-drops': () => ({ json: { cash_drops: drops } }),
    '/v1/shifts': () => ({ json: { shifts: [OPEN_SHIFT] } }),
  });
}

describe('the drawer ledger', () => {
  it('offers to remove a movement this panel posted', async () => {
    mockDrawer([DROP], ['shift:read', 'shift:withdraw', 'shift:delete']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText(/Bank deposit/)).toBeOnTheScreen());
    expect(screen.getByLabelText('remove-drop-d1')).toBeOnTheScreen();
  });

  it('refuses to remove a row another record owns, and says where it lives', async () => {
    // Deleting the mirror alone would leave the drawer and the expense ledger
    // disagreeing, so the API refuses — better to never offer the button.
    mockDrawer([LINKED_DROP], ['shift:read', 'shift:withdraw', 'shift:delete']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText(/Expense/)).toBeOnTheScreen());

    expect(screen.queryByLabelText('remove-drop-d2')).toBeNull();
    expect(screen.getByText('linked')).toBeOnTheScreen();
    expect(screen.getByText('Delete the expense to remove it.')).toBeOnTheScreen();
  });

  it('hides removal from someone without shift:delete', async () => {
    mockDrawer([DROP], ['shift:read', 'shift:withdraw']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText(/Bank deposit/)).toBeOnTheScreen());
    expect(screen.queryByLabelText('remove-drop-d1')).toBeNull();
  });

  it('shows who recorded it and when — a drawer row with no author is unauditable', async () => {
    mockDrawer([DROP], ['shift:read', 'shift:withdraw', 'shift:delete']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText(/bina@cafe.com/)).toBeOnTheScreen());
  });
});

describe('recording a drawer movement', () => {
  it('offers only the two kinds that have a counterpart', async () => {
    // 0014 retired the rest: an owner draw is a Finance payout, an eSewa→bank
    // move is an inter-account transfer. Posting them here wrote a bare cash
    // movement with nothing on the other side.
    const user = userEvent.setup();
    mockDrawer([], ['shift:read', 'shift:withdraw']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Record drawer movement')).toBeOnTheScreen());

    await user.press(screen.getByText('Record drawer movement'));
    await waitFor(() => expect(screen.getByLabelText('Bank deposit')).toBeOnTheScreen());
    expect(screen.getByLabelText('Correction')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Owner draw')).toBeNull();
    expect(screen.queryByLabelText('Paid out')).toBeNull();
    expect(screen.queryByLabelText('Transfer')).toBeNull();
  });

  it('asks a correction which way it goes, and will not post it unexplained', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockDrawer([], ['shift:read', 'shift:withdraw']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Record drawer movement')).toBeOnTheScreen());

    await user.press(screen.getByText('Record drawer movement'));
    // A deposit always leaves the drawer, so it is not asked.
    expect(screen.queryByLabelText('Drawer was over')).toBeNull();

    await user.press(screen.getByLabelText('Correction'));
    await waitFor(() => expect(screen.getByLabelText('Drawer was short')).toBeOnTheScreen());
    await user.paste(screen.getByTestId('drop-amount'), '500');

    await user.press(screen.getByText('Record correction'));
    // Blocked: an unexplained correction is indistinguishable from a till
    // being quietly balanced.
    expect(fetchSpy.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'POST')).toHaveLength(0);
    expect(screen.getByText(/indistinguishable from a till being quietly balanced/)).toBeOnTheScreen();
  });

  it('sends the direction only for a correction', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockDrawer([], ['shift:read', 'shift:withdraw']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Record drawer movement')).toBeOnTheScreen());

    await user.press(screen.getByText('Record drawer movement'));
    await user.press(screen.getByLabelText('Correction'));
    await user.press(screen.getByLabelText('Drawer was short'));
    await user.paste(screen.getByTestId('drop-amount'), '500');
    await user.type(screen.getByLabelText('Notes'), 'recount after coin shortage');
    await user.press(screen.getByText('Record correction'));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(
        ([url, init]) => String(url).includes('/cash-drops') && (init as RequestInit)?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post?.[1] as RequestInit)?.body))).toMatchObject({
        kind: 'correction',
        direction: 'in',
        amount_cents: 50000,
        notes: 'recount after coin shortage',
      });
    });
  });
});

describe('the close panel', () => {
  it('grades the variance rather than only naming it', async () => {
    const user = userEvent.setup();
    mockDrawer([], ['shift:read', 'shift:settle']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Expected in drawer')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Close shift')[0]);
    // Rs 8,440 against Rs 8,450 expected → Rs 10 short: coin rounding.
    await user.paste(screen.getByTestId('close-count'), '8440');
    expect(screen.getByText(/usually coin rounding/)).toBeOnTheScreen();
  });

  it('escalates a large hole and presses for a note', async () => {
    const user = userEvent.setup();
    mockDrawer([], ['shift:read', 'shift:settle']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Expected in drawer')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Close shift')[0]);
    // Rs 2,450 against Rs 8,450 → Rs 6,000 short.
    await user.paste(screen.getByTestId('close-count'), '2450');
    expect(screen.getByText(/tell whoever runs the till/)).toBeOnTheScreen();
    expect(screen.getByText('Notes')).toBeOnTheScreen();
  });

  it('never blocks the close — a shift that cannot close is closed dishonestly', async () => {
    const user = userEvent.setup();
    mockDrawer([], ['shift:read', 'shift:settle']);
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText('Expected in drawer')).toBeOnTheScreen());

    await user.press(screen.getAllByText('Close shift')[0]);
    await user.paste(screen.getByTestId('close-count'), '2450');
    expect(screen.getAllByText('Close shift').at(-1)).not.toHaveProp(
      'accessibilityState',
      expect.objectContaining({ disabled: true }),
    );
  });
});

describe('online takings', () => {
  it('are reported for cross-checking but kept out of expected cash', async () => {
    mockFetchByPath({
      '/v1/me': () => ({
        json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: ['shift:read'], memberships: [] },
      }),
      '/v1/shifts/current': () => ({ json: { ...OPEN_SHIFT, live_online_in_cents: 220000 } }),
      '/v1/shifts/sh1/cash-drops': () => ({ json: { cash_drops: [] } }),
      '/v1/shifts': () => ({ json: { shifts: [OPEN_SHIFT] } }),
    });
    await renderWithProviders(<ShiftScreen />);
    await waitFor(() => expect(screen.getByText(/cross-check/)).toBeOnTheScreen());
    expect(screen.getByText(/Rs 2,200 taken online/)).toBeOnTheScreen();
    expect(screen.getByText(/Not part of expected cash/)).toBeOnTheScreen();
  });
});
