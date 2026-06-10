/* SyncReviewTray
 *
 * Surfaces offline-queued changes that the server REJECTED on replay (the
 * tab was settled on another device, the item vanished, etc.). Nothing is
 * ever silently dropped: each failed op stays here until a human either
 * discards it or re-applies it to a fresh tab.
 */

import { useState } from 'react';
import { AlertTriangle, Trash2, RotateCcw } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { toast } from '@/lib/toast';
import {
  removeOp,
  useNeedsReviewOps,
  type QueuedOp,
  type QueuedAddPayload,
} from '@/lib/offline-queue';
import { useAddOrderItems, useOpenOrder } from '@/lib/api';

export function SyncReviewTray() {
  const ops = useNeedsReviewOps();
  const [open, setOpen] = useState(false);
  const openOrder = useOpenOrder();
  const addItems = useAddOrderItems();

  if (ops.length === 0) return null;

  // Re-apply an add: the original tab is gone (usually settled elsewhere),
  // so open a fresh walk-in tab and add the same lines with NEW ids (the old
  // ids belong to the dead order). Covers "the customer still got the items".
  const reapply = async (op: QueuedOp) => {
    const p = op.payload as QueuedAddPayload;
    try {
      const fresh = await openOrder.mutateAsync({});
      await addItems.mutateAsync({
        orderId: fresh.id,
        items: p.items.map((it) => ({ ...it, id: crypto.randomUUID() })),
      });
      removeOp(op.id);
      toast.success('Re-applied to a new walk-in tab', op.label);
    } catch (e: unknown) {
      toast.error("Couldn't re-apply", (e as { message?: string }).message);
    }
  };

  return (
    <>
      <button type="button" className="sync-review-bar" onClick={() => setOpen(true)}>
        <AlertTriangle size={13} strokeWidth={1.8} aria-hidden="true" />
        {ops.length} offline change{ops.length === 1 ? '' : 's'} need{ops.length === 1 ? 's' : ''} review
        <span className="sync-review-bar__cta">Review</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Changes that couldn't sync"
        subtitle="These were made offline, but the server rejected them when the connection returned"
      >
        <div className="sync-review-list">
          {ops.map((op) => (
            <div key={op.id} className="sync-review-item">
              <div className="sync-review-item__body">
                <div className="sync-review-item__label">{op.label}</div>
                <div className="sync-review-item__why">{explainFailure(op)}</div>
                <div className="sync-review-item__meta">{new Date(op.createdAt).toLocaleString()}</div>
              </div>
              <div className="sync-review-item__actions">
                {op.kind === 'add_items' && (
                  <button
                    type="button"
                    className="btn small"
                    disabled={openOrder.isPending || addItems.isPending}
                    onClick={() => void reapply(op)}
                    title="Add the same items to a new walk-in tab"
                  >
                    <RotateCcw size={13} strokeWidth={1.7} /> Re-apply
                  </button>
                )}
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    removeOp(op.id);
                    toast.info('Change discarded', op.label);
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.7} /> Discard
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="field-hint" style={{ marginTop: 'var(--space-3)' }}>
          "Re-apply" puts the same items on a fresh walk-in tab — use it when the customer was
          served but their original tab was settled from another device. "Discard" forgets the
          change; nothing was recorded on the server.
        </p>
      </Modal>
    </>
  );
}

function explainFailure(op: QueuedOp): string {
  switch (op.failure?.code) {
    case 'order_not_open':
      return 'This tab was settled or cancelled on another device before the change synced.';
    case 'not_found':
      return 'The line no longer exists on the server.';
    case 'menu_item_not_found':
      return 'That menu item is no longer available.';
    case 'item_id_conflict':
      return 'The change collided with another device’s edit.';
    default:
      return op.failure?.message || 'The server rejected this change.';
  }
}
