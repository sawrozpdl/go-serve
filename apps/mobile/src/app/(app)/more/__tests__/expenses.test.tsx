/**
 * The Expenses screen's filter behaviour and its owner-source gate.
 *
 * The two things worth pinning here are what the screen ASKS the server for —
 * a wrong window silently shows the wrong money — and whether it offers a
 * payment source this cafe could never record.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { todayStr, shiftDay } from '@/lib/dates';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Redirect: () => null,
}));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import Expenses from '../expenses';

const TODAY = todayStr();

const EXPENSE = {
  id: 'e1',
  expense_category_id: 'c1',
  expense_category_name: 'Supplies',
  vendor: 'Local Mill',
  amount_cents: 45000,
  paid_at: `${TODAY}T10:00:00Z`,
  payment_method: 'cash',
  reference_no: '',
  notes: '',
  recorded_by_user_id: 'u1',
  created_at: `${TODAY}T10:00:00Z`,
  paid_from: 'owner_cash',
  owner_name: 'Sita',
  paid_from_drawer: false,
};

/** A second row so the running total is a different figure from either
 *  amount — otherwise "is that the total or the row?" is unanswerable. */
const SECOND = {
  ...EXPENSE,
  id: 'e2',
  vendor: 'NEA',
  amount_cents: 5000,
  paid_from: 'drawer',
  owner_name: null,
};

function mockScreen({
  perms = ['expense:read', 'expense:create', 'expense:update', 'expense:delete'],
  features = [] as string[],
} = {}) {
  return mockFetchByPath({
    // '/v1/expense-categories' must be registered before '/v1/expenses' —
    // the mock matches by substring and both share no prefix, but the vendors
    // route does, so order the specific ones first.
    '/v1/expenses/vendors': () => ({ json: { vendors: [] } }),
    '/v1/expense-categories': () => ({ json: { categories: [{ id: 'c1', name: 'Supplies', icon: '', is_active: true }] } }),
    '/v1/expenses': () => ({ json: { expenses: [EXPENSE, SECOND] } }),
    '/v1/me': () => ({
      json: {
        user_id: 'u1',
        email: 'owner@cafe.com',
        name: 'Owner',
        active_permissions: perms,
        memberships: [],
        billing: { plan_key: 'pro', phase: 'active', write_locked: false, member_limit: null, seats_used: 1, features },
      },
    }),
  });
}

/** Just the list requests, in order — what window the screen actually asked for. */
function expenseUrls(): string[] {
  return (globalThis.fetch as jest.Mock).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => /\/v1\/expenses\?/.test(u));
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('Expenses filters', () => {
  it('opens on today, bounded at both ends', async () => {
    mockScreen();
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());

    const url = expenseUrls()[0];
    expect(url).toContain(`from=${TODAY}`);
    expect(url).toContain(`to=${TODAY}`);
  });

  it('shows what the visible rows add up to, alongside the period they cover', async () => {
    mockScreen();
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());

    expect(screen.getByText('Today')).toBeOnTheScreen();
    expect(screen.getByText('2 expenses')).toBeOnTheScreen();
    // 450 + 50 — the sum of the rows on screen, not either of them.
    expect(screen.getByText('Rs 500')).toBeOnTheScreen();
  });

  it('stepping back a day re-asks the server for that day', async () => {
    mockScreen();
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('previous-day'));

    const yesterday = shiftDay(TODAY, -1);
    await waitFor(() => expect(expenseUrls().at(-1)).toContain(`from=${yesterday}`));
    expect(screen.getByText('Yesterday')).toBeOnTheScreen();
  });

  it('cannot step into the future', async () => {
    mockScreen();
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());
    expect(screen.getByLabelText('next-day')).toHaveProp('accessibilityState', expect.objectContaining({ disabled: true }));
  });

  it('debounces the search — one request for the word, not one per keystroke', async () => {
    mockScreen();
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());
    const before = expenseUrls().length;

    await userEvent.type(screen.getByLabelText('search-expenses'), 'mill');
    await waitFor(() => expect(expenseUrls().at(-1)).toContain('q=mill'));

    // Four keystrokes, one round-trip. Without the debounce this is four.
    expect(expenseUrls().length - before).toBe(1);
  });

  it('admits when the total covers only the rows it got back', async () => {
    // The server pages at 200. Summing a page and calling it the period's
    // spend understates the money without saying so.
    mockFetchByPath({
      '/v1/expenses/vendors': () => ({ json: { vendors: [] } }),
      '/v1/expense-categories': () => ({ json: { categories: [] } }),
      '/v1/expenses': () => ({ json: { expenses: [EXPENSE], total: 412 } }),
      '/v1/me': () => ({
        json: { user_id: 'u1', email: 'o@c.com', name: 'O', active_permissions: ['expense:read'], memberships: [] },
      }),
    });
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());

    expect(screen.getByText('412 expenses')).toBeOnTheScreen();
    expect(screen.getByText(/Showing the latest 1\./)).toBeOnTheScreen();
  });

  it('says the enum in words — a row never reads "owner_cash"', async () => {
    mockScreen();
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());
    expect(screen.getByText(/Sita's cafe cash/)).toBeOnTheScreen();
  });
});

describe('owner-funded sources', () => {
  it('are not offered as a filter when the plan lacks owner finance', async () => {
    mockScreen({ features: [] });
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('open-filters'));
    await waitFor(() => expect(screen.getByTestId('expense-source-drawer')).toBeOnTheScreen());
    expect(screen.queryByTestId('expense-source-owner')).toBeNull();
    expect(screen.queryByTestId('expense-source-owner_cash')).toBeNull();
  });

  it('are offered once the plan and the role both allow them', async () => {
    mockScreen({
      perms: ['expense:read', 'expense:create', 'finance:read'],
      features: ['owner_finance'],
    });
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('open-filters'));
    await waitFor(() => expect(screen.getByTestId('expense-source-owner')).toBeOnTheScreen());
    expect(screen.getByTestId('expense-source-owner_cash')).toBeOnTheScreen();
  });
});

describe('permission gates', () => {
  it('hides both header actions from a member who may only read', async () => {
    mockScreen({ perms: ['expense:read'] });
    await renderWithProviders(<Expenses />);
    await waitFor(() => expect(screen.getByText('Local Mill')).toBeOnTheScreen());
    expect(screen.queryByLabelText('add-expense')).toBeNull();
    expect(screen.queryByLabelText('manage-categories')).toBeNull();
  });
});
