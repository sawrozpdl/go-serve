/**
 * Pure kitchen-board logic — split out from the screen so it's exhaustively
 * unit-tested. Handles the in-progress/ready partition, elapsed-time labels,
 * new-ticket detection (drives the alert chime/haptic), and urgency tiers
 * (drives the card's colour escalation). No React, no time source of its own —
 * `now` is always injected so tests are deterministic.
 */
import type { KitchenTicket } from '@cafe-mgmt/api-types';

/** Split the board into its two columns, preserving server order. */
export function partitionTickets(tickets: KitchenTicket[]): {
  inProgress: KitchenTicket[];
  ready: KitchenTicket[];
} {
  const inProgress: KitchenTicket[] = [];
  const ready: KitchenTicket[] = [];
  for (const t of tickets) {
    if (t.kitchen_status === 'ready') ready.push(t);
    else inProgress.push(t);
  }
  return { inProgress, ready };
}

/** Short human elapsed label since `readyAt ?? sentAt` (mirrors the web KDS):
 * `42s`, `7m`, `2h`, or `—` when there's no reference time. */
export function elapsedLabel(now: number, sentAt?: string | null, readyAt?: string | null): string {
  const ref = readyAt ?? sentAt;
  if (!ref) return '—';
  const ms = new Date(ref).getTime();
  if (Number.isNaN(ms)) return '—';
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
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
