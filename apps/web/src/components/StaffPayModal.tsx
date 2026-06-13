import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { useCreateStaffPay } from '@/lib/api';
import { toast } from '@/lib/toast';

type Props = {
  open: boolean;
  onClose: () => void;
  staffId: string;
  staffName: string;
};

// Record a single salary payment against a staff member's pay-history ledger.
export function StaffPayModal({ open, onClose, staffId, staffName }: Props) {
  const create = useCreateStaffPay(staffId);
  const today = new Date().toISOString().slice(0, 10);

  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('');
  const [note, setNote] = useState('');

  const amountNum = parseFloat(amount);
  const valid = !!paidOn && Number.isFinite(amountNum) && amountNum > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    try {
      await create.mutateAsync({
        paid_on: paidOn,
        amount: amountNum,
        period_label: period.trim(),
        note: note.trim(),
      });
      toast.success('Payment recorded', staffName);
      onClose();
    } catch (err) {
      toast.error('Could not record payment', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record payment" subtitle={staffName}>
      <form onSubmit={onSubmit}>
        <div className="row-inputs">
          <div>
            <label>Paid on</label>
            <DatePicker value={paidOn} onChange={setPaidOn} max={today} placeholder="Pick a date" />
          </div>
          <div>
            <label>Amount (रू)</label>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 25000"
              autoFocus
            />
          </div>
        </div>

        <label>Period</label>
        <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="e.g. May 2026 (optional)" />

        <label>Note</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid || create.isPending}>
            {create.isPending ? <Loader2 size={14} className="spin" /> : null}
            Record payment
          </button>
        </div>
      </form>
    </Modal>
  );
}
