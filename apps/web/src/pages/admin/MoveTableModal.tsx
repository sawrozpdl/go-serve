import { useState } from 'react';
import { Armchair, Coffee, ArrowRight, GitMerge } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { IconGlyph } from '@/components/IconPicker';
import { formatNPR } from '@/components/Money';
import { useConfirm } from '@/components/ConfirmDialog';
import { useServiceTables, useOrders, useMoveOrder, type Order } from '@/lib/api';
import { toast } from '@/lib/toast';

// Reassign an open tab to another table (or detach to take-away). When the
// target table already has an open tab, the move becomes a merge: this tab's
// items fold into that one. Used from the TabPage Move action and to assign a
// walk-in / "Unknown" tab to a table.
export function MoveTableModal({
  open,
  orderId,
  currentTableId,
  onClose,
  onMoved,
}: {
  open: boolean;
  orderId: string;
  currentTableId: string | null;
  onClose: () => void;
  // resultId is the surviving order id (the destination tab on a merge);
  // merged distinguishes a merge from a plain transfer/detach.
  onMoved: (resultId: string, merged: boolean) => void;
}) {
  const tables = useServiceTables();
  const openOrders = useOrders('open');
  const move = useMoveOrder();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const openByTable = new Map<string, Order>();
  for (const o of openOrders.data ?? []) {
    if (o.service_table_id) openByTable.set(o.service_table_id, o);
  }

  const doMove = async (targetId: string | null, mergeInto: Order | null) => {
    if (mergeInto) {
      const ok = await confirm({
        title: 'Merge into that tab?',
        message:
          'That table already has an open tab. This will move every item from this tab onto it and close this one. This can’t be undone.',
        confirmLabel: 'Merge tabs',
        cancelLabel: 'Back',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await move.mutateAsync({ orderId, service_table_id: targetId });
      toast.success(
        res.merged ? 'Tabs merged' : targetId ? 'Tab moved' : 'Moved to take-away',
      );
      onMoved(res.order_id, res.merged);
    } catch (e: unknown) {
      toast.error('Could not move tab', (e as { message?: string }).message);
    } finally {
      setBusy(false);
    }
  };

  const others = (tables.data ?? []).filter((t) => t.id !== currentTableId);

  return (
    <Modal open={open} title="Move / merge tab" subtitle="reassign this tab to another table" onClose={onClose}>
      <div className="move-list">
        {currentTableId && (
          <button
            type="button"
            className="move-option"
            disabled={busy}
            onClick={() => doMove(null, null)}
          >
            <span className="move-icon" aria-hidden>
              <Coffee size={16} strokeWidth={1.5} />
            </span>
            <span className="move-main">
              <strong>Take-away</strong>
              <span className="move-sub">detach from the table</span>
            </span>
            <ArrowRight size={14} strokeWidth={1.5} />
          </button>
        )}

        {others.map((t) => {
          const oo = openByTable.get(t.id);
          const isMerge = !!oo && oo.id !== orderId;
          return (
            <button
              key={t.id}
              type="button"
              className={`move-option${isMerge ? ' merge' : ''}`}
              disabled={busy}
              onClick={() => doMove(t.id, isMerge ? oo! : null)}
            >
              <span className="move-icon" aria-hidden>
                <IconGlyph name={t.icon} size={16} fallback={<Armchair size={16} strokeWidth={1.5} />} />
              </span>
              <span className="move-main">
                <strong>{t.name}</strong>
                <span className="move-sub">
                  {isMerge
                    ? `merge — open tab ${formatNPR(oo!.live_subtotal_cents)}`
                    : t.status === 'free'
                      ? 'free'
                      : t.status}
                </span>
              </span>
              {isMerge ? <GitMerge size={14} strokeWidth={1.5} /> : <ArrowRight size={14} strokeWidth={1.5} />}
            </button>
          );
        })}

        {others.length === 0 && !currentTableId && (
          <div className="empty-state">No other tables set up yet.</div>
        )}
      </div>
    </Modal>
  );
}
