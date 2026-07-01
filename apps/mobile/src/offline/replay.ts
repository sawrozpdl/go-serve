/**
 * Offline replay engine (M5). Drains the queue when connectivity returns,
 * strictly FIFO per order (preserving add → edit → void → send causality within
 * a tab) while independent tabs replay concurrently.
 *
 * Failure handling mirrors web:
 *   status 0   — still offline: op back to 'queued', retry next transition
 *   5xx        — transient server trouble: keep 'queued', retry later
 *   4xx        — server rejected (tab settled elsewhere, item gone): mark
 *                'needs_review' and HALT that order's chain (later ops likely
 *                depend on the failed one). Surfaced in the tray, never dropped.
 *
 * Idempotency (client line ids + ON CONFLICT for add; replay-safe void/send)
 * makes a double replay after an app-kill-mid-flight harmless — so we retry
 * rather than fetch-and-diff.
 */
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  getQueuedOps,
  removeOp,
  setOpStatus,
  replayableOps,
  groupByOrder,
  type QueuedOp,
  type QueuedAddPayload,
  type QueuedUpdatePayload,
  type QueuedVoidPayload,
} from './queue';

/** How to treat a failed replay attempt. */
export function classifyFailure(status: number): 'retry' | 'review' {
  // 0 = network down (still offline); 5xx = transient. Both retry later.
  if (status === 0 || status >= 500) return 'retry';
  return 'review'; // 4xx: the server rejected it — needs a human.
}

/** Fire the real network request for one queued op. */
export function execQueuedOp(op: QueuedOp): Promise<unknown> {
  switch (op.kind) {
    case 'add_items': {
      const p = op.payload as QueuedAddPayload;
      return api.post(`/v1/orders/${op.orderId}/items`, { items: p.items }, { tenantSlug: op.tenantSlug });
    }
    case 'update_item': {
      const p = op.payload as QueuedUpdatePayload;
      return api.patch(`/v1/orders/${op.orderId}/items/${p.itemId}`, p.patch, { tenantSlug: op.tenantSlug });
    }
    case 'void_item': {
      const p = op.payload as QueuedVoidPayload;
      return api.post(`/v1/orders/${op.orderId}/items/${p.itemId}/void`, { reason: p.reason }, { tenantSlug: op.tenantSlug });
    }
    case 'send_kitchen':
      return api.post(`/v1/orders/${op.orderId}/send-to-kitchen`, {}, { tenantSlug: op.tenantSlug });
  }
}

export type ReplayDeps = {
  getOps: () => QueuedOp[];
  setStatus: (id: string, status: QueuedOp['status'], failure?: QueuedOp['failure']) => void;
  remove: (id: string) => void;
  exec: (op: QueuedOp) => Promise<unknown>;
  /** Invalidate the keys the replay touched (order/orders/tables/kitchen). */
  onTouched: (orderIds: string[]) => void;
};

/**
 * Core orchestrator (dependency-injected so it's unit-testable without a real
 * queue or network). Returns the set of orderIds that had ≥1 successful replay.
 */
export async function runReplay(deps: ReplayDeps): Promise<Set<string>> {
  const ops = replayableOps(deps.getOps());
  const touched = new Set<string>();
  if (ops.length === 0) return touched;

  await Promise.all(
    [...groupByOrder(ops).values()].map(async (chain) => {
      for (const op of chain) {
        deps.setStatus(op.id, 'replaying');
        try {
          await deps.exec(op);
          deps.remove(op.id);
          touched.add(op.orderId);
        } catch (e) {
          const status = (e as { status?: number }).status ?? 0;
          if (classifyFailure(status) === 'retry') {
            deps.setStatus(op.id, 'queued');
          } else {
            const err = e as { status?: number; code?: string; message?: string };
            deps.setStatus(op.id, 'needs_review', {
              status: err.status ?? 0,
              code: err.code,
              message: err.message ?? 'Rejected on sync',
            });
          }
          return; // halt this order's chain either way
        }
      }
    }),
  );

  if (touched.size > 0) deps.onTouched([...touched]);
  return touched;
}

let replayInFlight = false;

/** App-facing entry point: wires the real queue + api + cache invalidation and
 * guards against overlapping runs. */
export async function replayQueuedOps(qc: QueryClient): Promise<void> {
  if (replayInFlight) return;
  replayInFlight = true;
  try {
    await runReplay({
      getOps: getQueuedOps,
      setStatus: setOpStatus,
      remove: removeOp,
      exec: execQueuedOp,
      onTouched: () => {
        // ['order'] / ['orders'] are prefix matches → every open order + list
        // refetches to server truth for whatever the replay changed.
        void qc.invalidateQueries({ queryKey: ['order'] });
        void qc.invalidateQueries({ queryKey: ['orders'] });
        void qc.invalidateQueries({ queryKey: ['tables'] });
        void qc.invalidateQueries({ queryKey: ['kitchen-tickets'] });
      },
    });
  } finally {
    replayInFlight = false;
  }
}
