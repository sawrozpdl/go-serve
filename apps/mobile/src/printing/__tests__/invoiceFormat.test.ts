import type { Invoice } from '@cafe-mgmt/api-types';
import { buildInvoiceCommands, buildReceiptCommands, EscPosBuilder } from '@cafe-mgmt/receipt-format';

function decode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x0a) out += '\n';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
  }
  return out;
}

function indexOfSeq(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const invoice: Invoice = {
  id: 'inv1',
  order_id: 'o1',
  kind: 'tax_invoice',
  fiscal_year: '2083/84',
  seq: 42,
  number: 'KTM-42',
  issued_at: '2026-11-07T08:50:00Z', // 14:35 NPT
  bs_date: '2083-07-21',
  ad_date: '2026-11-07',
  seller_pan: '601234567',
  seller_name: 'Sahan Cafe Pvt. Ltd.',
  seller_name_ne: '',
  seller_address: 'Thamel, Kathmandu',
  seller_phone: '01-4444444',
  outlet_code: 'KTM',
  buyer_name: 'Acme Traders',
  buyer_pan: '609876543',
  buyer_address: '',
  gross_cents: 100000,
  discount_cents: 10000,
  taxable_cents: 90000,
  non_taxable_cents: 0,
  vat_cents: 11700,
  total_cents: 101700,
  vat_rate: '13.00',
  payment_method: 'Cash',
  transaction_id: '',
  issued_by_name: 'Ramesh',
  software_version: 'Go Serve 0.9.0',
  qr_payload: 'Seller PAN: 601234567\nBill No: KTM-42',
  content_hash: 'x'.repeat(64),
  lines: [{ line_no: 1, description: 'Chicken Momo', qty: '2.00', unit_price_cents: 56500, amount_cents: 113000 }],
};

describe('buildInvoiceCommands', () => {
  const bytes = buildInvoiceCommands({
    invoice,
    label: { copy_no: 1, title: 'TAX INVOICE', copy_label: 'ORIGINAL' },
    width: '80',
    footer: 'Thank you!',
  });
  const text = decode(bytes);

  it('prints every Annex 6 field', () => {
    for (const want of [
      'Sahan Cafe Pvt. Ltd.',
      'PAN/VAT No: 601234567',
      'TAX INVOICE',
      '[ ORIGINAL ]',
      'KTM-42',
      '2083/84',
      '2083-07-21 BS 14:35',
      '2026-11-07',
      'Acme Traders',
      '609876543',
      '2x Chicken Momo',
      'Discount (10.00%)',
      'Taxable amount',
      'VAT 13%',
      'TOTAL',
      'Rupees One Thousand Seventeen Only',
      'Issued by: Ramesh',
      'Go Serve 0.9.0',
      'Thank you!',
    ]) {
      expect(text).toContain(want);
    }
  });

  it('embeds a native QR with the frozen payload', () => {
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])).toBeGreaterThanOrEqual(0);
    const store = indexOfSeq(bytes, [0x31, 0x50, 0x30]);
    const payload = invoice.qr_payload;
    expect(bytes[store - 2]).toBe((payload.length + 3) & 0xff);
    expect(decode(bytes.slice(store + 3, store + 3 + payload.length))).toBe(payload);
    expect(indexOfSeq(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])).toBeGreaterThan(store);
  });

  it('does not call itself "not a tax invoice"', () => {
    expect(text).not.toContain('not a tax invoice');
  });
});

describe('EscPosBuilder.qr', () => {
  it('replaces non-ASCII with ?', () => {
    const b = new EscPosBuilder('80').qr('Rs ₹1').toBytes();
    expect(decode(b)).toContain('Rs ?1');
  });
});

describe('plain receipts', () => {
  it('say they are not a tax invoice', () => {
    const bytes = buildReceiptCommands({
      items: [],
      quote: {
        subtotal_cents: 0, discount_cents: 0, service_charge_cents: 0, tax_cents: 0, total_cents: 0,
        paid_cents: 0, balance_cents: 0, service_charge_pct: '0', vat_pct: '13', vat_mode: 'none',
      },
      payments: [],
      tableLabel: 'T1',
      header: '',
      footer: '',
      width: '80',
      orderId: 'abcdefgh',
      now: new Date(0),
    });
    expect(decode(bytes)).toContain('This is not a tax invoice');
  });
});
