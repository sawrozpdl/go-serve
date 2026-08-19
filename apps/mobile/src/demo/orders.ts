/**
 * Order lifecycle for the demo backend, mirroring apps/api/internal/api/orders.go.
 *
 * The routing decisions (which outlet, cook vs ready vs straight-serve) reuse the
 * shared resolvers from @cafe-mgmt/api-types rather than reimplementing them, so
 * the demo routes a line exactly the way the server would — including the
 * item → category → tenant-default precedence.
 *
 * Every mutation ends in recompute(), which is the same recomputeOrderDerived the
 * optimistic-cache path uses. Demo state and optimistic state therefore cannot
 * disagree about an order's per-status counts.
 */
import {
  addOnsUnitCents,
  resolveAddOnRows,
  resolveKitchenBehavior,
  resolveOutletId,
  type AddOrderItemsVars,
  type KitchenStatus,
  type Order,
  type OrderItemRow,
} from '@cafe-mgmt/api-types';
import { recomputeOrderDerived } from '../api/orderDerive';
import { conflict, notFound } from './errors';
import {
  categoryOf,
  findOrder,
  findTable,
  getWorld,
  isoMinutesAgo,
  nowIso,
  uuid,
  type DemoOrder,
  type DemoOrderItem,
} from './world';

export type SendResult = {
  sent: number;
  to_kitchen: number;
  marked_ready: number;
  auto_served: number;
};

/** Re-derive the cheap counts + live subtotal in place. */
export function recompute(o: DemoOrder): DemoOrder {
  Object.assign(o, recomputeOrderDerived(o as Order));
  return o;
}

export function newOrder(fields: Partial<DemoOrder> = {}): DemoOrder {
  const w = getWorld();
  const base: DemoOrder = {
    id: uuid(),
    service_table_id: null,
    service_table_name: null,
    table_label: '',
    status: 'open',
    opened_by_user_id: w.me.user_id,
    opened_at: nowIso(),
    closed_at: null,
    notes: '',
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    service_charge_cents: 0,
    total_cents: 0,
    live_subtotal_cents: 0,
    items: [],
    items_pending: 0,
    items_in_progress: 0,
    items_ready: 0,
    items_served: 0,
    items_total: 0,
    paid_cents: 0,
    ...fields,
  };
  return recompute(base);
}

export function openOrder(body: {
  service_table_id?: string | null;
  table_label?: string;
  notes?: string;
}): Order {
  const w = getWorld();
  const table = findTable(body.service_table_id);
  const order = newOrder({
    service_table_id: table?.id ?? null,
    service_table_name: table?.name ?? null,
    table_label: body.table_label ?? '',
    notes: body.notes ?? '',
  });
  if (table && table.status === 'free') table.status = 'occupied';
  w.orders.unshift(order);
  return order;
}

/**
 * Add lines. Idempotent on the client-minted line id — the server's
 * `ON CONFLICT DO NOTHING` is what makes the offline replay exactly-once, and the
 * demo has to honour the same contract or a replayed batch would double up.
 * Returns only the rows actually inserted, as the server does.
 */
export function addItems(orderId: string, body: { items: AddOrderItemsVars['items'] }): {
  items: OrderItemRow[];
} {
  const w = getWorld();
  const order = findOrder(orderId);
  if (order.status !== 'open') throw conflict(`already_${order.status}`, `order is ${order.status}`);

  const inserted: DemoOrderItem[] = [];
  for (const line of body.items ?? []) {
    if (order.items.some((i) => i.id === line.id)) continue;
    const menuItem = w.items.find((i) => i.id === line.menu_item_id);
    if (!menuItem) throw notFound();

    // Re-price from the catalog: the server never trusts client prices, and a demo
    // that did would let a stale draft under-charge itself.
    const addOns = resolveAddOnRows(w.groups, line.add_ons ?? []);
    const unit = menuItem.price_cents + addOnsUnitCents(addOns);
    const row: DemoOrderItem = {
      id: line.id,
      order_id: order.id,
      menu_item_id: menuItem.id,
      menu_item_name: menuItem.name,
      qty: line.qty,
      unit_price_cents: unit,
      base_price_cents: menuItem.price_cents,
      line_cents: Math.round(line.qty * unit),
      add_ons: addOns,
      modifiers: null,
      notes: line.notes ?? '',
      kitchen_status: 'pending',
      sent_to_kitchen_at: null,
      ready_at: null,
      served_at: null,
      voided_at: null,
      void_reason: null,
      created_at: nowIso(),
      outlet_id: null,
    };
    order.items.push(row);
    inserted.push(row);
  }
  recompute(order);
  return { items: inserted };
}

