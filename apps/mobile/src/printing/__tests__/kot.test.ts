import type { Order, Outlet, OrderItemRow, MenuItem, MenuCategory } from '@cafe-mgmt/api-types';
import { shouldPrintKot, selectCookBoundPending, printKitchenDocket, groupDocketsByOutlet } from '../kot';
import * as Tcp from 'react-native-tcp-socket';

const tcpWrites = (Tcp as unknown as { __writes: Uint8Array[] }).__writes;
const tcpReset = (Tcp as unknown as { __reset: () => void }).__reset;

function item(over: Partial<OrderItemRow>): OrderItemRow {
  return {
    id: over.id ?? 'i1',
    order_id: 'o1',
    menu_item_id: over.menu_item_id ?? 'm1',
    menu_item_name: over.menu_item_name ?? 'Latte',
    qty: over.qty ?? 1,
    unit_price_cents: 0,
    line_cents: 0,
    modifiers: over.modifiers ?? null,
    notes: over.notes ?? '',
    kitchen_status: over.kitchen_status ?? 'pending',
    created_at: '',
    voided_at: over.voided_at ?? null,
  };
}

const menu: MenuItem[] = [
  { id: 'm1', category_id: 'c1', name: 'Latte', description: '', price_cents: 0, icon: '', is_active: true, is_featured: false, kitchen_behavior: 'inherit', allow_half: false, sort: 0, modifiers: null, preset_notes: [] },
  { id: 'm2', category_id: 'c2', name: 'Bottled Water', description: '', price_cents: 0, icon: '', is_active: true, is_featured: false, kitchen_behavior: 'serve', allow_half: false, sort: 0, modifiers: null, preset_notes: [] },
];
const cats: MenuCategory[] = [
  { id: 'c1', name: 'Coffee', sort: 0, icon: '', is_active: true, kitchen_behavior: 'cook', item_count: 1 },
  { id: 'c2', name: 'Fridge', sort: 0, icon: '', is_active: true, kitchen_behavior: 'inherit', item_count: 1 },
];

describe('shouldPrintKot', () => {
  it('true only when printing + kitchen-ticket both enabled', () => {
    expect(shouldPrintKot({ printingEnabled: true, printKitchenTicket: true })).toBe(true);
    expect(shouldPrintKot({ printingEnabled: false, printKitchenTicket: true })).toBe(false);
    expect(shouldPrintKot({ printingEnabled: true, printKitchenTicket: false })).toBe(false);
    expect(shouldPrintKot(undefined)).toBe(false);
  });
});

