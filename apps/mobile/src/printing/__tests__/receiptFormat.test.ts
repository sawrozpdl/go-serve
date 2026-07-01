import type { OrderItemRow } from '@cafe-mgmt/api-types';
import {
  encodeText,
  twoCol,
  EscPosBuilder,
  buildKitchenDocketCommands,
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

    expect(text).toContain('KITCHEN');
    // The middle dot (·) is codepage-folded to '-' by encodeText.
    expect(text).toContain('Table 4 - 09:05');
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
});
