/**
 * Kitchen-ticket print orchestration. Pure helpers (gate + cook-bound
 * selection) are unit-tested; `printKitchenDocket` builds the ESC/POS bytes and
 * ships them over TCP.
 *
 * The print-on-send rule: print a KOT iff printing is enabled, the kitchen-ticket
 * toggle is on, and there are cook-bound lines. Which printer(s) receive it comes
 * from the tenant config (see `kitchenTargets`). Cook-bound = pending, not voided,
 * and resolving to 'cook' (auto-ready / auto-serve items never hit the kitchen).
 * The caller MUST snapshot these lines BEFORE send-to-kitchen — the success
 * refetch flips them to in_progress.
 */
import {
  resolveKitchenBehavior,
  resolveOutlet,
  type Order,
  type Outlet,
  type OrderItemRow,
  type MenuItem,
  type MenuCategory,
  type TenantPreferences,
} from '@cafe-mgmt/api-types';
import { buildKitchenDocketCommands, EscPosBuilder } from '@cafe-mgmt/receipt-format';
import { printBytes } from './tcpPrinter';
import { outletTarget, type PrinterTarget } from './printerConfig';

export function shouldPrintKot(prefs: TenantPreferences | undefined): boolean {
  return !!prefs?.printingEnabled && !!prefs?.printKitchenTicket;
}

/** The pending lines that will actually cook (and therefore belong on a KOT). */
export function selectCookBoundPending(
  order: Order,
  menuItems: MenuItem[],
  categories: MenuCategory[],
  prefs: TenantPreferences | undefined,
): OrderItemRow[] {
  const itemById = new Map(menuItems.map((m) => [m.id, m]));
  const catById = new Map(categories.map((c) => [c.id, c]));
  return (order.items ?? []).filter((i) => {
    if (i.voided_at || i.kitchen_status !== 'pending') return false;
    const mi = itemById.get(i.menu_item_id);
    const cat = mi ? catById.get(mi.category_id) : undefined;
    return resolveKitchenBehavior(mi, cat, prefs) === 'cook';
  });
}

/** One outlet's slice of a docket: the resolved outlet, its network printer
 *  target (null when the outlet has no printer configured), and its lines. */
export type OutletDocket = {
  outlet: Outlet | undefined;
  target: PrinterTarget | null;
  items: OrderItemRow[];
};

/** Group cook-bound lines by their resolved prep outlet (item → category →
 *  default) so each outlet's subset prints to its own printer with its name on
 *  the header. Keeps input order within each group. */
export function groupDocketsByOutlet(
  items: OrderItemRow[],
  menuItems: MenuItem[],
  categories: MenuCategory[],
  outlets: Outlet[],
): OutletDocket[] {
  const itemById = new Map(menuItems.map((m) => [m.id, m]));
  const catById = new Map(categories.map((c) => [c.id, c]));
  const groups = new Map<string, OutletDocket>();
  for (const it of items) {
    const mi = itemById.get(it.menu_item_id);
    const cat = mi ? catById.get(mi.category_id) : undefined;
    const outlet = resolveOutlet(mi, cat, outlets);
    const key = outlet?.id ?? '';
    const g = groups.get(key);
    if (g) g.items.push(it);
    else groups.set(key, { outlet, target: outletTarget(outlet), items: [it] });
  }
  return [...groups.values()];
}

/** Print a small "printer works" slip — used by Settings → Printing's test button. */
export async function printTestSlip(printer: PrinterTarget, now: Date = new Date()): Promise<void> {
  const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const bytes = new EscPosBuilder(printer.width)
    .init()
    .align('center')
    .bold(true)
    .doubleSize(true)
    .line('GO SERVE')
    .doubleSize(false)
    .bold(false)
    .line('Printer test')
    .line(stamp)
    .rule('-')
    .align('left')
    .line(`${printer.ip}:${printer.port} - ${printer.width}mm`)
    .feed(1)
    .cut()
    .toBytes();
  await printBytes(printer.ip, printer.port, bytes);
}

export async function printKitchenDocket(opts: {
  items: OrderItemRow[];
  tableLabel: string;
  printer: PrinterTarget;
  reprint?: boolean;
  station?: string;
  now?: Date;
}): Promise<void> {
  if (opts.items.length === 0) return;
  const bytes = buildKitchenDocketCommands({
    items: opts.items,
    tableLabel: opts.tableLabel,
    width: opts.printer.width,
    reprint: opts.reprint,
    station: opts.station,
    now: opts.now ?? new Date(),
  });
  await printBytes(opts.printer.ip, opts.printer.port, bytes);
}
