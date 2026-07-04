// Orders, tabs, order history, payments, and kitchen tickets.
import type { VatMode } from './tenant';

export type ServiceTable = {
  id: string;
  name: string;
  capacity: number;
  area: string;
  status: 'free' | 'occupied' | 'reserved' | 'dirty';
  /** Lucide icon name. Empty = default chair glyph. */
  icon: string;
  sort: number;
};

/** Render a line quantity for display. Whole numbers show plainly ("3");
 *  half-plate quantities use the ½ glyph ("½", "1½", "3½"). Any other
 *  fraction (shouldn't occur) falls back to a trimmed decimal. Shared so the
 *  POS, kitchen board, receipts, and history all format qty identically.
 *
 *  Pass `ascii: true` for thermal printing — most ESC/POS codepages lack the
 *  ½ glyph, so halves render as "1/2" / "3 1/2" instead. */
export function formatQty(qty: number, ascii = false): string {
  const whole = Math.floor(qty);
  const frac = qty - whole;
  if (Math.abs(frac) < 1e-6) return String(whole);
  if (Math.abs(frac - 0.5) < 1e-6) {
    if (ascii) return whole === 0 ? '1/2' : `${whole} 1/2`;
    return whole === 0 ? '½' : `${whole}½`;
  }
  return String(Math.round(qty * 100) / 100);
}

export type OrderStatus = 'open' | 'closed' | 'cancelled';

export type KitchenStatus = 'pending' | 'in_progress' | 'ready' | 'served';

export type OrderItemRow = {
  id: string;
  order_id: string;
  menu_item_id: string;
  menu_item_name: string;
  qty: number;
  unit_price_cents: number;
  line_cents: number;
  modifiers: unknown;
  notes: string;
  kitchen_status: KitchenStatus;
  sent_to_kitchen_at?: string | null;
  ready_at?: string | null;
  served_at?: string | null;
  voided_at?: string | null;
  void_reason?: string | null;
  created_at: string;
};

export type Order = {
  id: string;
  service_table_id?: string | null;
  service_table_name?: string | null;
  // Free-text name for a walk-in / "Unknown +" tab (no real table). Empty
  // string when unnamed; on a real table service_table_name takes priority.
  table_label?: string;
  status: OrderStatus;
  opened_by_user_id: string;
  opened_at: string;
  closed_at?: string | null;
  notes: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  service_charge_cents: number;
  total_cents: number;
  live_subtotal_cents: number;
  items?: OrderItemRow[];
  // Per-status non-voided item counts. Populated by list+get; lets the
  // floor + tab pages show "all served · settle pending" style labels
  // without loading every order's full item array.
  items_pending: number;
  items_in_progress: number;
  items_ready: number;
  items_served: number;
  items_total: number;
  paid_cents: number;
};

/**
 * Resolve a tab's display name. Priority: a real table's registry name wins;
 * otherwise the free-text walk-in label; otherwise the fallback ("Walk-in" on
 * the floor/kitchen/history, "Take-away" inside the tab).
 */
export function resolveTableLabel(
  o: { service_table_name?: string | null; table_label?: string | null },
  fallback = 'Walk-in',
): string {
  return o.service_table_name ?? (o.table_label?.trim() || fallback);
}

export type TabState = {
  key:
    | 'empty'
    | 'ordering'
    | 'cooking'
    | 'ready-to-serve'
    | 'served-settle'
    | 'served-partial-paid'
    | 'new-items-after-send';
  /** Short label, lowercase. Suitable for a pill. */
  label: string;
  /** One-line description for tooltip / secondary text. */
  hint: string;
  /** Tone bucket for styling. */
  tone: 'neutral' | 'info' | 'warn' | 'action' | 'success';
};

/**
 * Derive a single, action-oriented label for an OPEN tab from its item-status
 * counts and paid amount. Priority is ordered by who needs to do something
 * next: server action (ready to serve) > waiting on kitchen > waiting on the
 * cashier (settle) > nothing yet. Returns null for closed/cancelled orders —
 * those have their own status field.
 */