export function updateItem(
  orderId: string,
  itemId: string,
  patch: { qty?: number; notes?: string },
): void {
  const order = findOrder(orderId);
  const item = order.items.find((i) => i.id === itemId);
  if (!item) throw notFound();
  if (patch.qty != null) {
    item.qty = patch.qty;
    item.line_cents = Math.round(patch.qty * item.unit_price_cents);
  }
  if (patch.notes != null) item.notes = patch.notes;
  recompute(order);
}

export function voidItem(orderId: string, itemId: string, reason?: string): void {
  const order = findOrder(orderId);
  const item = order.items.find((i) => i.id === itemId);
  if (!item) throw notFound();
  item.voided_at = nowIso();
  item.void_reason = reason ?? '';
  recompute(order);
}

/**
 * Fire the pending lines. Each line's destination and whether it needs cooking at
 * all resolve through the shared item → category → tenant chain, and the prep
 * outlet is STAMPED onto the line here: the KDS filters on it and the ticket shows
 * the outlet's name, so a ticket sent without it would fold onto the wrong board.
 */
export function sendToKitchen(orderId: string): SendResult {
  const w = getWorld();
  const order = findOrder(orderId);
  if (order.status !== 'open') throw conflict(`already_${order.status}`, `order is ${order.status}`);

  const prefs = w.tenant.preferences;
  const at = nowIso();
  let toKitchen = 0;
  let markedReady = 0;
  let autoServed = 0;

  for (const line of order.items) {
    if (line.voided_at || line.kitchen_status !== 'pending') continue;
    const menuItem = w.items.find((i) => i.id === line.menu_item_id);
    const cat = categoryOf(menuItem);
    line.outlet_id = resolveOutletId(menuItem, cat, w.outlets) ?? null;

    switch (resolveKitchenBehavior(menuItem, cat, prefs)) {
      case 'serve':
        line.kitchen_status = 'served';
        line.sent_to_kitchen_at = at;
        line.ready_at = at;
        line.served_at = at;
        autoServed += 1;
        break;
      case 'ready':
        line.kitchen_status = 'ready';
        line.sent_to_kitchen_at = at;
        line.ready_at = at;
        markedReady += 1;
        break;
      default:
        line.kitchen_status = 'in_progress';
        line.sent_to_kitchen_at = at;
        toKitchen += 1;
    }
  }

  recompute(order);
  return {
    sent: toKitchen + markedReady + autoServed,
    to_kitchen: toKitchen,
    marked_ready: markedReady,
    auto_served: autoServed,
  };
}

export function renameOrder(orderId: string, label: string): void {
  const order = findOrder(orderId);
  order.table_label = label;
}

export function cancelOrder(orderId: string): void {
  const order = findOrder(orderId);
  if (order.status !== 'open') throw conflict(`already_${order.status}`, `order is ${order.status}`);
  order.status = 'cancelled';
  order.closed_at = nowIso();
  const table = findTable(order.service_table_id);
  if (table && table.status === 'occupied') table.status = 'free';
}

/** Move a tab to another table, merging into that table's existing open tab. */
export function moveOrder(
  orderId: string,
  targetTableId: string | null,
): { order_id: string; merged: boolean } {
  const w = getWorld();
  const order = findOrder(orderId);
  if (order.status !== 'open') throw conflict(`already_${order.status}`, `order is ${order.status}`);

  const from = findTable(order.service_table_id);
  const target = findTable(targetTableId);
  if (targetTableId && !target) throw notFound();

  const existing = targetTableId
    ? w.orders.find((o) => o.status === 'open' && o.service_table_id === targetTableId && o.id !== order.id)
    : undefined;

  if (existing) {
    for (const line of order.items) {
      line.order_id = existing.id;
      existing.items.push(line);
    }
    for (const p of w.payments) if (p.order_id === order.id) p.order_id = existing.id;
    order.items = [];
    order.status = 'cancelled';
    order.closed_at = nowIso();
    recompute(order);
    recompute(existing);
    if (from && from.id !== targetTableId && from.status === 'occupied') from.status = 'free';
    return { order_id: existing.id, merged: true };
  }

  order.service_table_id = target?.id ?? null;
  order.service_table_name = target?.name ?? null;
  if (from && from.id !== target?.id && from.status === 'occupied') from.status = 'free';
  if (target && target.status === 'free') target.status = 'occupied';
  return { order_id: order.id, merged: false };
}

/** Advance a kitchen line. Timestamps are set once (COALESCE-style), so a
 *  re-advance never rewrites the original age the KDS colours by. */
export function stampKitchen(line: DemoOrderItem, next: KitchenStatus, at = nowIso()): void {
  line.kitchen_status = next;
  if (next === 'in_progress' && !line.sent_to_kitchen_at) line.sent_to_kitchen_at = at;
  if (next === 'ready' && !line.ready_at) line.ready_at = at;
  if (next === 'served') {
    if (!line.ready_at) line.ready_at = at;
    if (!line.served_at) line.served_at = at;
  }
}

export { isoMinutesAgo };
