/**
 * The kitchen board projection + ticket advance, mirroring
 * apps/api/internal/api/kitchen.go.
 *
 * A ticket is one order line, not one order, and only lines that have actually
 * been fired appear — `pending` lines belong to the waiter's ticket panel, and
 * `served` ones are done.
 */
import type { KitchenStatus, KitchenTicket } from '@cafe-mgmt/api-types';
import { resolveTableLabel } from '@cafe-mgmt/api-types';
import { conflict, notFound } from './errors';
import { recompute, stampKitchen } from './orders';
import { getWorld } from './world';

/** in_progress → ready → served, and a same-state request is a no-op. Anything
 *  else is the board and the client disagreeing; the server rejects it, so we do. */
function validTransition(from: KitchenStatus, to: KitchenStatus): boolean {
  if (from === to) return true;
  if (from === 'in_progress' && to === 'ready') return true;
  if (from === 'ready' && to === 'served') return true;
  return false;
}

export function tickets(): KitchenTicket[] {
  const w = getWorld();
  const out: KitchenTicket[] = [];
  for (const order of w.orders) {
    if (order.status !== 'open') continue;
    for (const line of order.items) {
      if (line.voided_at) continue;
      if (line.kitchen_status !== 'in_progress' && line.kitchen_status !== 'ready') continue;
      const outlet = w.outlets.find((o) => o.id === line.outlet_id);
      out.push({
        item_id: line.id,
        order_id: order.id,
        service_table_name: order.service_table_name ?? null,
        table_label: order.table_label,
        menu_item_name: line.menu_item_name,
        qty: line.qty,
        add_ons: line.add_ons,
        modifiers: null,
        notes: line.notes,
        kitchen_status: line.kitchen_status,
        sent_to_kitchen_at: line.sent_to_kitchen_at ?? null,
        ready_at: line.ready_at ?? null,
        outlet_id: line.outlet_id ?? null,
        outlet_name: outlet?.name ?? null,
      });
    }
  }
  // Oldest first — the board reads as a queue.
  return out.sort((a, b) => (a.sent_to_kitchen_at ?? '').localeCompare(b.sent_to_kitchen_at ?? ''));
}

export function advance(itemId: string, next: KitchenStatus): void {
  const w = getWorld();
  for (const order of w.orders) {
    const line = order.items.find((i) => i.id === itemId);
    if (!line) continue;

    const from = line.kitchen_status;
    if (!validTransition(from, next)) {
      throw conflict('invalid_transition', `cannot move from ${from} to ${next}`);
    }
    if (from === next) return;

    // The tenant may collapse plating and handing off into one tap.
    const applied: KitchenStatus =
      next === 'ready' && w.tenant.preferences.autoServeOnReady ? 'served' : next;
    stampKitchen(line, applied);
    recompute(order);
    return;
  }
  throw notFound();
}

/** Board label for a ticket — shared with the floor and history so a walk-in tab
 *  reads the same everywhere. */
export const ticketLabel = (t: KitchenTicket): string => resolveTableLabel(t);
