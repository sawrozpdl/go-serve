import { beforeAll, describe, expect, it } from 'vitest';
import type { OrderItemRow, Payment, SettleQuote } from '@cafe-mgmt/api-types';
import { resolveTableLabel } from '@cafe-mgmt/api-types';

// printing.ts transitively reads navigator.userAgent (detectSetupPlatform) even
// for the pure HTML builders, so stub it before importing the module.
beforeAll(() => {
  // @ts-expect-error minimal stub for the node test env
  globalThis.navigator = { userAgent: 'node-test' };
});

async function loadReceiptHTML() {
  const mod = await import('./printing');
  return mod.receiptHTML;
}

const quote: SettleQuote = {
  subtotal_cents: 1000,
  discount_cents: 0,
  service_charge_cents: 0,
  tax_cents: 0,
  total_cents: 1000,
  paid_cents: 1000,
  balance_cents: 0,
  service_charge_pct: '0',
  vat_pct: '0',
  vat_mode: 'none',
};

const items = [
  { id: 'i1', menu_item_name: 'Espresso', qty: 1, line_cents: 1000, notes: '' },
] as unknown as OrderItemRow[];

const payments = [
  { id: 'p1', method: 'cash', amount_cents: 1000 },
] as unknown as Payment[];

const baseArgs = {
  items,
  quote,
  payments,
  tableLabel: 'Table 4',
  header: 'Sahan Cafe',
  footer: 'Thank you!',
  width: '80' as const,
  orderId: 'abcdef123456',
  closedAt: '2026-07-19T10:00:00.000Z',
};

describe('receiptHTML', () => {
  it('renders the receipt image block just above the footer when imageUrl is set', async () => {
    const receiptHTML = await loadReceiptHTML();
    const html = receiptHTML({ ...baseArgs, imageUrl: 'https://cdn.example/qr.png' });
    expect(html).toContain('<div class="center receipt-img">');
    expect(html).toContain('https://cdn.example/qr.png');
    // The image element must sit before the footer text.
    expect(html.indexOf('<img src="https://cdn.example/qr.png"')).toBeLessThan(
      html.indexOf('Thank you!'),
    );
  });

  it('omits the image element when no imageUrl is set', async () => {
    const receiptHTML = await loadReceiptHTML();
    const html = receiptHTML(baseArgs);
    // The style rule for .receipt-img is always present; the rendered element is not.
    expect(html).not.toContain('<div class="center receipt-img">');
  });

  it('prints the resolved table label', async () => {
    const receiptHTML = await loadReceiptHTML();
    const html = receiptHTML(baseArgs);
    expect(html).toContain('Table 4');
  });

  it('renders the image caption when imageLabel is set', async () => {
    const receiptHTML = await loadReceiptHTML();
    const html = receiptHTML({
      ...baseArgs,
      imageUrl: 'https://cdn.example/qr.png',
      imageLabel: 'Use this QR to pay',
    });
    expect(html).toContain('receipt-img-label');
    expect(html).toContain('Use this QR to pay');
  });

  it('omits the caption when there is no image', async () => {
    const receiptHTML = await loadReceiptHTML();
    const html = receiptHTML({ ...baseArgs, imageLabel: 'orphan caption' });
    expect(html).not.toContain('orphan caption');
  });
});

describe('resolveTableLabel', () => {
  it('prefers the real service table name', () => {
    expect(resolveTableLabel({ service_table_name: 'Table 7', table_label: 'x' })).toBe('Table 7');
  });

  it('falls back to a trimmed table_label for walk-ins', () => {
    expect(resolveTableLabel({ service_table_name: null, table_label: '  Ramesh  ' })).toBe('Ramesh');
  });

  it('uses the provided fallback when neither is present', () => {
    expect(resolveTableLabel({ service_table_name: null, table_label: '' }, 'Walk-in')).toBe('Walk-in');
  });
});
