import { useState } from 'react';

import { Modal } from '@/components/Modal';
import { useSetMyPin } from '@/lib/api';

export function PinModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setPin = useSetMyPin();
  const [pin, setPinValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = () => {
    setPinValue('');
    setConfirm('');
    setErr(null);
    setDone(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Approval PIN"
      subtitle="For voids + discounts"
    >
      {done && (
        <div
          style={{
            background: 'var(--ok-bg)',
            border: '1px solid var(--ok-border)',
            color: 'var(--lime-fg)',
            padding: '10px 14px',
            borderRadius: 2,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.06em',
            marginBottom: 14,
          }}
        >
          PIN saved. Hand it to your trusted staff.
        </div>
      )}
      {err && <div className="banner-error">{err}</div>}

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (pin === '') {
            try {
              await setPin.mutateAsync({ pin: '' });
              setDone(true);
            } catch (e: unknown) {
              setErr((e as { message?: string }).message ?? 'Failed');
            }
            return;
          }
          if (pin.length < 4 || pin.length > 8) {
            setErr('PIN must be 4-8 characters');
            return;
          }
          if (pin !== confirm) {
            setErr('PINs do not match');
            return;
          }
          try {
            await setPin.mutateAsync({ pin });
            setDone(true);
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>New PIN (leave blank to clear)</label>
        <input
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={(e) => {
            setPinValue(e.target.value);
            setDone(false);
          }}
          autoComplete="new-password"
          autoFocus
        />
        {pin !== '' && (
          <>
            <label>Confirm PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose();
              reset();
            }}
          >
            Done
          </button>
          <button type="submit" className="btn primary" disabled={setPin.isPending}>
            {setPin.isPending ? 'Saving…' : pin === '' ? 'Clear PIN' : 'Save PIN'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
