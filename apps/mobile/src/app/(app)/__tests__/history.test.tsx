/**
 * History: the day filters, what the expanded serve admits to, and fixing a
 * payment recorded with the wrong method after the tab was already settled —
 * the "they settled it online but it was paid in cash" case.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

// A reverse entry that re-opens the bill navigates to the new tab.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
}));

/* eslint-disable-next-line import/first -- import the screen after jest.mock() */
import History from '../history';

const ORDER = {
  id: 'o1',
  service_table_name: 'Table 4',
  opened_at: '2026-07-29T08:00:00Z',
  closed_at: '2026-07-29T09:22:00Z',
  notes: '',
  subtotal_cents: 35000,
  discount_cents: 0,
  tax_cents: 0,
  service_charge_cents: 0,
  total_cents: 35000,
  item_count: 1,
  items: [{ id: 'i1', menu_item_name: 'Momo', qty: '1', line_cents: 35000 }],
  payments: [
    // Recorded as online ('other' is how the API persists the online channel).
    { id: 'p1', method: 'other', amount_cents: 35000, reference_no: '', reclassifiable: true },
  ],
};

function mockHistory(perms: string[], orders: unknown[] = [ORDER]) {
  return mockFetchByPath({
    '/v1/me': () => ({
      json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] },
    }),
    '/v1/orders/history': () => ({ json: { orders, credit_collections: [] } }),
    '/v1/orders/o1/payments/p1/reclassify': (body) => ({ json: { id: 'p1', ...(body as object) } }),
    // Named differently from the order card's table on purpose: both render
    // their table's name, and a shared string makes every getByText ambiguous.
    '/v1/tables': () => ({
      json: { tables: [{ id: 't-4', name: 'T4', status: 'free', capacity: 4, sort: 0 }] },
    }),
  });
}

/** Every history URL the screen asked for, in order. */
const historyUrls = () =>
  (globalThis.fetch as jest.Mock).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/v1/orders/history'));

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('History payment reclassify', () => {
  it('swaps a settled payment from online to cash', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockHistory(['order:read', 'payment:reclassify']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    // The swap lives in the expanded body, not on the collapsed chips.
    expect(screen.queryByLabelText('reclassify-p1')).toBeNull();
    await user.press(screen.getByText('Table 4'));
    await user.press(screen.getByLabelText('reclassify-p1'));

    expect(screen.getByText('Change payment method')).toBeOnTheScreen();
    await user.press(screen.getByText('Switch to Cash'));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes('/payments/p1/reclassify'),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ method: 'cash' });
    });
  });

  it('offers no swap without payment:reclassify', async () => {
    const user = userEvent.setup();
    mockHistory(['order:read']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await user.press(screen.getByText('Table 4'));
    expect(screen.queryByLabelText('reclassify-p1')).toBeNull();
  });

  it('offers no swap once the shift has closed', async () => {
    const user = userEvent.setup();
    mockFetchByPath({
      '/v1/me': () => ({
        json: {
          user_id: 'u',
          email: 'a@b.c',
          name: 'A',
          active_permissions: ['order:read', 'payment:reclassify'],
          memberships: [],
        },
      }),
      '/v1/orders/history': () => ({
        json: {
          // The server's own gate — reconciliation is final after a close.
          orders: [{ ...ORDER, payments: [{ ...ORDER.payments[0], reclassifiable: false }] }],
          credit_collections: [],
        },
      }),
    });
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await user.press(screen.getByText('Table 4'));
    expect(screen.queryByLabelText('reclassify-p1')).toBeNull();
  });
});

