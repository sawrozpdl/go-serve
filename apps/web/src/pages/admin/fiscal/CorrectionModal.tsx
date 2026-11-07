import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Undo2 } from 'lucide-react';
import type { CreditNote, InvoiceView } from '@cafe-mgmt/api-types';
import { Modal } from '@/components/Modal';
import { formatNPR } from '@/components/Money';
import { useCreateCreditNote, usePrintCreditNote, useTenantSettings } from '@/lib/api';
import { printCreditNote } from '@/lib/invoicePrint';
import { receiptWidthOf } from '@/lib/printing';
import { toast } from '@/lib/toast';

// Correct an issued IRD invoice (procedure 2082 §6.2(ज)). The bill itself is
// never edited: a reverse entry cancels it the same day, a sales return
// credits all or part of it later. Both need a reason, print as their own
// document and are reported to CBMS.

type Props = {
  open: boolean;
  view: InvoiceView;
  onClose: () => void;
  onDone: (cn: CreditNote) => void;
};

function todayBS(view: InvoiceView): boolean {
  // The server is the authority (it refuses a stale reversal); this only
  // decides which option to offer first. A bill issued in the last 24h in
  // Nepal time on the same calendar day counts.
  const npDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' });
  return npDay(new Date(view.invoice.issued_at)) === npDay(new Date());
}

export function CorrectionModal({ open, view, onClose, onDone }: Props) {
  const create = useCreateCreditNote();
  const printNote = usePrintCreditNote();
  const tenant = useTenantSettings();
  const inv = view.invoice;

  const returned = useMemo(() => {
    const m = new Map<number, number>();
    for (const cn of view.credit_notes) {
      for (const l of cn.lines) m.set(l.invoice_line_no, (m.get(l.invoice_line_no) ?? 0) + Number(l.qty));
    }
    return m;
  }, [view.credit_notes]);
  const canReverse = view.credit_notes.length === 0 && todayBS(view);
  const paidOnCredit = inv.payment_method.includes('Credit');

  const [kind, setKind] = useState<'reversal' | 'sales_return'>(canReverse ? 'reversal' : 'sales_return');
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'cash' | 'online' | 'credit'>(paidOnCredit ? 'credit' : 'cash');
  const [ref, setRef] = useState('');
  const [reopen, setReopen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(canReverse ? 'reversal' : 'sales_return');
    setQty({});
    setReason('');
    setRefund(paidOnCredit ? 'credit' : 'cash');
    setRef('');
    setReopen(false);
    setErr(null);
  }, [open, canReverse, paidOnCredit]);

  const left = (no: number, billed: string) => Math.max(0, Number(billed) - (returned.get(no) ?? 0));
  const picked = inv.lines
    .map((l) => ({ l, q: Number(qty[l.line_no] ?? 0) }))
    .filter((x) => x.q > 0);
  const estimate =
    kind === 'reversal'
      ? inv.total_cents
      : picked.reduce((s, x) => s + Math.round((x.l.amount_cents * x.q) / Number(x.l.qty)), 0);

  const submit = async () => {
    setErr(null);
    if (!reason.trim()) return setErr('Give the reason — it is printed and reported to IRD.');
    if (kind === 'sales_return' && picked.length === 0) return setErr('Choose what is being returned.');
    try {
      const cn = await create.mutateAsync({
        invoiceId: inv.id,
        kind,
        reason: reason.trim(),
        refund_method: refund,
        refund_reference: ref.trim() || undefined,
        lines: kind === 'sales_return' ? picked.map((x) => ({ line_no: x.l.line_no, qty: String(x.q) })) : undefined,
        reopen: kind === 'reversal' ? reopen : undefined,
      });
      toast.success(
        `${cn.kind === 'reversal' ? 'Reverse entry' : 'Sales return'} ${cn.number} issued`,
        `${formatNPR(cn.total_cents)} refunded${cn.reopened_order_id ? ' · bill re-opened to settle again' : ''}`,
      );
      try {
        const p = await printNote.mutateAsync(cn.id);
        await printCreditNote({
          note: p.credit_note,
          label: p,
          width: receiptWidthOf(tenant.data?.preferences?.receiptWidth),
        });
      } catch (e: unknown) {
        toast.error('Issued, but printing failed', (e as { message?: string }).message ?? '');
      }
      onDone(cn);
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Correct bill ${inv.number}`}
      subtitle={`FY ${inv.fiscal_year} · ${formatNPR(inv.total_cents)} · issued ${inv.bs_date}`}
    >
      {err && <div className="banner-error">{err}</div>}

      <div className="filter-row" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={`chip ${kind === 'reversal' ? 'active' : ''}`}
          disabled={!canReverse}
          onClick={() => setKind('reversal')}
          title={canReverse ? '' : 'Only for a bill issued today and not corrected before'}
        >
          <RotateCcw size={12} strokeWidth={1.6} /> Cancel bill (reverse entry)
        </button>
        <button
          type="button"
          className={`chip ${kind === 'sales_return' ? 'active' : ''}`}
          onClick={() => setKind('sales_return')}
        >
          <Undo2 size={12} strokeWidth={1.6} /> Sales return
        </button>
      </div>

      {kind === 'reversal' ? (
        <>
          <div className="field-hint" style={{ marginBottom: 10 }}>
            Cancels the whole bill today. The bill stays on record, marked cancelled, with this reverse entry.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" checked={reopen} onChange={(e) => setReopen(e.target.checked)} />
            Re-open the same items on a new tab to settle again (e.g. wrong payment method or table)
          </label>
        </>
      ) : (
        <div className="correction-lines">
          {inv.lines.map((l) => {
            const max = left(l.line_no, l.qty);
            return (
              <div key={l.line_no} className="correction-line">
                <span className="name">
                  {l.description}
                  <span className="muted"> · billed {l.qty}{returned.get(l.line_no) ? `, returned ${returned.get(l.line_no)}` : ''}</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={max}
                  step="0.5"
                  disabled={max === 0}
                  value={qty[l.line_no] ?? ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = Math.min(max, Math.max(0, Number(e.target.value)));
                    setQty({ ...qty, [l.line_no]: e.target.value === '' ? '' : String(v) });
                  }}
                  aria-label={`Return quantity for ${l.description}`}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="field">
        <label>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. dish returned cold" />
      </div>

      <div className="field">
        <label>Refund</label>
        <div className="filter-row">
          {(['cash', 'online', 'credit'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`chip ${refund === m ? 'active' : ''}`}
              disabled={m === 'credit' && !paidOnCredit}
              onClick={() => setRefund(m)}
            >
              {m === 'cash' ? 'Cash from drawer' : m === 'online' ? 'Online' : 'Reduce credit account'}
            </button>
          ))}
        </div>
        {refund === 'online' && (
          <input
            style={{ marginTop: 8 }}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Refund transaction reference (optional)"
            maxLength={120}
          />
        )}
      </div>

      <div className="modal-actions" style={{ marginTop: 14 }}>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn danger" disabled={create.isPending} onClick={submit}>
          {create.isPending
            ? 'Issuing…'
            : kind === 'reversal'
              ? `Issue reverse entry · ${formatNPR(estimate)}`
              : `Issue sales return · ≈ ${formatNPR(estimate)}`}
        </button>
      </div>
    </Modal>
  );
}
