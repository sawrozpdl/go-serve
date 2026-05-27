import { useEffect, useRef, useState } from 'react';

import { Modal } from '@/components/Modal';
import { SearchSelect } from '@/components/SearchSelect';
import { useVoidOrderItem } from '@/lib/api';

const VOID_REASONS = [
  { value: 'customer changed mind', label: 'Customer changed mind' },
  { value: 'wrong order', label: 'Wrong order' },
  { value: 'dropped', label: 'Dropped' },
  { value: 'other', label: 'Other' },
];

export function VoidModal({
  orderId,
  itemId,
  itemName,
  alreadySent,
  onClose,
}: {
  orderId: string;
  itemId: string | null;
  itemName: string;
  /** True when the line has already been sent to the kitchen — reason mandatory. */
  alreadySent: boolean;
  onClose: () => void;
}) {
  const voidIt = useVoidOrderItem();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const last = useRef<string | null>(null);
  useEffect(() => {
    if (itemId !== last.current) {
      setReason('');
      setErr(null);
      last.current = itemId;
    }
  }, [itemId]);

  if (!itemId) return null;

  const subtitle = alreadySent
    ? `${itemName} — sent to kitchen, reason required`
    : `${itemName} — not yet sent, removing immediately`;

  return (
    <Modal open onClose={onClose} title={alreadySent ? 'void item.' : 'remove item.'} subtitle={subtitle}>
      {err && <div className="banner-error">{err}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (alreadySent && !reason.trim()) {
            setErr('reason required');
            return;
          }
          try {
            await voidIt.mutateAsync({ orderId, itemId, reason: reason.trim() });
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        {alreadySent && (
          <>
            <label>Reason</label>
            <SearchSelect
              options={VOID_REASONS}
              value={reason}
              onChange={setReason}
              placeholder="pick a reason"
              required
              autoFocus
            />
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary danger" disabled={voidIt.isPending}>
            {voidIt.isPending
              ? alreadySent
                ? 'Voiding…'
                : 'Removing…'
              : alreadySent
                ? 'Void item'
                : 'Remove'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
