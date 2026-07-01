/**
 * Kitchen-ticket print orchestration. Pure helpers (gate + cook-bound
 * selection) are unit-tested; `printKitchenDocket` builds the ESC/POS bytes and
 * ships them over TCP.
 *
 * The print-on-send rule (from web): print a KOT iff printing is enabled, the
 * kitchen-ticket toggle is on, this device is a kitchen station, and there are
 * cook-bound lines. Cook-bound = pending, not voided, and resolving to 'cook'
 * (auto-ready / auto-serve items never hit the kitchen). The caller MUST
 * snapshot these lines BEFORE send-to-kitchen — the success refetch flips them
 * to in_progress.
 */
import {
  resolveKitchenBehavior,
  type Order,
  type OrderItemRow,
  type MenuItem,
  type MenuCategory,
  type TenantPreferences,
} from '@cafe-mgmt/api-types';
import { buildKitchenDocketCommands } from '@cafe-mgmt/receipt-format';
import { printBytes } from './tcpPrinter';
import type { DeviceRole, PrinterTarget } from './printerConfig';

export function shouldPrintKot(
  prefs: TenantPreferences | undefined,
  role: DeviceRole,
): boolean {
  return !!prefs?.printingEnabled && !!prefs?.printKitchenTicket && role.kitchen;
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

export async function printKitchenDocket(opts: {
  items: OrderItemRow[];
  tableLabel: string;
  printer: PrinterTarget;
  reprint?: boolean;
  now?: Date;
}): Promise<void> {
  if (opts.items.length === 0) return;
  const bytes = buildKitchenDocketCommands({
    items: opts.items,
    tableLabel: opts.tableLabel,
    width: opts.printer.width,
    reprint: opts.reprint,
    now: opts.now ?? new Date(),
  });
  await printBytes(opts.printer.ip, opts.printer.port, bytes);
}