describe('History day + table filters', () => {
  it('narrows to one table, and tells the server rather than filtering locally', async () => {
    // The server scopes the rows, so the summary above them stays honest.
    mockHistory(['order:read']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('history-table-t-4'));
    await waitFor(() => expect(historyUrls().at(-1)).toContain('table_id=t-4'));
  });

  it('says credit collected is a whole-day figure once a table filter is on', async () => {
    // The API omits collections entirely under a table filter — a tab belongs
    // to a person, not a table — so a zero there would be a lie.
    mockHistory(['order:read']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    await userEvent.press(screen.getByTestId('history-table-t-4'));
    await waitFor(() => expect(screen.getByText(/Credit collected is a whole-day figure/)).toBeOnTheScreen());
  });

  it('jumps to an arbitrary day without thirty taps on the arrow', async () => {
    mockHistory(['order:read']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('jump-to-day'));
    await waitFor(() => expect(screen.getByTestId('jump-yesterday')).toBeOnTheScreen());
    await userEvent.press(screen.getByTestId('jump-yesterday'));

    await waitFor(() => expect(screen.getByText('Yesterday')).toBeOnTheScreen());
  });
});

describe('the expanded serve', () => {
  const VOIDED = {
    ...ORDER,
    subtotal_cents: 40000,
    discount_cents: 5000,
    service_charge_cents: 4000,
    tax_cents: 5070,
    total_cents: 44070,
    item_count: 2,
    items: [
      { id: 'i1', menu_item_name: 'Momo', qty: '1', line_cents: 35000, notes: 'no chilli' },
      {
        id: 'i2',
        menu_item_name: 'Chiya',
        qty: '1',
        line_cents: 5000,
        notes: '',
        voided_at: '2026-07-29T09:00:00Z',
        void_reason: 'sent by mistake',
      },
    ],
  };

  it('keeps voided lines visible, with why', async () => {
    // Hiding them made an order look like it was always what it ended as.
    mockHistory(['order:read'], [VOIDED]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Table 4'));

    expect(screen.getByText(/Chiya/)).toBeOnTheScreen();
    expect(screen.getByText(/voided: sent by mistake/)).toBeOnTheScreen();
  });

  it('shows the item note — the only record of how the dish left the kitchen', async () => {
    mockHistory(['order:read'], [VOIDED]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Table 4'));

    expect(screen.getByText('no chilli')).toBeOnTheScreen();
  });

  it('prints the bill as it was charged, not just the total', async () => {
    mockHistory(['order:read'], [VOIDED]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Table 4'));

    expect(screen.getByText('Subtotal')).toBeOnTheScreen();
    expect(screen.getByText('Discount')).toBeOnTheScreen();
    expect(screen.getByText('Service charge')).toBeOnTheScreen();
    expect(screen.getByText('VAT')).toBeOnTheScreen();
    expect(screen.getByText('Total')).toBeOnTheScreen();
    expect(screen.getByText('−Rs 50')).toBeOnTheScreen();
  });

  it('omits the charge rows the cafe did not levy', async () => {
    mockHistory(['order:read']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Table 4'));

    expect(screen.getByText('Subtotal')).toBeOnTheScreen();
    expect(screen.queryByText('VAT')).toBeNull();
    expect(screen.queryByText('Service charge')).toBeNull();
    expect(screen.queryByText('Discount')).toBeNull();
  });

  // A settled line has to explain its own price. The ticket, the kitchen docket
  // and the printed receipt all itemise add-ons; History showed "1× Momo
  // Rs 115" and left the extra 15 unaccounted for.
  const WITH_ADD_ONS = {
    ...ORDER,
    subtotal_cents: 11500,
    total_cents: 11500,
    items: [
      {
        id: 'i1',
        menu_item_name: 'Momo',
        qty: '1',
        line_cents: 11500,
        base_price_cents: 10000,
        notes: '',
        add_ons: [
          { id: 'a1', modifier_id: 'm1', name: 'cheese slice', qty: 1, price_cents: 1500 },
          { id: 'a2', modifier_id: 'm2', name: 'pepper', qty: 1, price_cents: 0 },
        ],
      },
    ],
  };

  it('itemises add-ons under the dish, so the price is explainable', async () => {
    mockHistory(['order:read'], [WITH_ADD_ONS]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Table 4'));

    expect(screen.getByText(/cheese slice/)).toBeOnTheScreen();
    expect(screen.getByText('Rs 15')).toBeOnTheScreen();
  });

  it('prints a free choice with no amount — a bare Rs 0 reads as a charge', async () => {
    mockHistory(['order:read'], [WITH_ADD_ONS]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Table 4'));

    expect(screen.getByText(/pepper/)).toBeOnTheScreen();
    expect(screen.queryByText('Rs 0')).toBeNull();
  });
});

describe('the day summary', () => {
  it('reports the average ticket and what else the day did', async () => {
    mockHistory(['order:read'], [
      { ...ORDER, id: 'o1', total_cents: 35000, item_count: 2, discount_cents: 1000 },
      { ...ORDER, id: 'o2', total_cents: 15000, item_count: 1, tax_cents: 1950 },
    ]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('2 orders')).toBeOnTheScreen());

    expect(screen.getByText('Rs 250 average ticket')).toBeOnTheScreen();
    expect(screen.getByText(/3 items sold/)).toBeOnTheScreen();
    expect(screen.getByText(/Discounts Rs 10/)).toBeOnTheScreen();
    expect(screen.getByText(/VAT Rs 19.5/)).toBeOnTheScreen();
  });

  it('flags voided items on the day', async () => {
    mockHistory(['order:read'], [
      {
        ...ORDER,
        items: [
          { id: 'i1', menu_item_name: 'Momo', qty: '1', line_cents: 35000, notes: '' },
          { id: 'i2', menu_item_name: 'Chiya', qty: '1', line_cents: 5000, notes: '', voided_at: 'x' },
        ],
      },
    ]);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('1 voided item')).toBeOnTheScreen());
  });
});

describe('an IRD invoice on a settled serve', () => {
  const issuedAt = new Date().toISOString();
  const INVOICE = {
    id: 'inv1', order_id: 'o1', kind: 'tax_invoice', fiscal_year: '2083/84', seq: 7, number: '7',
    issued_at: issuedAt, bs_date: '2083-07-22', ad_date: '2026-11-08',
    seller_pan: '999999999', seller_name: 'Demo Cafe', seller_name_ne: '', seller_address: 'Kathmandu',
    seller_phone: '', outlet_code: '', buyer_name: '', buyer_pan: '', buyer_address: '',
    gross_cents: 30973, discount_cents: 0, taxable_cents: 30973, non_taxable_cents: 0, vat_cents: 4027,
    total_cents: 35000, vat_rate: '13.00', payment_method: 'Cash', transaction_id: '',
    issued_by_name: 'A', software_version: 'Go Serve 0.9.0', qr_payload: 'x', content_hash: 'h',
    lines: [{ line_no: 1, description: 'Momo', qty: '1.00', unit_price_cents: 35000, amount_cents: 35000 }],
  };
  const invoiced = {
    ...ORDER,
    invoice: { id: 'inv1', number: '7', fiscal_year: '2083/84', kind: 'tax_invoice' },
    payments: [{ id: 'p1', method: 'cash', amount_cents: 35000, reference_no: '', reclassifiable: false }],
  };

  function mockFiscal(perms: string[]) {
    return mockFetchByPath({
      '/v1/me': () => ({
        json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] },
      }),
      '/v1/orders/history': () => ({ json: { orders: [invoiced], credit_collections: [] } }),
      '/v1/invoices/inv1/credit-notes': (body) => ({
        status: 201,
        json: {
          ...INVOICE, id: 'cn1', invoice_id: 'inv1', invoice_number: '7', invoice_fiscal_year: '2083/84',
          invoice_bs_date: '2083-07-22', kind: 'reversal', number: 'RE-1', reason: 'x',
          refund_method: 'cash', lines: [], reopened_order_id: (body as { reopen?: boolean }).reopen ? 'o2' : undefined,
        },
      }),
      '/v1/invoices/inv1': () => ({
        json: {
          invoice: INVOICE,
          prints: [{ copy_no: 1, label: 'ORIGINAL', printed_by_name: 'A', printed_at: issuedAt }],
          cbms: { status: 'synced', attempts: 1, synced_via: 'mock' },
          credit_notes: [],
          active: true,
        },
      }),
    });
  }

  it('shows its IRD status honestly — a mock sync is not "reported"', async () => {
    const user = userEvent.setup();
    mockFiscal(['order:read', 'fiscal:print']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    expect(screen.getByText('Tax inv. 7')).toBeOnTheScreen();
    await user.press(screen.getByText('Table 4'));
    await waitFor(() => expect(screen.getByText('Demo sync only')).toBeOnTheScreen());
    expect(screen.getByText('Printed 1×')).toBeOnTheScreen();
    // No fiscal:correct, no way to correct it.
    expect(screen.queryByText('Return / cancel')).toBeNull();
  });

  it('cancels a same-day bill with a reason and re-opens it to settle again', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFiscal(['order:read', 'fiscal:print', 'fiscal:correct']);
    await renderWithProviders(<History />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());
    await user.press(screen.getByText('Table 4'));
    await user.press(await screen.findByText('Return / cancel'));

    expect(screen.getByText('Correct bill 7')).toBeOnTheScreen();
    await user.press(screen.getByText('Wrong payment method'));
    await user.press(screen.getByTestId('correction-reopen'));
    await user.press(screen.getByText(/Issue reverse entry/));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/v1/invoices/inv1/credit-notes'));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        kind: 'reversal',
        reason: 'Wrong payment method',
        refund_method: 'cash',
        reopen: true,
      });
    });
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/floor/[orderId]', params: { orderId: 'o2' } }),
    );
  });
});
