/**
 * Offline mutation queue (M5). While the device is offline, order mutations
 * (add line / change qty / void pending line / send to kitchen) are captured
 * here instead of failing, then replayed strictly FIFO **per order** on
 * reconnect (see ./replay). Independent tabs replay concurrently.
 *
 * Persisted to MMKV (entries are tiny) so it survives an app restart. Mirrors
 * web's `lib/offline-queue.ts` — a plain persisted array, NOT SQLite: the ops
 * are small and every operation is idempotent server-side (client line ids +
 * ON CONFLICT for add; void/send are naturally replay-safe), so a double
 * replay is harmless and we don't need transactional storage or a
 * fetch-before-retry reconciliation step.
 *
 * Money movement (payments / close / discounts) is deliberately NOT queueable —
 * settlement needs server truth; those actions are disabled offline instead.
 *
 * An op the server REJECTS on replay (tab settled elsewhere, item gone) becomes
 * 'needs_review' — surfaced in the Sync Review tray, never silently dropped.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as Crypto from 'expo-crypto';
import { mmkvStorage } from '../lib/zustandStorage';

export type QueuedOpKind = 'add_items' | 'update_item' | 'void_item' | 'send_kitchen';

export type QueuedAddPayload = {
  items: { id: string; menu_item_id: string; qty: number; notes?: string; modifiers?: unknown }[];
};
export type QueuedUpdatePayload = {
  itemId: string;
  patch: { qty?: number; notes?: string; modifiers?: unknown };
};
export type QueuedVoidPayload = { itemId: string; reason: string };

export type QueuedOpStatus = 'queued' | 'replaying' | 'needs_review';
export type QueuedFailure = { status: number; code?: string; message: string };

export type QueuedOp = {
  id: string;
  tenantSlug: string;
  orderId: string;
  kind: QueuedOpKind;
  payload: QueuedAddPayload | QueuedUpdatePayload | QueuedVoidPayload | Record<string, never>;
  /** Human description for the review tray, e.g. "2× Cappuccino". */
  label: string;
  createdAt: number;
  status: QueuedOpStatus;
  failure?: QueuedFailure;
};

// ── Pure reducers (unit-tested; the store just wraps these) ─────────────────

export function addOp(ops: QueuedOp[], op: QueuedOp): QueuedOp[] {
  return [...ops, op];
}

export function removeOpFrom(ops: QueuedOp[], id: string): QueuedOp[] {
  return ops.filter((o) => o.id !== id);
}

export function setStatusIn(
  ops: QueuedOp[],
  id: string,
  status: QueuedOpStatus,
  failure?: QueuedFailure,
): QueuedOp[] {
  return ops.map((o) => (o.id === id ? { ...o, status, failure } : o));
}

/** Ops still waiting to sync for one order (excludes needs_review). */
export function opsForOrder(ops: QueuedOp[], orderId: string): QueuedOp[] {
  return ops.filter((o) => o.orderId === orderId && o.status !== 'needs_review');
}

/** Failed replays awaiting a human decision (the review tray). */
export function needsReviewOps(ops: QueuedOp[]): QueuedOp[] {
  return ops.filter((o) => o.status === 'needs_review');
}

/** Ops eligible to replay now (anything not parked for review). */
export function replayableOps(ops: QueuedOp[]): QueuedOp[] {
  return ops.filter((o) => o.status !== 'needs_review');
}

/** Line ids with a queued (unsynced) op touching them — drives the per-line
 * "pending sync" glyph in the tab view. */
export function queuedLineIds(ops: QueuedOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'add_items') {
      for (const it of (op.payload as QueuedAddPayload).items) ids.add(it.id);
    } else if (op.kind === 'update_item' || op.kind === 'void_item') {
      ids.add((op.payload as QueuedUpdatePayload | QueuedVoidPayload).itemId);
    }
  }
  return ids;
}

/** Group ops by order, preserving enqueue order within each group. */
export function groupByOrder(ops: QueuedOp[]): Map<string, QueuedOp[]> {
  const byOrder = new Map<string, QueuedOp[]>();
  for (const op of ops) {
    const chain = byOrder.get(op.orderId) ?? [];
    chain.push(op);
    byOrder.set(op.orderId, chain);
  }
  return byOrder;
}

// ── Store + non-React accessors ─────────────────────────────────────────────

type QueueState = { ops: QueuedOp[] };

export const useOfflineQueue = create<QueueState>()(
  persist(() => ({ ops: [] as QueuedOp[] }), {
    name: 'goserve-offline-queue',
    storage: createJSONStorage(() => mmkvStorage),
  }),
);

export function enqueueOp(
  op: Pick<QueuedOp, 'tenantSlug' | 'orderId' | 'kind' | 'payload' | 'label'>,
): QueuedOp {
  const full: QueuedOp = {
    ...op,
    id: Crypto.randomUUID(),
    createdAt: Date.now(),
    status: 'queued',
  };
  useOfflineQueue.setState((s) => ({ ops: addOp(s.ops, full) }));
  return full;
}

export function removeOp(id: string): void {
  useOfflineQueue.setState((s) => ({ ops: removeOpFrom(s.ops, id) }));
}

export function setOpStatus(id: string, status: QueuedOpStatus, failure?: QueuedFailure): void {
  useOfflineQueue.setState((s) => ({ ops: setStatusIn(s.ops, id, status, failure) }));
}

export function getQueuedOps(): QueuedOp[] {
  return useOfflineQueue.getState().ops;
}
