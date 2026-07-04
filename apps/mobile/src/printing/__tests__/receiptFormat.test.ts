import type { OrderItemRow, SettleQuote } from '@cafe-mgmt/api-types';
import {
  encodeText,
  twoCol,
  EscPosBuilder,
  buildKitchenDocketCommands,
  formatReceiptMoney,
  trimPct,
  computeReceiptTotals,
  buildReceiptCommands,
} from '@cafe-mgmt/receipt-format';

// Decode a byte stream to a printable string: keep printable ASCII (0x20-0x7E)
// and turn LF (0x0A) into newlines; drop all other control bytes.
function decode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x0a) out += '\n';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
  }
  return out;
}

const item = (over: Partial<OrderItemRow>): OrderItemRow => ({
  id: 'i1',
  order_id: 'o1',
  menu_item_id: 'm1',
  menu_item_name: 'Coffee',
  qty: 1,
  unit_price_cents: 0,
  line_cents: 0,
  modifiers: null,
  notes: '',
  kitchen_status: 'pending' as OrderItemRow['kitchen_status'],
  created_at: '',
  ...over,
});

describe('encodeText', () => {
  it('maps typographic chars and drops unknowns', () => {
    expect(Array.from(encodeText('×'))).toEqual(['x'.charCodeAt(0)]);
    expect(Array.from(encodeText('»'))).toEqual(['>'.charCodeAt(0)]);
    // Unknown non-ASCII (e.g. emoji) -> '?'
    expect(Array.from(encodeText('☃'))).toEqual(['?'.charCodeAt(0)]);
  });

  it('passes ASCII through', () => {
    const s = 'Coffee 2x';
    expect(Array.from(encodeText(s))).toEqual(
      s.split('').map((c) => c.charCodeAt(0)),
    );
  });
});

describe('twoCol', () => {
  it('pads to width with left/right justification', () => {
    const s = twoCol('Item', 'Rs 10', 20);
    expect(s.length).toBe(20);
    expect(s).toBe('Item           Rs 10');
  });
});

