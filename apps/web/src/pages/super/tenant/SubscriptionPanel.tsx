import { useState } from 'react';
import { CreditCard, Gift } from 'lucide-react';

import {
  useAdminTenantPayments,
  useAdminRecordPayment,
  useAdminSetSubscription,
  useAdminPeople,
  type AdminTenantDetail,
  type RecordPaymentInput,
} from '@/lib/api';
import { DatePicker } from '@/components/DatePicker';
import { DateDelta } from '@/components/super/DateStamp';
import { useConfirm } from '@/components/ConfirmDialog';
import { fmtDay, fmtDayLong, addDaysIso } from '@/lib/dates';

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addMonths(base: Date, months: number) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

const PAY_METHODS: RecordPaymentInput['method'][] = ['cash', 'bank', 'online', 'other'];

// Manual subscription management — no payment integration. Recording a payment
// advances the paid-through date; "Mark comped" clears it (perpetual access).
export function SubscriptionPanel({ id, t }: { id: string; t: AdminTenantDetail }) {
  const record = useAdminRecordPayment(id);
  const setSub = useAdminSetSubscription(id);
  const payments = useAdminTenantPayments(id);
  const people = useAdminPeople();
  const confirm = useConfirm();

  // Renewals extend from the end of the current paid period when still active,
  // otherwise from today.
  const renewBase = () => {
    const now = new Date();
    if (t.paid_through_at) {
      const pt = new Date(t.paid_through_at);
      if (pt > now) return pt;
    }
    return now;
  };

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<RecordPaymentInput['method']>('cash');
  const [collector, setCollector] = useState('');
  const [periodEnd, setPeriodEnd] = useState(isoDay(addMonths(renewBase(), 1)));
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');

  const cents = Math.round((parseFloat(amount) || 0) * 100);
  const canRecord = cents >= 0 && amount.trim() !== '' && !!periodEnd && !record.isPending;

  // Renewal shortcuts, now as picker presets rather than three loose buttons.
  const renewPresets = [
    { label: '+1 month', value: isoDay(addMonths(renewBase(), 1)) },
    { label: '+3 months', value: isoDay(addMonths(renewBase(), 3)) },
    { label: '+1 year', value: isoDay(addMonths(renewBase(), 12)) },
  ];

  // The server advances paid_through_at by GREATEST(current, period_end + 1),
  // so a back-dated period leaves coverage exactly where it is. Compute the
  // same thing here and say so, rather than letting the admin discover it from
  // an unchanged date afterwards.
  const projectedPaidThrough = periodEnd
    ? new Date(
        Math.max(
          new Date(`${periodEnd}T00:00:00`).getTime() + 86_400_000,
          t.paid_through_at ? new Date(t.paid_through_at).getTime() : 0,
        ),
      ).toISOString()
    : null;
  const coverageWouldNotMove =
    !!projectedPaidThrough && !!t.paid_through_at &&
    new Date(projectedPaidThrough).getTime() === new Date(t.paid_through_at).getTime();

  const onRecord = () => {
    if (!canRecord) return;
    record.mutate(
      {
        amount_cents: cents, method, period_end: periodEnd, note: note.trim() || undefined,
        // Cash creates a custody obligation, so who took it matters. Blank
        // lets the server default it to whoever is recording the payment.
        collected_by_person_id: method === 'cash' ? collector || undefined : undefined,
      },
      { onSuccess: () => { setAmount(''); setNote(''); } },
    );
  };

  const onComp = async () => {
    if (await confirm({ title: 'Mark comped?', message: 'Clears the paid-through date — the workspace gets perpetual access and is never flagged past due. Use for internal / enterprise tenants.', confirmLabel: 'Mark comped' })) {
      setSub.mutate({ paid_through_at: null });
    }
  };

  const list = payments.data?.payments ?? [];

  return (
    <section className="panel">
      <div className="panel-head"><h3>Subscription &amp; payments</h3></div>
      <p className="hint">
        Paid through <strong>{t.paid_through_at ? fmtDay(t.paid_through_at) : '— (comped / no paid subscription)'}</strong>.
        A lapsed paid subscription is flagged <em>past due</em> but writes stay open — lock manually above if needed.
      </p>

      {(record.isError || setSub.isError) && <div className="banner-error">{record.error?.message ?? setSub.error?.message}</div>}

      <div className="field">
        <label>Record a payment</label>
        <div className="super-inline">
          <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="amount (Rs)" style={{ width: 120 }} />
          <select value={method} onChange={(e) => setMethod(e.target.value as RecordPaymentInput['method'])}>
            {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      {method === 'cash' && (
        <div className="field">
          <label>Collected by</label>
          <select value={collector} onChange={(e) => setCollector(e.target.value)}>
            <option value="">Me</option>
            {(people.data?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="field-hint">
            Cash goes into someone’s hands, so it’s tracked as held by them until it’s banked.
            See Money → Cash.
          </div>
        </div>
      )}
      <div className="field">
        <label>Covers the workspace through</label>
        <DatePicker value={periodEnd} onChange={setPeriodEnd} presets={renewPresets} />
        {projectedPaidThrough && (
          <div className="field-hint">
            {coverageWouldNotMove ? (
              <>
                Coverage stays at <strong>{fmtDayLong(t.paid_through_at)}</strong> — this period ends before
                the date already paid through, so the payment is recorded but the clock does not move.
              </>
            ) : (
              <DateDelta before={t.paid_through_at} after={projectedPaidThrough} />
            )}
          </div>
        )}
      </div>
      <div className="field">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" />
      </div>
      <div className="super-inline">
        <button className="btn primary" disabled={!canRecord} onClick={onRecord}>
          <CreditCard size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> {record.isPending ? 'Recording…' : 'Record payment'}
        </button>
        <button className="btn" disabled={setSub.isPending} onClick={onComp}>
          <Gift size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Mark comped
        </button>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>Or set paid-through manually</label>
        <div className="super-inline">
          <DatePicker value={override} onChange={setOverride} placeholder="pick a date" compact />
          <button className="btn" disabled={!override || setSub.isPending} onClick={() => setSub.mutate({ paid_through_at: override }, { onSuccess: () => setOverride('') })}>Apply</button>
        </div>
        {override && (
          <div className="field-hint">
            {/* Unlike recording a payment, this is a direct SET — it can move
                coverage backwards as well as forwards. */}
            <DateDelta before={t.paid_through_at} after={addDaysIso(override, 1)} />
            <span className="muted"> — overwrites the date, no payment recorded</span>
          </div>
        )}
      </div>

      {list.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="t">
            <thead><tr><th>Recorded</th><th>Amount</th><th>Method</th><th>Through</th><th>Note</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDay(p.created_at)}</td>
                  <td>{fmtMoney(p.amount_cents, p.currency)}</td>
                  <td>{p.method}</td>
                  <td>{p.period_end}</td>
                  <td>{p.note || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

