/* Offline mutation queue.
 *
 * While the device is offline, order mutations (add line / change qty / void
 * pending line / send to kitchen) are captured here instead of failing. The
 * queue is persisted to localStorage (entries are tiny) so it survives a
 * reload, and replays strictly FIFO **per order** on reconnect — preserving
 * add → edit → void → send causality within a tab while letting independent
 * tabs replay concurrently. Replay lives in lib/offline-replay.ts.
 *
 * Money movement (payments / close / discounts) is deliberately NOT queueable:
 * settlement needs server truth (authoritative quote, cash drawer, another
 * device may have settled first). Those actions are disabled offline instead.
 *
 * An op that the server rejects on replay (tab settled elsewhere, item gone)
 * becomes 'needs_review' — surfaced in the SyncReviewTray, never silently
 * dropped.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type QueuedOpKind = 'add_items' | 'update_item' | 'void_item' | 'send_kitchen';

export type QueuedAddPayload = {
  items: { id: string; menu_item_id: string; qty: number; notes?: string; modifiers?: unknown }[];
};
export type QueuedUpdatePayload = {
  itemId: string;
  patch: { qty?: number; notes?: string; modifiers?: unknown };
};
export type QueuedVoidPayload = { itemId: string; reason: string };

export type QueuedOp = {
  id: string;
  tenantSlug: string;
  orderId: string;
  kind: QueuedOpKind;
  payload: QueuedAddPayload | QueuedUpdatePayload | QueuedVoidPayload | Record<string, never>;
  /** Human description for the review tray, e.g. "2× Cappuccino". */
  label: string;
  createdAt: number;
  status: 'queued' | 'replaying' | 'needs_review';
  failure?: { status: number; code?: string; message: string };
};

type QueueState = {
  ops: QueuedOp[];
};

export const useOfflineQueue = create<QueueState>()(
  persist(() => ({ ops: [] as QueuedOp[] }), {
    name: 'cafe-offline-queue',
  }),
);

export function enqueueOp(
  op: Pick<QueuedOp, 'tenantSlug' | 'orderId' | 'kind' | 'payload' | 'label'>,
): QueuedOp {
  const full: QueuedOp = {
    ...op,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    status: 'queued',
  };
  useOfflineQueue.setState((s) => ({ ops: [...s.ops, full] }));
  return full;
}

export function removeOp(id: string) {
  useOfflineQueue.setState((s) => ({ ops: s.ops.filter((o) => o.id !== id) }));
}

export function setOpStatus(id: string, status: QueuedOp['status'], failure?: QueuedOp['failure']) {
  useOfflineQueue.setState((s) => ({
    ops: s.ops.map((o) => (o.id === id ? { ...o, status, failure } : o)),
  }));
}

export function getQueuedOps(): QueuedOp[] {
  return useOfflineQueue.getState().ops;
}

/** Ops still waiting to sync for one order (excludes needs_review).
 *  Selects the stable ops array and derives via useMemo — an inline filter
 *  selector would mint a fresh array every check and loop the subscription. */
export function useQueuedOpsForOrder(orderId: string | undefined): QueuedOp[] {
  const ops = useOfflineQueue((s) => s.ops);
  return useMemo(
    () =>
      orderId ? ops.filter((o) => o.orderId === orderId && o.status !== 'needs_review') : EMPTY_OPS,
    [ops, orderId],
  );
}

/** Failed replays awaiting a human decision (Phase C review tray). */
export function useNeedsReviewOps(): QueuedOp[] {
  const ops = useOfflineQueue((s) => s.ops);
  return useMemo(() => ops.filter((o) => o.status === 'needs_review'), [ops]);
}

const EMPTY_OPS: QueuedOp[] = [];

/** Line ids that have a queued (unsynced) op touching them — drives the
 *  per-line "pending sync" glyph in the tab view. */
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
