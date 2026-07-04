import type { OrderItemRow } from '@cafe-mgmt/api-types';
import { EscPosBuilder } from './escpos/builder';

export type KitchenDocketArgs = {
  items: OrderItemRow[]; // cook-bound lines only (caller pre-filters)
  tableLabel: string;
  width: '58' | '80';
  reprint?: boolean;
  station?: string; // small subheader word; defaults to 'KITCHEN' (later: 'BAR', etc.)
  now: Date; // INJECTED (do not call new Date() inside — keeps it testable)
};

// HH:mm 24h, zero-padded.
function fmtTime(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Render `modifiers` (typed `unknown`) as `  + key: value` lines. Only a plain
// non-null object contributes lines; anything else is ignored.
function modifierLines(modifiers: unknown): string[] {
  if (modifiers === null || typeof modifiers !== 'object') return [];
  return Object.entries(modifiers as Record<string, unknown>).map(
    ([key, value]) => `  + ${key}: ${String(value)}`,
  );
}

/** Build a Kitchen Order Ticket byte stream. Mirrors web kitchenDocketHTML — NO PRICES. */
export function buildKitchenDocketCommands(args: KitchenDocketArgs): Uint8Array {
  const { items, tableLabel, width, reprint, now } = args;
  const station = args.station ?? 'KITCHEN';
  const b = new EscPosBuilder(width);

  b.init();

  // The table/tab is what the cook needs first — print it big; the station word
  // is demoted to the small subheader (parameterised for future bars/stations).
  b.align('center').bold(true).doubleSize(true).line(tableLabel);
  b.doubleSize(false).bold(false);

  b.align('center').line(`${station} · ${fmtTime(now)}`);

  if (reprint) {
    b.align('center').bold(true).line('** REPRINT **').bold(false);
  }

  b.rule('-');

  b.align('left');
  for (const it of items) {
    b.bold(true).line(`${it.qty}x ${it.menu_item_name}`).bold(false);
    for (const mod of modifierLines(it.modifiers)) b.line(mod);
    if (it.notes?.trim()) b.line(`  > ${it.notes.trim()}`);
  }

  b.rule('-');

  const totalQty = items.reduce((sum, it) => sum + it.qty, 0);
  b.align('center').line(`${totalQty} item(s)`);

  b.feed(1).cut();

  return b.toBytes();
}
