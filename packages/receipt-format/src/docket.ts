import { formatQty, type OrderItemRow } from '@cafe-mgmt/api-types';
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

// Render chosen add-ons as `  + Extra cheese` / `  + 2x Bacon` lines. The
// two-space indent is the convention the cook's eye already follows for notes,
// and it's what the on-screen ticket and the browser docket now mirror.
//
// No prices: this is a KOT.
function addOnLines(addOns: OrderItemRow['add_ons']): string[] {
  return (addOns ?? []).map((a) =>
    a.qty > 1 ? `  + ${formatQty(a.qty, true)}x ${a.name}` : `  + ${a.name}`,
  );
}

/** Build a Kitchen Order Ticket byte stream. Mirrors web kitchenDocketHTML — NO PRICES. */
export function buildKitchenDocketCommands(args: KitchenDocketArgs): Uint8Array {
  const { items, tableLabel, width, reprint, now } = args;
  const station = args.station ?? 'KITCHEN';
  const b = new EscPosBuilder(width);

  b.init();

  // Minimal header: the table label stays bold but normal-size (no doubleSize),
  // so the item list below is the content the cook works from. Mirrors web's
  // small `.docket-head`.
  b.align('center').bold(true).line(tableLabel).bold(false);

  b.align('center').line(`${station} · ${fmtTime(now)}`);

  if (reprint) {
    b.align('center').bold(true).line('** REPRINT **').bold(false);
  }

  b.rule('-');

  b.align('left');
  for (const it of items) {
    b.bold(true).line(`${formatQty(it.qty, true)}x ${it.menu_item_name}`).bold(false);
    for (const mod of addOnLines(it.add_ons)) b.line(mod);
    if (it.notes?.trim()) b.line(`  > ${it.notes.trim()}`);
  }

  b.rule('-');

  // Counts DISHES, not add-ons — an add-on is part of the dish it rides on, so
  // folding it in here would tell the cook to expect more plates than exist.
  const totalQty = items.reduce((sum, it) => sum + it.qty, 0);
  b.align('center').line(`${formatQty(totalQty, true)} item(s)`);

  b.feed(1).cut();

  return b.toBytes();
}