describe('EscPosBuilder', () => {
  it('emits init + codepage + bold-on and ends with feed-and-cut', () => {
    const bytes = new EscPosBuilder('80')
      .init()
      .bold(true)
      .line('HI')
      .cut()
      .toBytes();
    const arr = Array.from(bytes);
    // init (ESC @) + codepage (ESC t 0) + bold-on (ESC E 1)
    expect(arr.slice(0, 8)).toEqual([
      0x1b, 0x40, 0x1b, 0x74, 0x00, 0x1b, 0x45, 0x01,
    ]);
    // ends with FEED_AND_CUT
    expect(arr.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });
});

describe('buildKitchenDocketCommands', () => {
  const items: OrderItemRow[] = [
    item({ qty: 2, menu_item_name: 'Latte', notes: 'extra hot' }),
    item({
      id: 'i2',
      qty: 1,
      menu_item_name: 'Bagel',
      modifiers: { toasted: 'yes' },
    }),
  ];
  const now = new Date(2026, 6, 1, 9, 5);

  it('renders a price-free KOT with the expected content', () => {
    const bytes = buildKitchenDocketCommands({
      items,
      tableLabel: 'Table 4',
      width: '80',
      now,
    });
    const text = decode(bytes);

    // Table label is the big header now; station word sits in the subheader.
    expect(text).toContain('Table 4');
    // The middle dot (·) is codepage-folded to '-' by encodeText.
    expect(text).toContain('KITCHEN - 09:05');
    expect(text).toContain('2x Latte');
    expect(text).toContain('Bagel');
    expect(text).toContain('> extra hot');
    expect(text).toContain('+ toasted: yes');
    expect(text).toContain('item(s)'); // "3 item(s)"
    expect(text).toContain('3 item(s)');

    // No price / currency anywhere.
    expect(text).not.toMatch(/Rs|₹|\$|\d+\.\d{2}/);

    // Byte-level framing: starts with INIT, ends with cut.
    const arr = Array.from(bytes);
    expect(arr.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(arr.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });

  it('adds a REPRINT line when reprint is true', () => {
    const bytes = buildKitchenDocketCommands({
      items,
      tableLabel: 'Table 4',
      width: '80',
      reprint: true,
      now,
    });
    expect(decode(bytes)).toContain('REPRINT');
  });

  it('uses the station word in the subheader when provided', () => {
    const bytes = buildKitchenDocketCommands({
      items,
      tableLabel: 'Table 4',
      width: '80',
      station: 'BAR',
      now,
    });
    const text = decode(bytes);
    expect(text).toContain('Table 4');
    expect(text).toContain('BAR - 09:05');
    expect(text).not.toContain('KITCHEN');
  });
});

describe('formatReceiptMoney', () => {
  it('formats the reference examples exactly', () => {
    expect(formatReceiptMoney(500)).toBe('Rs 5');
    expect(formatReceiptMoney(12345)).toBe('Rs 123.45');
    expect(formatReceiptMoney(100000)).toBe('Rs 1,000');
    expect(formatReceiptMoney(-2500)).toBe('-Rs 25');
  });
});

describe('trimPct', () => {
  it('trims trailing zeros and passes non-numeric through', () => {
    expect(trimPct('13.00')).toBe('13');
    expect(trimPct('8.50')).toBe('8.5');
    expect(trimPct('0')).toBe('0');
    expect(trimPct('x')).toBe('x');
  });
});

describe('computeReceiptTotals', () => {
  // Base quote: subtotal 10000, discount 1000, service 500 (10%), tax 1300 (13%).
  const base = (over: Partial<SettleQuote>): SettleQuote => ({
    subtotal_cents: 10000,
    discount_cents: 0,
    service_charge_cents: 0,
    tax_cents: 0,
    total_cents: 10000,
    paid_cents: 10000,
    balance_cents: 0,
    service_charge_pct: '10.00',
    vat_pct: '13.00',
    vat_mode: 'none',
    ...over,
  });

  it('vat_mode none — without discount/service', () => {
    const v = computeReceiptTotals(base({ vat_mode: 'none' }));
    expect(v.rows).toEqual([{ label: 'Subtotal', cents: 10000 }]);
    expect(v.totalCents).toBe(10000);
    expect(v.showPaid).toBe(false);
    expect(v.showBalance).toBe(false);
  });

  it('vat_mode none — with discount + service', () => {
    const v = computeReceiptTotals(
      base({
        vat_mode: 'none',
        discount_cents: 1000,
        service_charge_cents: 500,
        total_cents: 9500,
        paid_cents: 5000,
        balance_cents: 4500,
      }),
    );
    expect(v.rows).toEqual([
      { label: 'Subtotal', cents: 10000 },
      { label: 'Discount', cents: -1000 },
      { label: 'Service 10%', cents: 500 },
    ]);
    expect(v.totalCents).toBe(9500);
    expect(v.paidCents).toBe(5000);
    expect(v.balanceCents).toBe(4500);
    expect(v.showPaid).toBe(true);
    expect(v.showBalance).toBe(true);
  });

  it('vat_mode exclusive — without discount/service', () => {
    const v = computeReceiptTotals(
      base({ vat_mode: 'exclusive', tax_cents: 1300, total_cents: 11300, paid_cents: 11300 }),
    );
    expect(v.rows).toEqual([
      { label: 'Subtotal', cents: 10000 },
      { label: 'VAT 13%', cents: 1300 },
    ]);
    expect(v.totalCents).toBe(11300);
    expect(v.showPaid).toBe(false);
    expect(v.showBalance).toBe(false);
  });

  it('vat_mode exclusive — with discount + service', () => {
    const v = computeReceiptTotals(
      base({
        vat_mode: 'exclusive',
        discount_cents: 1000,
        service_charge_cents: 500,
        tax_cents: 1300,
        total_cents: 10800,
        paid_cents: 10800,
      }),
    );
    expect(v.rows).toEqual([
      { label: 'Subtotal', cents: 10000 },
      { label: 'Discount', cents: -1000 },
      { label: 'Service 10%', cents: 500 },
      { label: 'VAT 13%', cents: 1300 },
    ]);
    expect(v.totalCents).toBe(10800);
  });

  it('vat_mode inclusive — without discount/service (Net + VAT only)', () => {
    const v = computeReceiptTotals(
      base({ vat_mode: 'inclusive', tax_cents: 1300, total_cents: 10000, paid_cents: 10000 }),
    );
    // Net = total - tax = 10000 - 1300 = 8700.
    expect(v.rows).toEqual([
      { label: 'Net', cents: 8700 },
      { label: 'VAT 13%', cents: 1300 },
    ]);
    expect(v.totalCents).toBe(10000);
    expect(v.showPaid).toBe(false);
    expect(v.showBalance).toBe(false);
  });

  it('vat_mode inclusive — with discount + service (full breakdown)', () => {
    const v = computeReceiptTotals(
      base({
        vat_mode: 'inclusive',
        discount_cents: 1000,
        service_charge_cents: 500,
        tax_cents: 1300,
        total_cents: 9500,
        paid_cents: 4000,
        balance_cents: 5500,
      }),
    );
    // Net = total - tax = 9500 - 1300 = 8200.
    expect(v.rows).toEqual([
      { label: 'Subtotal (incl. VAT)', cents: 10000 },
      { label: 'Discount', cents: -1000 },
      { label: 'Service 10%', cents: 500 },
      { label: 'Net', cents: 8200 },
      { label: 'VAT 13%', cents: 1300 },
    ]);
    expect(v.totalCents).toBe(9500);
    expect(v.showPaid).toBe(true);
    expect(v.showBalance).toBe(true);
  });
});

describe('buildReceiptCommands', () => {
  const items: OrderItemRow[] = [
    item({ qty: 2, menu_item_name: 'Latte', line_cents: 5000, notes: 'extra hot' }),
    item({ id: 'i2', qty: 1, menu_item_name: 'Bagel', line_cents: 3000 }),
  ];
  // Exclusive, discount>0, partial paid so balance>0.
  const quote: SettleQuote = {
    subtotal_cents: 8000,
    discount_cents: 500,
    service_charge_cents: 0,
    tax_cents: 975,
    total_cents: 8475,
    paid_cents: 5000,
    balance_cents: 3475,
    service_charge_pct: '0',
    vat_pct: '13.00',
    vat_mode: 'exclusive',
  };
  const now = new Date(2026, 6, 2, 14, 30);

  it('renders a customer receipt WITH prices', () => {
    const bytes = buildReceiptCommands({
      items,
      quote,
      payments: [
        { method: 'cash', amount_cents: 5000 },
        { method: 'house_tab', amount_cents: 3475, house_tab_name: 'Alice' },
      ],
      tableLabel: 'Table 7',
      header: 'Sahan Cafe\nKathmandu',
      footer: 'Thank you!',
      width: '80',
      orderId: 'abcdef1234567890',
      reprint: true,
      now,
    });
    const text = decode(bytes);

    expect(text).toContain('Sahan Cafe');
    expect(text).toContain('REPRINT');
    expect(text).toContain('Table 7');
    expect(text).toContain('14:30');
    expect(text).toContain('#abcdef12');
    expect(text).toContain('2x Latte');
    expect(text).toContain('Bagel');
    expect(text).toContain('> extra hot');
    expect(text).toContain('Rs ');
    expect(text).toContain('TOTAL');
    expect(text).toContain('VAT 13%');
    expect(text).toContain('Cash');
    expect(text).toContain('House tab');
    expect(text).toContain('Balance');
    expect(text).toContain('Thank you!');

    // Prices ARE present (unlike the KOT).
    expect(text).toMatch(/Rs \d/);
    expect(text).toContain('Rs 84.75'); // grand total

    // Byte-level framing: starts with ESC @, ends with cut bytes.
    const arr = Array.from(bytes);
    expect(arr.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(arr.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });
});
