import { useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, Wallet, Banknote, HandCoins } from 'lucide-react';

import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { formatNPR } from '@/components/Money';
import { useCreateStaffPay, useCafeOwners, useOwnerCash, useCurrentShift } from '@/lib/api';
import { toast } from '@/lib/toast';

type Props = {
  open: boolean;
  onClose: () => void;
  staffId: string;
  staffName: string;
};

type PaySource = 'bank' | 'drawer' | 'owner_cash';

// Record a single salary payment against a staff member's pay-history ledger.
// A payment also books a matching "Salaries" expense from the chosen source,
// so payroll moves the cafe balance like any other expense.
export function StaffPayModal({ open, onClose, staffId, staffName }: Props) {
  const create = useCreateStaffPay(staffId);
  const owners = useCafeOwners({ activeOnly: true });
  const ownerCash = useOwnerCash();
  const currentShift = useCurrentShift();
  const today = new Date().toISOString().slice(0, 10);

  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('');
  const [note, setNote] = useState('');
  const [paidFrom, setPaidFrom] = useState<PaySource>('bank');
  const [ownerId, setOwnerId] = useState('');

  const ownersList = owners.data ?? [];
  const shiftIsOpen = !!currentShift.data && !currentShift.data.closed_at;
  const ownerHeldCents = ownerCash.data?.holdings.find((h) => h.owner_id === ownerId)?.holding_cents ?? 0;

  const amountNum = parseFloat(amount);
  const amountCents = Number.isFinite(amountNum) && amountNum > 0 ? Math.round(amountNum * 100) : 0;
  const overHolding = paidFrom === 'owner_cash' && amountCents > ownerHeldCents;
  const valid =
    !!paidOn &&
    amountCents > 0 &&
    (paidFrom !== 'owner_cash' || (!!ownerId && !overHolding)) &&
    (paidFrom !== 'drawer' || shiftIsOpen);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    try {
      await create.mutateAsync({
        paid_on: paidOn,
        amount: amountNum,
        period_label: period.trim(),
        note: note.trim(),
        paid_from: paidFrom,
        owner_id: paidFrom === 'owner_cash' ? ownerId : null,
      });
      toast.success('Payment recorded', staffName);
      onClose();
    } catch (err) {
      toast.error('Could not record payment', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  const srcBtn = (key: PaySource, icon: ReactNode, label: string, sub: string, disabled = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={paidFrom === key}
      disabled={disabled}
      onClick={() => setPaidFrom(key)}
      className={`pay-src-btn${paidFrom === key ? ' active' : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '8px 6px',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${paidFrom === key ? 'var(--accent-fg, var(--ink-100))' : 'var(--ink-800)'}`,
        background: paidFrom === key ? 'var(--ink-800)' : 'transparent',
        color: disabled ? 'var(--ink-500)' : 'var(--ink-100)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
      <span style={{ fontSize: 'var(--text-xs)' }}>{label}</span>
      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-400)', letterSpacing: '0.04em' }}>{sub}</span>
    </button>
  );

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

        <label style={{ marginTop: 'var(--space-3)' }}>Paid from</label>
        <div
          role="radiogroup"
          aria-label="paid from"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 'var(--space-2)' }}
        >
          {srcBtn('bank', <Wallet size={14} strokeWidth={1.5} />, 'Bank', 'transfer')}
          {srcBtn(
            'drawer',
            <Banknote size={14} strokeWidth={1.5} />,
            'Drawer',
            shiftIsOpen ? 'cash from till' : 'shift required',
            !shiftIsOpen,
          )}
          {srcBtn(
            'owner_cash',
            <HandCoins size={14} strokeWidth={1.5} />,
            'Owner cash',
            'cash owner holds',
            ownersList.length === 0,
          )}
        </div>

        {paidFrom === 'owner_cash' && (
          <div style={{ marginBottom: 'var(--space-2)' }}>
            <label>Which owner paid it?</label>
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">— pick an owner —</option>
              {ownersList.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.display_name} ({o.share_units}sh)
                </option>
              ))}
            </select>
            {ownerId && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-2xs)',
                  letterSpacing: '0.06em',
                  color: overHolding ? 'var(--danger-fg)' : 'var(--ink-400)',
                  marginTop: 6,
                }}
              >
                {overHolding
                  ? `only holding ${formatNPR(ownerHeldCents)} of cafe cash`
                  : `holding ${formatNPR(ownerHeldCents)}${amountCents > 0 ? ` → ${formatNPR(ownerHeldCents - amountCents)}` : ''}`}
              </div>
            )}
          </div>
        )}

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
