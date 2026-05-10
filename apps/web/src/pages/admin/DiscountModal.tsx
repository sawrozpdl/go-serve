import { useEffect, useRef, useState } from 'react';

import { Modal } from '@/components/Modal';
import { ApprovalFields } from '@/components/ApprovalFields';
import { SearchSelect } from '@/components/SearchSelect';
import { formatNPR, parsePriceInput } from '@/components/Money';

const DISCOUNT_REASONS = [
  { value: 'regular', label: 'Regular' },
  { value: 'promotion', label: 'Promotion' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'staff', label: 'Staff' },
  { value: 'friends', label: 'Friends' },
  { value: 'other', label: 'Other' },
];
import {
  useApplyAdjustment,
  useOrderAdjustments,
  useRemoveAdjustment,
  useSettleQuote,
} from '@/lib/api';
import { Trash2 } from 'lucide-react';

type Mode = 'percent' | 'flat';

export function DiscountModal({
  open,
  orderId,
  onClose,
}: {
  open: boolean;
  orderId: string;
  onClose: () => void;
}) {
  const quote = useSettleQuote(open ? orderId : undefined);
  const list = useOrderAdjustments(open ? orderId : undefined);
  const apply = useApplyAdjustment();
  const remove = useRemoveAdjustment();

  const [mode, setMode] = useState<Mode>('percent');
  const [amountStr, setAmountStr] = useState('');
  const [reason, setReason] = useState('');
  const [approver, setApprover] = useState({ email: '', pin: '' });
  const [err, setErr] = useState<string | null>(null);

  const last = useRef(false);
  useEffect(() => {
    if (open !== last.current && open) {
      setMode('percent');
      setAmountStr('');
      setReason('');
      setApprover({ email: '', pin: '' });
      setErr(null);
    }
    last.current = open;
  }, [open]);

  const subtotal = quote.data?.subtotal_cents ?? 0;
  const computed = (() => {
    if (!amountStr) return 0;
    if (mode === 'percent') {
      const pct = parseFloat(amountStr);
      if (isNaN(pct) || pct <= 0) return 0;
      return Math.round((subtotal * pct) / 100);
    }
    return parsePriceInput(amountStr) ?? 0;
  })();

  return (
    <Modal open={open} onClose={onClose} title="apply discount." subtitle="manager approval required">
      <div className="settle-totals" style={{ marginBottom: 14 }}>
        <Row label="subtotal" value={subtotal} />
      </div>

      {(list.data?.length ?? 0) > 0 && (
        <div className="settle-payments">
          <div className="settle-payments-head">already applied</div>
          {list.data!.map((a) => (
            <div
              key={a.id}
              className="settle-payments-row"
              style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
            >
              <span className="pill">{a.type}</span>
              <span className="ref">{a.reason}</span>
              <span className="amt" style={{ color: 'var(--amber-500)' }}>
                {formatNPR(a.amount_cents)}
              </span>
              <button
                type="button"
                className="btn icon danger"
                onClick={() =>
                  remove
                    .mutateAsync({
                      orderId,
                      adjId: a.id,
                      approver_email: approver.email || undefined,
                      approver_pin: approver.pin || undefined,
                    })
                    .catch((e) => setErr((e as { message?: string }).message ?? 'Failed'))
                }
                aria-label="remove"
              >
                <Trash2 size={12} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      )}

      {err && <div className="banner-error">{err}</div>}

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (computed <= 0) {
            setErr('amount must be > 0');
            return;
          }
          if (!reason.trim()) {
            setErr('reason required');
            return;
          }
          try {
            await apply.mutateAsync({
              orderId,
              type: 'discount',
              amount_cents: computed,
              reason: reason.trim(),
              approver_email: approver.email || undefined,
              approver_pin: approver.pin || undefined,
            });
            setAmountStr('');
            setReason('');
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Type</label>
        <div className="filter-row" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={`chip ${mode === 'percent' ? 'active' : ''}`}
            onClick={() => setMode('percent')}
          >
            % off
          </button>
          <button
            type="button"
            className={`chip ${mode === 'flat' ? 'active' : ''}`}
            onClick={() => setMode('flat')}
          >
            flat NPR off
          </button>
        </div>

        <div className="row-inputs">
          <div>
            <label>{mode === 'percent' ? 'Percent' : 'Amount (NPR)'}</label>
            <input
              inputMode="decimal"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder={mode === 'percent' ? '10' : '50'}
              required
            />
          </div>
          <div>
            <label>Reason</label>
            <SearchSelect
              options={DISCOUNT_REASONS}
              value={reason}
              onChange={setReason}
              placeholder="pick a reason"
              required
            />
          </div>
        </div>

        {computed > 0 && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              letterSpacing: '0.06em',
              padding: '8px 12px',
              borderRadius: 2,
              marginBottom: 14,
              background: 'rgba(255,163,25,0.08)',
              border: '1px solid rgba(255,163,25,0.3)',
              color: 'var(--amber-500)',
            }}
          >
            will deduct {formatNPR(computed)}
          </div>
        )}

        <ApprovalFields email={approver.email} pin={approver.pin} onChange={setApprover} />

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          <button type="submit" className="btn primary" disabled={apply.isPending}>
            {apply.isPending ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="settle-row">
      <span>{label}</span>
      <span className="num">{formatNPR(value)}</span>
    </div>
  );
}
