/**
 * What the expense form actually sends, and which sources it dares offer.
 *
 * These are money writes into four different ledgers, and three of the fields
 * involved are immutable once recorded — so the payload is the contract, not
 * an implementation detail.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { ExpenseForm } from '../ExpenseForm';

const OWNERS = [{ id: 'o1', display_name: 'Sita', share_units: 60 }];

const EXISTING = {
  id: 'e1',
  expense_category_id: null,
  expense_category_name: null,
  vendor: 'Local Mill',
  amount_cents: 45000,
  paid_at: '2026-09-01T08:30:00Z',
  payment_method: 'cash',
  reference_no: 'INV-9',
  notes: 'flour',
  recorded_by_user_id: 'u1',
  created_at: '2026-09-01T08:30:00Z',
  paid_from: 'owner_cash' as const,
  owner_id: 'o1',
  owner_name: 'Sita',
  paid_from_drawer: false,
};

function mockRoutes({
  perms = ['expense:read', 'expense:create', 'expense:update', 'expense:delete', 'finance:read', 'shift:read'],
  features = ['owner_finance'],
  shiftOpen = true,
} = {}) {
  return mockFetchByPath({
    '/v1/expenses/vendors': () => ({ json: { vendors: ['Local Mill'] } }),
    '/v1/expense-categories': () => ({ json: { categories: [] } }),
    '/v1/expenses': () => ({ json: { id: 'e-new' } }),
    '/v1/shifts/current': () => ({
      json: shiftOpen ? { id: 's1', opened_at: '2026-09-09T06:00:00Z', closed_at: null } : null,
    }),
    '/v1/finance/owner-cash': () => ({
      json: { holdings: [{ owner_id: 'o1', display_name: 'Sita', holding_cents: 100000, active: true }], entries: [] },
    }),
    '/v1/finance/cafe-balance': () => ({ json: { bank_cents: 500000, channels: [] } }),
    '/v1/finance/owners': () => ({ json: { owners: OWNERS } }),
    '/v1/inventory': () => ({ json: { items: [] } }),
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

/** The body of the first write to `path`. */
function bodyOf(method: string, path: string): Record<string, unknown> | undefined {
  const call = (globalThis.fetch as jest.Mock).mock.calls.find(
    (c) => String(c[0]).includes(path) && (c[1]?.method ?? 'GET').toUpperCase() === method,
  );
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('recording', () => {
  it('sends the owner alongside an owner-funded source', async () => {
    // Without owner_id the server has no one to owe, and the write 400s.
    mockRoutes();
    await renderWithProviders(<ExpenseForm expense={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Owner's cafe cash")).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('Amount'), '250');
    await userEvent.press(screen.getByLabelText("Owner's cafe cash"));
    await waitFor(() => expect(screen.getByTestId('expense-owner-o1')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Record expense'));

    await waitFor(() => expect(bodyOf('POST', '/v1/expenses')).toBeDefined());
    const body = bodyOf('POST', '/v1/expenses')!;
    expect(body.paid_from).toBe('owner_cash');
    expect(body.owner_id).toBe('o1');
    expect(body.amount_cents).toBe(25000);
    // Recorded at a real instant, not left for the server to guess.
    expect(typeof body.paid_at).toBe('string');
  });

  it('warns when the owner is not holding that much cafe cash', async () => {
    mockRoutes();
    await renderWithProviders(<ExpenseForm expense={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Owner's cafe cash")).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('Amount'), '2000');
    await userEvent.press(screen.getByLabelText("Owner's cafe cash"));

    await waitFor(() =>
      expect(screen.getByText(/only holding Rs 1,000 of cafe cash/)).toBeOnTheScreen(),
    );
  });

  it('falls back to bank when no shift is open, and says the drawer is unavailable', async () => {
    // Picking the drawer with the shift closed is a guaranteed 409.
    mockRoutes({ shiftOpen: false });
    await renderWithProviders(<ExpenseForm expense={null} onClose={jest.fn()} />);
    // The tile starts enabled and only closes once the shift read ANSWERS —
    // "not loaded yet" must never masquerade as "no shift open".
    await waitFor(() =>
      expect(screen.getByLabelText('Cash drawer')).toHaveProp(
        'accessibilityState',
        expect.objectContaining({ disabled: true }),
      ),
    );
    expect(screen.getByLabelText('Bank')).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByText('no shift open')).toBeOnTheScreen();
  });

  it('keeps the drawer as the default while a shift is open', async () => {
    mockRoutes({ shiftOpen: true });
    await renderWithProviders(<ExpenseForm expense={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('cash from the till')).toBeOnTheScreen());

    expect(screen.getByLabelText('Cash drawer')).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ selected: true, disabled: false }),
    );
  });

  it('hides owner sources entirely when the plan does not include owner finance', async () => {
    mockRoutes({ features: [] });
    await renderWithProviders(<ExpenseForm expense={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Bank')).toBeOnTheScreen());

    expect(screen.queryByLabelText('Owner paid')).toBeNull();
    expect(screen.queryByLabelText("Owner's cafe cash")).toBeNull();
  });

  it('never asks for owner finance the plan cannot serve', async () => {
    // A 403 per render is not a graceful degradation.
    mockRoutes({ features: [] });
    await renderWithProviders(<ExpenseForm expense={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Bank')).toBeOnTheScreen());

    const urls = (globalThis.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/v1/finance/owners'))).toBe(false);
    expect(urls.some((u) => u.includes('/v1/finance/owner-cash'))).toBe(false);
  });
});

describe('editing', () => {
  it('sends the editable fields and NEVER the ones the server calls immutable', async () => {
    mockRoutes();
    await renderWithProviders(<ExpenseForm expense={EXISTING} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Save changes')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Save changes'));
    await waitFor(() => expect(bodyOf('PATCH', '/v1/expenses/e1')).toBeDefined());

    const body = bodyOf('PATCH', '/v1/expenses/e1')!;
    expect(body).toHaveProperty('reference_no', 'INV-9');
    expect(body).toHaveProperty('paid_at');
    // A phone edit must not wipe a cost-centre split set on the dashboard, and
    // must not try to move the money to a different account.
    expect(Object.keys(body)).not.toContain('allocations');
    expect(Object.keys(body)).not.toContain('paid_from');
    expect(Object.keys(body)).not.toContain('owner_id');
  });

  it('shows the payment source read-only, and says why it is stuck', async () => {
    mockRoutes();
    await renderWithProviders(<ExpenseForm expense={EXISTING} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Sita's cafe cash")).toBeOnTheScreen());

    expect(screen.queryByLabelText('Cash drawer')).toBeNull();
    expect(screen.getByText(/Can't be changed/)).toBeOnTheScreen();
  });
});