export function deriveTabState(o: Order): TabState | null {
  if (o.status !== 'open') return null;

  const total = o.items_total ?? 0;
  const pending = o.items_pending ?? 0;
  const inProg = o.items_in_progress ?? 0;
  const ready = o.items_ready ?? 0;
  const served = o.items_served ?? 0;
  const inFlight = pending + inProg + ready;

  if (total === 0) {
    return { key: 'empty', label: 'new tab', hint: 'no items yet', tone: 'neutral' };
  }
  if (ready > 0) {
    return {
      key: 'ready-to-serve',
      label: `${ready} ready · serve`,
      hint: 'kitchen has items ready to be served',
      tone: 'action',
    };
  }
  if (pending > 0 && served > 0 && inProg === 0) {
    return {
      key: 'new-items-after-send',
      label: `${pending} new · send to kitchen`,
      hint: 'new items added to a partly-served tab',
      tone: 'warn',
    };
  }
  if (inProg > 0) {
    return {
      key: 'cooking',
      label: pending > 0 ? `${inProg} cooking · ${pending} not sent` : `${inProg} cooking`,
      hint: 'kitchen is working on items',
      tone: 'info',
    };
  }
  if (pending > 0) {
    return {
      key: 'ordering',
      label: `${pending} not sent`,
      hint: 'items added but not sent to kitchen yet',
      tone: 'warn',
    };
  }
  // All non-voided items are served (inFlight === 0, served === total).
  if (inFlight === 0 && served === total) {
    if ((o.paid_cents ?? 0) === 0) {
      return {
        key: 'served-settle',
        label: 'all served · settle',
        hint: 'every item served — collect payment to close',
        tone: 'action',
      };
    }
    return {
      key: 'served-partial-paid',
      label: 'all served · part paid',
      hint: 'partial payment recorded — collect balance to close',
      tone: 'action',
    };
  }
  return { key: 'empty', label: 'open tab', hint: '', tone: 'neutral' };
}

/** Add-items vars: every item MUST carry a client-generated UUID (`id`).
 *  The server inserts with ON CONFLICT DO NOTHING, so retries and offline
 *  replays of the same payload are exactly-once. */
export type AddOrderItemsVars = {
  orderId: string;
  items: { id: string; menu_item_id: string; qty: number; notes?: string; modifiers?: unknown }[];
  // When set, a single optimistic line is inserted into the cache immediately
  // (used by the tab picker so rapid taps show up without the round-trip).
  optimistic?: { menu_item_name: string; unit_price_cents: number };
};

export type HistoryPayment = {
  id: string;
  method: PaymentMethod;
  amount_cents: number;
  reference_no: string;
  // True when the payment may be flipped cash↔online (cash/online method on a
  // still-open shift). House-tab charges and closed-shift payments are false.
  reclassifiable: boolean;
};

export type HistoryOrder = {
  id: string;
  service_table_id?: string | null;
  service_table_name?: string | null;
  table_label?: string;
  opened_at: string;
  closed_at?: string | null;
  notes: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  service_charge_cents: number;
  total_cents: number;
  item_count: number;
  items: OrderItemRow[];
  payments: HistoryPayment[];
};

export type OrderHistoryResp = {
  date: string;
  timezone: string;
  orders: HistoryOrder[];
};

export type AdjustmentType = 'discount' | 'service_charge' | 'tax_override';

export type OrderAdjustment = {
  id: string;
  order_id: string;
  type: AdjustmentType;
  amount_cents: number;
  reason: string;
  applied_by_user_id: string;
  approved_by_user_id: string;
  created_at: string;
};

// Wire-level payment method. New rows write 'cash' / 'online' / 'house_tab';
// the older values still appear on historical rows (esewa / khalti / card /
// other). UI consumers display anything outside the canonical set as
// "Online" — see SettleModal.METHOD_DISPLAY.
export type PaymentMethod =
  | 'cash'
  | 'online'
  | 'esewa'
  | 'khalti'
  | 'card'
  | 'other'
  | 'house_tab';

export type Payment = {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  reference_no: string;
  house_tab_id?: string | null;
  house_tab_name?: string | null;
  recorded_by_user_id: string;
  recorded_at: string;
};

export type SettleQuote = {
  subtotal_cents: number;
  discount_cents: number;
  service_charge_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  service_charge_pct: string;
  vat_pct: string;
  vat_mode: VatMode;
};

export type KitchenTicket = {
  item_id: string;
  order_id: string;
  service_table_name?: string | null;
  table_label?: string;
  menu_item_name: string;
  qty: number;
  modifiers: unknown;
  notes: string;
  kitchen_status: 'in_progress' | 'ready';
  sent_to_kitchen_at?: string | null;
  ready_at?: string | null;
};
