import type { OrderItemRow, SettleQuote, TenantPreferences } from '@cafe-mgmt/api-types';
import { shouldPrintReceipt, printReceipt, printSampleReceipt, type TenantTaxInfo } from '../receipt';
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

describe('printSampleReceipt', () => {
  const target: PrinterTarget = { ip: '192.168.1.50', port: 9100, width: '80' };

  beforeEach(() => (printBytes as jest.Mock).mockClear());

  const bytesFromLastCall = () => (printBytes as jest.Mock).mock.calls.at(-1)![2] as Uint8Array;

  it('exclusive VAT + service charge: builds real command bytes, header falls back to tenant name', async () => {
    const tenant: TenantTaxInfo = {
      name: 'Sahan Cafe',
      vat_mode: 'exclusive',
      vat_pct: '13',
      service_charge_pct: '10',
    };
    await printSampleReceipt(target, tenant, undefined);

    expect(printBytes).toHaveBeenCalledTimes(1);
    const bytes = bytesFromLastCall();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });

  it('inclusive VAT, no service charge: uses prefs header/footer', async () => {
    const tenant: TenantTaxInfo = {
      name: 'Sahan Cafe',
      vat_mode: 'inclusive',
      vat_pct: '13',
      service_charge_pct: '0',
    };
    const prefs = { receiptHeader: 'Custom Header', receiptFooter: 'Come again' } as TenantPreferences;
    await printSampleReceipt(target, tenant, prefs);

    expect(printBytes).toHaveBeenCalledTimes(1);
    expect(bytesFromLastCall()).toBeInstanceOf(Uint8Array);
  });

  it('no VAT/service charge and blank tenant name: header falls back to empty string', async () => {
    const tenant: TenantTaxInfo = {
      name: '',
      vat_mode: 'none',
      vat_pct: '',
      service_charge_pct: '',
    };
    await printSampleReceipt(target, tenant, undefined);

    expect(printBytes).toHaveBeenCalledTimes(1);
    expect(bytesFromLastCall()).toBeInstanceOf(Uint8Array);
  });
});
