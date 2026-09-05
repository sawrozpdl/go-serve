/**
 * Pure kitchen-board logic — split out from the screen so it's exhaustively
 * unit-tested. Handles the in-progress/ready partition, elapsed-time labels,
 * new-ticket detection (drives the alert chime/haptic), and urgency tiers
 * (drives the card's colour escalation). No React, no time source of its own —
 * `now` is always injected so tests are deterministic.
 */
import type { KitchenTicket, Order } from '@cafe-mgmt/api-types';
import type { QueuedOp } from '../offline/queue';

/** A board card. `pendingSync` marks one sent to the kitchen while offline —
 *  queued on this device, not yet known to the server. */
export type BoardTicket = KitchenTicket & { pendingSync?: boolean };

/**
 * Tickets implied by queued `send_kitchen` ops.
 *
 * An offline send already flipped the order's pending lines to `in_progress`
 * in the persisted `['order', slug, id]` cache, so projecting those lines back
 * out keeps a single-tablet cafe's board working with no network at all —
 * previously the board simply went blank the moment the wifi dropped.
 *
 * Pure: the caller supplies the ops and a cache reader, so this unit-tests
 * without React or a QueryClient.
 */
export function pendingSyncTickets(
  ops: QueuedOp[],
  slug: string | null,
  readOrder: (orderId: string) => Order | undefined,
): BoardTicket[] {
  const out: BoardTicket[] = [];
  if (!slug) return out;
  for (const op of ops) {
    if (op.kind !== 'send_kitchen' || op.status === 'needs_review') continue;
    if (op.tenantSlug !== slug) continue;
    const order = readOrder(op.orderId);
    for (const i of order?.items ?? []) {
      if (i.voided_at || i.kitchen_status !== 'in_progress') continue;
      out.push({
        item_id: i.id,
        order_id: op.orderId,
        service_table_name: order?.service_table_name ?? null,
        table_label: order?.table_label ?? '',
        menu_item_name: i.menu_item_name,
        qty: i.qty,
        add_ons: i.add_ons ?? [],
        modifiers: i.modifiers,
        notes: i.notes,
        kitchen_status: 'in_progress',
        sent_to_kitchen_at: i.sent_to_kitchen_at,
        ready_at: null,
        pendingSync: true,
      } as BoardTicket);
    }
  }
  return out;
}

/**
 * Merge queued offline sends into the server board; the SERVER wins on
 * conflict. When replay drains the queue it invalidates `['kitchen-tickets']`,
 * so a pending card is seamlessly replaced by its real ticket.
 */
export function mergeBoard(server: KitchenTicket[] | undefined, pending: BoardTicket[]): BoardTicket[] {
  const serverIds = new Set((server ?? []).map((t) => t.item_id));
  return [...(server ?? []), ...pending.filter((p) => !serverIds.has(p.item_id))];
}

/** Split the board into its two columns, preserving server order. */
export function partitionTickets<T extends KitchenTicket>(tickets: T[]): {
  inProgress: T[];
  ready: T[];
} {
  const inProgress: T[] = [];
  const ready: T[] = [];
  for (const t of tickets) {
    if (t.kitchen_status === 'ready') ready.push(t);
    else inProgress.push(t);
  }
  return { inProgress, ready };
}

/** Short human elapsed label since `readyAt ?? sentAt` (mirrors the web KDS):
 * `42s`, `7m`, `2h`, `3d`, or `—` when there's no reference time. */
export function elapsedLabel(now: number, sentAt?: string | null, readyAt?: string | null): string {
  const ref = readyAt ?? sentAt;
  if (!ref) return '—';
  const ms = new Date(ref).getTime();
  if (Number.isNaN(ms)) return '—';
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * Detect newly-arrived in-progress tickets so the board can chime/buzz only on
 * genuinely new items (not every refetch). The first call (prev === null) seeds
 * the set and reports no new items, so an existing queue doesn't alert on open.
 */
export function findNewInProgress(
  prev: Set<string> | null,
  tickets: KitchenTicket[],
): { ids: Set<string>; hasNew: boolean } {
  const ids = new Set<string>();
  for (const t of tickets) if (t.kitchen_status === 'in_progress') ids.add(t.item_id);
  if (prev === null) return { ids, hasNew: false };
  let hasNew = false;
  for (const id of ids) {
    if (!prev.has(id)) {
      hasNew = true;
      break;
    }
  }
  return { ids, hasNew };
}

export type Urgency = 'fresh' | 'warn' | 'urgent';

/** Colour tier from how long a ticket has been waiting (minutes since `ref`).
 * <6m fresh, 6–12m warn, ≥12m urgent. Missing/invalid ref = fresh. */
export function ticketUrgency(now: number, ref?: string | null): Urgency {
  if (!ref) return 'fresh';
  const ms = new Date(ref).getTime();
  if (Number.isNaN(ms)) return 'fresh';
  const min = Math.max(0, (now - ms) / 60000);
  if (min >= 12) return 'urgent';
  if (min >= 6) return 'warn';
  return 'fresh';
}
