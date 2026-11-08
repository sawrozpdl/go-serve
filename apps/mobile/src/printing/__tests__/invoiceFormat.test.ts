import type { CreditNote, Invoice } from '@cafe-mgmt/api-types';
import {
  buildCreditNoteCommands,
  buildInvoiceCommands,
  buildKitchenDocketCommands,
  buildReceiptCommands,
  EscPosBuilder,
} from '@cafe-mgmt/receipt-format';

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

const note: CreditNote = {
  id: 'cn1',
  invoice_id: 'inv1',
  invoice_number: 'KTM-42',
  invoice_fiscal_year: '2083/84',
  invoice_bs_date: '2083-07-21',
  kind: 'reversal',
  fiscal_year: '2083/84',
  seq: 3,
  number: 'KTM-RE-3',
  issued_at: '2026-11-07T09:05:00Z', // 14:50 NPT
  bs_date: '2083-07-21',
  ad_date: '2026-11-07',
  reason: 'Wrong payment method',
  seller_pan: '601234567',
  seller_name: 'Sahan Cafe Pvt. Ltd.',
  seller_address: 'Thamel, Kathmandu',
  buyer_name: '',
  buyer_pan: '',
  gross_cents: 100000,
  discount_cents: 10000,
  taxable_cents: 90000,
  non_taxable_cents: 0,
  vat_cents: 11700,
  total_cents: 101700,
  vat_rate: '13.00',
  refund_method: 'cash',
  issued_by_name: 'Sita',
  software_version: 'Go Serve 0.9.0',
  qr_payload: 'Seller PAN: 601234567\nCredit Note: KTM-RE-3',
  content_hash: 'y'.repeat(64),
  lines: [{ line_no: 1, invoice_line_no: 1, description: 'Chicken Momo', qty: '2.00', unit_price_cents: 56500, amount_cents: 113000 }],
};

describe('buildCreditNoteCommands', () => {
  for (const width of ['58', '80'] as const) {
    it(`prints the reference to the bill, the reason and the refund (${width}mm)`, () => {
      const bytes = buildCreditNoteCommands({
        note,
        label: { copy_no: 1, title: 'REVERSE ENTRY', copy_label: 'ORIGINAL' },
        width,
      });
      const text = decode(bytes);
      for (const want of [
        'REVERSE ENTRY',
        '[ ORIGINAL ]',
        'KTM-RE-3',
        'KTM-42',
        '2083-07-21 BS 14:50',
        'Wrong payment method',
        '2x Chicken Momo',
        'VAT 13%',
        'TOTAL CREDITED',
        'Rupees One Thousand',
        'Cash',
        'Issued by: Sita',
      ]) {
        expect(text).toContain(want);
      }
      // Text rows never run wider than the paper (rows that start with
      // escape-code residue are skipped — decode() keeps printable arg bytes).
      const cols = width === '58' ? 32 : 48;
      for (const line of text.split('\n')) {
        if (/^(No|Fiscal|Date|AD|Against|Bill|Buyer|Reason|Amount|Taxable|VAT|TOTAL|Refunded|Rupees|[0-9]+x )/.test(line)) {
          expect(line.length).toBeLessThanOrEqual(cols);
        }
      }
      expect(indexOfSeq(bytes, [0x31, 0x50, 0x30])).toBeGreaterThan(0);
    });
  }
});

describe('kitchen docket KOT number', () => {
  const items = [
    {
      id: 'i1', order_id: 'o1', menu_item_id: 'm1', menu_item_name: 'Chicken Momo', qty: 1,
      unit_price_cents: 25000, line_cents: 25000, modifiers: null, notes: '',
      kitchen_status: 'pending' as const, created_at: '',
    },
  ];
  it('prints the server slip number when given', () => {
    const text = decode(
      buildKitchenDocketCommands({ items, tableLabel: 'T1', width: '80', now: new Date(0), kotNumber: 'KOT-17' }),
    );
    expect(text).toContain('KOT-17');
  });
  it('says the number comes on sync for an offline send', () => {
    const text = decode(
      buildKitchenDocketCommands({ items, tableLabel: 'T1', width: '80', now: new Date(0), kotPending: true }),
    );
    expect(text).toContain('KOT no. given on sync');
  });
  it('prints neither for a plain café', () => {
    const text = decode(buildKitchenDocketCommands({ items, tableLabel: 'T1', width: '80', now: new Date(0) }));
    expect(text).not.toContain('KOT');
  });
});