describe('selectCookBoundPending', () => {
  const order = {
    items: [
      item({ id: 'a', menu_item_id: 'm1', kitchen_status: 'pending' }), // cook (category)
      item({ id: 'b', menu_item_id: 'm2', kitchen_status: 'pending' }), // serve → excluded
      item({ id: 'c', menu_item_id: 'm1', kitchen_status: 'in_progress' }), // already sent → excluded
      item({ id: 'd', menu_item_id: 'm1', kitchen_status: 'pending', voided_at: 'x' }), // voided → excluded
    ],
  } as Order;

  it('keeps only pending, non-voided, cook-resolving lines', () => {
    const out = selectCookBoundPending(order, menu, cats, {});
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('respects tenant auto-ready default (nothing cooks)', () => {
    const out = selectCookBoundPending(order, menu, cats, { autoReadyOnSend: true });
    // category 'cook' still overrides the tenant default for m1, so 'a' stays.
    expect(out.map((i) => i.id)).toEqual(['a']);
  });
});

describe('groupDocketsByOutlet', () => {
  const outlets: Outlet[] = [
    { id: 'ok', name: 'Kitchen', sort: 0, is_active: true, is_default: true, printer_ip: '10.0.0.1', printer_port: 9100, printer_width: '80' },
    { id: 'ob', name: 'Bar', sort: 1, is_active: true, is_default: false, printer_ip: '10.0.0.2', printer_port: 9100, printer_width: '80' },
  ];
  const gCats: MenuCategory[] = [
    { id: 'c1', name: 'Coffee', sort: 0, icon: '', is_active: true, kitchen_behavior: 'cook', item_count: 1 }, // no outlet → default Kitchen
    { id: 'c2', name: 'Cocktails', sort: 0, icon: '', is_active: true, kitchen_behavior: 'cook', outlet_id: 'ob', item_count: 1 }, // → Bar
  ];
  const gMenu: MenuItem[] = [
    { id: 'm1', category_id: 'c1', name: 'Latte', description: '', price_cents: 0, icon: '', is_active: true, is_featured: false, kitchen_behavior: 'inherit', allow_half: false, sort: 0, modifiers: null, preset_notes: [] }, // → Kitchen
    { id: 'm2', category_id: 'c1', name: 'Beer', description: '', price_cents: 0, icon: '', is_active: true, is_featured: false, kitchen_behavior: 'inherit', outlet_id: 'ob', allow_half: false, sort: 0, modifiers: null, preset_notes: [] }, // item override → Bar
    { id: 'm3', category_id: 'c2', name: 'Mojito', description: '', price_cents: 0, icon: '', is_active: true, is_featured: false, kitchen_behavior: 'inherit', allow_half: false, sort: 0, modifiers: null, preset_notes: [] }, // → Bar (category)
  ];

  it('groups lines by resolved outlet with the outlet printer as target', () => {
    const lines = [
      item({ id: 'a', menu_item_id: 'm1' }),
      item({ id: 'b', menu_item_id: 'm2' }),
      item({ id: 'c', menu_item_id: 'm3' }),
    ];
    const groups = groupDocketsByOutlet(lines, gMenu, gCats, outlets);
    const byName: Record<string, (typeof groups)[number]> = {};
    for (const g of groups) byName[g.outlet?.name ?? ''] = g;

    expect(byName['Kitchen'].items.map((i) => i.id)).toEqual(['a']);
    expect(byName['Kitchen'].target).toEqual({ ip: '10.0.0.1', port: 9100, width: '80' });
    expect(byName['Bar'].items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(byName['Bar'].target).toEqual({ ip: '10.0.0.2', port: 9100, width: '80' });
  });

  it('gives a null target for an outlet with no printer', () => {
    const noPrinter: Outlet[] = [{ ...outlets[0], printer_ip: undefined }];
    const groups = groupDocketsByOutlet([item({ id: 'a', menu_item_id: 'm1' })], gMenu, [gCats[0]], noPrinter);
    expect(groups[0].target).toBeNull();
  });

  it('returns no groups for an empty line list', () => {
    expect(groupDocketsByOutlet([], gMenu, gCats, outlets)).toEqual([]);
  });

  it('routes an unknown menu line to the default outlet', () => {
    // No matching MenuItem (e.g. an item deleted from the catalog) → default.
    const groups = groupDocketsByOutlet([item({ id: 'z', menu_item_id: 'ghost' })], gMenu, gCats, outlets);
    expect(groups).toHaveLength(1);
    expect(groups[0].outlet?.name).toBe('Kitchen');
  });

  it('yields an undefined outlet + null target when nothing resolves', () => {
    // Item overrides to an outlet id that no longer exists, and there is no
    // default outlet to fall back to → ungrouped, unprinted.
    const orphanItem: MenuItem[] = [{ ...gMenu[0], outlet_id: 'gone' }];
    const noDefaultOutlets = [outlets[1]]; // Bar only — no default to fall back to
    const groups = groupDocketsByOutlet([item({ id: 'a', menu_item_id: 'm1' })], orphanItem, [gCats[0]], noDefaultOutlets);
    expect(groups).toHaveLength(1);
    expect(groups[0].outlet).toBeUndefined();
    expect(groups[0].target).toBeNull();
  });
});

describe('printKitchenDocket', () => {
  beforeEach(() => tcpReset());
  it('sends ESC/POS bytes starting with INIT for cook-bound items', async () => {
    await printKitchenDocket({
      items: [item({ id: 'a', menu_item_name: 'Latte', qty: 2 })],
      tableLabel: 'Table 4',
      printer: { ip: '192.168.1.50', port: 9100, width: '80' },
      now: new Date(2026, 6, 1, 9, 5),
    });
    expect(tcpWrites.length).toBe(1);
    const bytes = Array.from(tcpWrites[0]);
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]); // ESC @ init
  });

  it('is a no-op with no items (no socket opened)', async () => {
    await printKitchenDocket({
      items: [],
      tableLabel: 'Table 4',
      printer: { ip: '192.168.1.50', port: 9100, width: '80' },
    });
    expect(tcpWrites.length).toBe(0);
  });
});
