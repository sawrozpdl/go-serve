/**
 * Money operations for the demo backend, mirroring
 * apps/api/internal/api/payments.go.
 *
 * The rejections here matter as much as the happy path: SettleSheet renders the
 * API's own message verbatim, so reproducing `overpayment` and
 * `balance_outstanding` with the real codes is what makes the demo *teach* the
 * product rather than just tolerate whatever the reviewer types.
 *
 * One deliberate divergence, documented rather than hidden: the server refuses a
 * payment with `shift_required` when no shift is open. The Cash-drawer screen is
 * out of the demo's scope (no shift:read grant), so there is nowhere to open one —
 * the demo behaves as if a shift is always open.
 */
import type { OrderAdjustment, Payment, PaymentMethod, SettleQuote } from '@cafe-mgmt/api-types';
import { buildQuote } from './money';
import { conflict, notFound } from './errors';
import { findOrder, findTable, getWorld, nowIso, uuid, type DemoOrder } from './world';

function rates() {
  const t = getWorld().tenant;
  return {
    service_charge_pct: t.service_charge_pct,
    vat_pct: t.vat_pct,
    vat_mode: t.vat_mode,
  };
}

export function quoteFor(order: DemoOrder): SettleQuote {
  const w = getWorld();
  return buildQuote(order, w.adjustments, w.payments, rates());
}

export function quote(orderId: string): SettleQuote {
  return quoteFor(findOrder(orderId));
}

export function paymentsFor(orderId: string): Payment[] {
  return getWorld().payments.filter((p) => p.order_id === orderId);
}

export function adjustmentsFor(orderId: string): OrderAdjustment[] {
  return getWorld().adjustments.filter((a) => a.order_id === orderId);
}

function formatRs(paisa: number): string {
  return `Rs ${(paisa / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function recordPayment(
  orderId: string,
  body: {
    method: PaymentMethod;
    amount_cents: number;
    reference_no?: string;
    house_tab_id?: string | null;
  },
): Payment {
  const w = getWorld();
  const order = findOrder(orderId);
  const q = quoteFor(order);

  if (body.amount_cents <= 0) throw conflict('bad_request', 'enter an amount', 400);
  if (body.amount_cents > q.balance_cents) {
    throw conflict(
      'overpayment',
      `amount exceeds outstanding balance (${formatRs(q.balance_cents)}). enter the remaining amount, or remove a previous payment to start over`,
    );
  }

  let tabName: string | null = null;
  if (body.method === 'house_tab') {
    const tab = w.houseTabs.find((t) => t.id === body.house_tab_id);
    if (!tab) throw conflict('bad_request', 'choose a credit account', 400);
    if (!tab.is_active) throw conflict('house_tab_inactive', 'that credit account is archived');
    tabName = tab.name;
    // Keep the picker's "Rs N owed" label truthful as the reviewer charges to it.
    tab.charged_cents += body.amount_cents;
    tab.balance_cents += body.amount_cents;
    tab.open_charge_count += 1;
  }

  const payment: Payment = {
    id: uuid(),
    order_id: order.id,
    method: body.method,
    amount_cents: body.amount_cents,
    reference_no: body.reference_no ?? '',
    house_tab_id: body.house_tab_id ?? null,
    house_tab_name: tabName,
    recorded_by_user_id: w.me.user_id,
    recorded_at: nowIso(),
  };
  w.payments.push(payment);
  order.paid_cents = quoteFor(order).paid_cents;
  return payment;
}

export function deletePayment(orderId: string, paymentId: string): void {
  const w = getWorld();
  const order = findOrder(orderId);
  const i = w.payments.findIndex((p) => p.id === paymentId && p.order_id === orderId);
  if (i === -1) throw notFound();
  const [removed] = w.payments.splice(i, 1);

  if (removed.method === 'house_tab' && removed.house_tab_id) {
    const tab = w.houseTabs.find((t) => t.id === removed.house_tab_id);
    if (tab) {
      tab.charged_cents -= removed.amount_cents;
      tab.balance_cents -= removed.amount_cents;
      tab.open_charge_count = Math.max(0, tab.open_charge_count - 1);
    }
  }
  order.paid_cents = quoteFor(order).paid_cents;
}

export function reclassifyPayment(
  orderId: string,
  paymentId: string,
  method: PaymentMethod,
): Payment {
  const p = getWorld().payments.find((x) => x.id === paymentId && x.order_id === orderId);
  if (!p) throw notFound();
  p.method = method;
  return p;
}

export function applyAdjustment(
  orderId: string,
  body: { type: OrderAdjustment['type']; amount_cents: number; reason?: string },
): OrderAdjustment {
  const w = getWorld();
  const order = findOrder(orderId);
  const q = quoteFor(order);

  if (body.type === 'discount' && q.discount_cents + body.amount_cents > q.subtotal_cents) {
    throw conflict('discount_exceeds_bill', 'This tab is already fully discounted.');
  }

  const adj: OrderAdjustment = {
    id: uuid(),
    order_id: order.id,
    type: body.type,
    amount_cents: body.amount_cents,
    reason: body.reason ?? '',
    applied_by_user_id: w.me.user_id,
    approved_by_user_id: '',
    created_at: nowIso(),
  };
  w.adjustments.push(adj);
  return adj;
}

export function removeAdjustment(orderId: string, adjId: string): void {
  const w = getWorld();
  const i = w.adjustments.findIndex((a) => a.id === adjId && a.order_id === orderId);
  if (i === -1) throw notFound();
  w.adjustments.splice(i, 1);
}

/**
 * Close the tab. The frozen totals are the point: History and the Dashboard both
 * fold over this same order afterwards, and because nothing recomputes them the
 * two screens can never disagree — including after the reviewer settles a tab
 * mid-demo, which is exactly where a hand-written fixture set would break.
 */
export function closeOrder(orderId: string): SettleQuote {
  const w = getWorld();
  const order = findOrder(orderId);
  if (order.status !== 'open') throw conflict(`already_${order.status}`, `order is ${order.status}`);

  const q = quoteFor(order);
  if (q.subtotal_cents === 0) {
    throw conflict('empty_order', 'cannot close an order with no items — cancel it instead');
  }
  if (q.balance_cents !== 0) {
    throw conflict(
      'balance_outstanding',
      `recorded payments do not equal the total — balance ${formatRs(q.balance_cents)}`,
    );
  }

  order.status = 'closed';
  order.closed_at = nowIso();
  order.subtotal_cents = q.subtotal_cents;
  order.discount_cents = q.discount_cents;
  order.service_charge_cents = q.service_charge_cents;
  order.tax_cents = q.tax_cents;
  order.total_cents = q.total_cents;
  order.paid_cents = q.paid_cents;

  const table = findTable(order.service_table_id);
  if (table && table.status === 'occupied') {
    table.status = w.tenant.preferences.autoCleanTables ? 'free' : 'dirty';
  }
  return q;
}
