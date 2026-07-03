/**
 * Customer-receipt printing. Prints on settle-close when printing is enabled and
 * the receipt toggle is on; which printer(s) receive it comes from the tenant
 * config (see `receiptTargets`). The caller snapshots the args BEFORE closing
 * (close finalizes totals server-side and refetches).
 */
import { buildReceiptCommands, type ReceiptPayment } from '@cafe-mgmt/receipt-format';
import type { OrderItemRow, SettleQuote, TenantPreferences, TenantSettings } from '@cafe-mgmt/api-types';
import { printBytes } from './tcpPrinter';
import type { PrinterTarget } from './printerConfig';

export function shouldPrintReceipt(prefs: TenantPreferences | undefined): boolean {
  return !!prefs?.printingEnabled && !!prefs?.printCustomerReceipt;
}

// Fabricated line items for "Test print" — chosen only to exercise every
// receipt feature (multi-qty, a note line) with round numbers.
const SAMPLE_ITEMS: OrderItemRow[] = [
  {
    id: 'sample-1',
    order_id: 'sample',
    menu_item_id: 'm1',
    menu_item_name: 'Cappuccino',
    qty: 2,
    unit_price_cents: 18000,
    line_cents: 36000,
    modifiers: null,
    notes: '',
    kitchen_status: 'served',
    created_at: '',
  },
  {
    id: 'sample-2',
    order_id: 'sample',
    menu_item_id: 'm2',
    menu_item_name: 'Chicken Momo',
    qty: 1,
    unit_price_cents: 25000,
    line_cents: 25000,
    modifiers: null,
    notes: 'Extra spicy',
    kitchen_status: 'served',
    created_at: '',
  },
];

export type TenantTaxInfo = Pick<TenantSettings, 'name' | 'vat_mode' | 'vat_pct' | 'service_charge_pct'>;

function sampleQuote(tenant: TenantTaxInfo): SettleQuote {
  const subtotal = SAMPLE_ITEMS.reduce((sum, it) => sum + it.line_cents, 0);
  const svcPct = parseFloat(tenant.service_charge_pct) || 0;
  const vatPct = parseFloat(tenant.vat_pct) || 0;
  const serviceChargeCents = svcPct > 0 ? Math.round(subtotal * (svcPct / 100)) : 0;

  let taxCents = 0;
  let totalCents = subtotal + serviceChargeCents;
  if (tenant.vat_mode === 'exclusive' && vatPct > 0) {
    taxCents = Math.round((subtotal + serviceChargeCents) * (vatPct / 100));
    totalCents += taxCents;
  } else if (tenant.vat_mode === 'inclusive' && vatPct > 0) {
    // VAT is already inside the item prices; extract it for the Net/VAT rows.
    taxCents = Math.round(subtotal - subtotal / (1 + vatPct / 100));
  }

  return {
    subtotal_cents: subtotal,
    discount_cents: 0,
    service_charge_cents: serviceChargeCents,
    tax_cents: taxCents,
    total_cents: totalCents,
    paid_cents: totalCents,
    balance_cents: 0,
    service_charge_pct: tenant.service_charge_pct,
    vat_pct: tenant.vat_pct,
    vat_mode: tenant.vat_mode,
  };
}

/**
 * Print a fabricated but realistic receipt — same header/footer/VAT config
 * and the same `buildReceiptCommands` builder as a real settle-close receipt
 * (which itself mirrors web's `receiptHTML`), so what comes out matches what
 * a real customer receipt (and web's window.print()) would produce.
 */
export async function printSampleReceipt(
  printer: PrinterTarget,
  tenant: TenantTaxInfo,
  prefs: TenantPreferences | undefined,
): Promise<void> {
  const quote = sampleQuote(tenant);
  const bytes = buildReceiptCommands({
    items: SAMPLE_ITEMS,
    quote,
    payments: [{ method: 'cash', amount_cents: quote.total_cents }],
    tableLabel: 'Sample',
    header: (prefs?.receiptHeader || tenant.name || '').trim(),
    footer: (prefs?.receiptFooter || '').trim(),
    orderId: 'testprint',
    width: printer.width,
    now: new Date(),
  });
  await printBytes(printer.ip, printer.port, bytes);
}

export type ReceiptContent = {
  items: OrderItemRow[];
  quote: SettleQuote;
  payments: ReceiptPayment[];
  tableLabel: string;
  header: string;
  footer: string;
  orderId: string;
  closedAt?: string | null;
  reprint?: boolean;
};

export async function printReceipt(content: ReceiptContent, printer: PrinterTarget): Promise<void> {
  const bytes = buildReceiptCommands({
    ...content,
    width: printer.width,
    now: new Date(),
  });
  await printBytes(printer.ip, printer.port, bytes);
}
