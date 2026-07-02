import type { OrderItemRow, SettleQuote, TenantPreferences } from '@cafe-mgmt/api-types';
import { shouldPrintReceipt, printReceipt } from '../receipt';
import type { PrinterTarget } from '../printerConfig';
import { printBytes } from '../tcpPrinter';

jest.mock('../tcpPrinter', () => ({ printBytes: jest.fn().mockResolvedValue(undefined) }));

const prefs = (over: Partial<TenantPreferences>): TenantPreferences =>
  ({ printingEnabled: true, printCustomerReceipt: true, ...over }) as TenantPreferences;

describe('shouldPrintReceipt', () => {
  it('prints when printing enabled + receipt toggle on', () => {
    expect(shouldPrintReceipt(prefs({}))).toBe(true);
  });

  it('is false when the tenant receipt toggle is off', () => {
    expect(shouldPrintReceipt(prefs({ printCustomerReceipt: false }))).toBe(false);
  });

  it('is false when printing is disabled entirely', () => {
    expect(shouldPrintReceipt(prefs({ printingEnabled: false }))).toBe(false);
  });

  it('is false when prefs are undefined', () => {
    expect(shouldPrintReceipt(undefined)).toBe(false);
  });
});

describe('printReceipt', () => {
  const target: PrinterTarget = { ip: '192.168.1.50', port: 9100, width: '80' };
  const item: OrderItemRow = {
    id: 'i1',
    order_id: 'o1',
    menu_item_id: 'm1',
    menu_item_name: 'Coffee',
    qty: 1,
    unit_price_cents: 500,
    line_cents: 500,
    modifiers: null,
    notes: '',
    kitchen_status: 'ready',
    created_at: '',
  };
  const quote: SettleQuote = {
    subtotal_cents: 500,
    discount_cents: 0,
    service_charge_cents: 0,
    tax_cents: 0,
    total_cents: 500,
    paid_cents: 500,
    balance_cents: 0,
    service_charge_pct: '0',
    vat_pct: '0',
    vat_mode: 'none',
  };

  it('builds ESC/POS bytes and writes them to the printer at its IP:port', async () => {
    await printReceipt(
      {
        items: [item],
        quote,
        payments: [{ method: 'cash', amount_cents: 500 }],
        tableLabel: 'Table 1',
        header: 'Sahan Cafe',
        footer: 'Thanks',
        orderId: 'abc123',
      },
      target,
    );

    expect(printBytes).toHaveBeenCalledTimes(1);
    const [ip, port, bytes] = (printBytes as jest.Mock).mock.calls[0];
    expect(ip).toBe('192.168.1.50');
    expect(port).toBe(9100);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // ESC @ init prefix, GS V cut suffix — proves real command bytes were built.
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });
});
