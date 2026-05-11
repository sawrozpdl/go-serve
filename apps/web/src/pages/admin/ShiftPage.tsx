import { useMemo, useState } from 'react';
import {
  Banknote,
  Lock,
  AlertTriangle,
  Info,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  Trash2,
} from 'lucide-react';

import {
  useCurrentShift,
  useShifts,
  useOpenShift,
  useCloseShift,
  useCashDrops,
  useCreateCashDrop,
  useDeleteCashDrop,
  type Shift,
  type CashDrop,
  type CashDropKind,
} from '@/lib/api';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { useConfirm } from '@/components/ConfirmDialog';

export function ShiftPage() {
  const current = useCurrentShift();
  const history = useShifts();

  // The most recent CLOSED shift's closing count is the cleanest signal of
  // "what should be in the drawer right now". We surface it as a hint when
  // the user opens a new shift.
  const lastClosed = useMemo(
    () => (history.data ?? []).find((s) => s.closed_at && s.closing_count_cents != null),
    [history.data],
  );

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">cash drawer</span>
          <h1>Shift</h1>
        </div>
      </div>

      <div className="row-2">
        <section className="panel">
          <div className="panel-head">
            <h3>{current.data ? 'Current shift' : 'No shift open'}</h3>
            <span className="meta">
              {current.data ? 'cash payments enabled' : 'cash payments blocked'}
            </span>
          </div>

          {current.isPending && <div className="empty-state">checking…</div>}
          {!current.isPending &&
            (current.data ? (
              <OpenShiftPanel shift={current.data} />
            ) : (
              <OpenShiftForm lastClosed={lastClosed} />
            ))}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>History</h3>
            <span className="meta">last 100</span>
          </div>
          {history.data?.length === 0 && <div className="empty-state">no shifts yet.</div>}
          {history.data?.map((s) => <HistoryRow key={s.id} shift={s} />)}
        </section>
      </div>
    </>
  );
}

// -------------------------------------------------------------------------

function OpenShiftForm({ lastClosed }: { lastClosed?: Shift }) {
  const open = useOpenShift();
  const [floatStr, setFloatStr] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const enteredCents = parsePriceInput(floatStr);
  const expected = lastClosed?.closing_count_cents ?? null;
  // Non-blocking warning: opening float should typically equal what was
  // counted at close. Real cafés sometimes deposit cash overnight so this
  // is only a hint, not a hard error.
  const mismatch =
    enteredCents != null && expected != null && enteredCents !== expected
      ? enteredCents - expected
      : null;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        const cents = parsePriceInput(floatStr);
        if (cents == null || cents < 0) {
          setErr('opening float required');
          return;
        }
        try {
          await open.mutateAsync({ opening_float_cents: cents, notes });
          setFloatStr('');
          setNotes('');
        } catch (e: unknown) {
          setErr((e as { message?: string }).message ?? 'Failed');
        }
      }}
    >
      {err && <div className="banner-error">{err}</div>}

      {expected != null && (
        <div className="banner-info">
          <Info size={14} strokeWidth={1.5} />
          <span>
            previous shift closed with <strong>{formatNPR(expected)}</strong> in the drawer.
            recommended opening float: <strong>{formatNPR(expected)}</strong>.
          </span>
        </div>
      )}

      <div className="field">
        <label>Opening float (NPR)</label>
        <input
          autoFocus
          inputMode="decimal"
          value={floatStr}
          onChange={(e) => setFloatStr(e.target.value)}
          placeholder={expected != null ? (expected / 100).toString() : '5000'}
        />
        {mismatch != null && (
          <div className="field-warn">
            <AlertTriangle size={11} strokeWidth={1.5} />
            {mismatch > 0 ? '+' : ''}
            {formatNPR(mismatch)} vs. previous close — proceed only if you intentionally
            adjusted the till.
          </div>
        )}
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional — reason for any float adjustment"
        />
      </div>

      <button
        type="submit"
        className="btn primary"
        disabled={open.isPending}
        style={{ width: '100%' }}
      >
        <Banknote size={14} strokeWidth={1.5} />
        {open.isPending ? 'Opening…' : 'Open shift'}
      </button>
    </form>
  );
}

// -------------------------------------------------------------------------

function OpenShiftPanel({ shift }: { shift: Shift }) {
  const close = useCloseShift();
  const [countStr, setCountStr] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Defensive ?? 0: if the API binary predates the cash_drops fields these
  // come back undefined and divide-by-100 yields NaN in the UI.
  const expected = shift.live_expected_cash_cents ?? 0;
  const cashIn = shift.live_cash_in_cents ?? shift.live_cash_count_cents ?? 0;
  const cashOut = shift.live_cash_out_cents ?? 0;
  const counted = parsePriceInput(countStr);
  const variance = counted != null ? counted - expected : null;

  // Severity ladder — surfaces context but never blocks the close.
  const varianceSeverity =
    variance == null
      ? null
      : Math.abs(variance) === 0
      ? 'ok'
      : Math.abs(variance) <= 5000 // ≤ Rs 50 = rounding / coin shortage
      ? 'minor'
      : Math.abs(variance) <= 50000 // ≤ Rs 500 = needs investigation
      ? 'warn'
      : 'bad'; // > Rs 500 = serious — flag the manager

  return (
    <>
      <div className="settle-totals" style={{ marginBottom: 16 }}>
        <Row label="opened by" value={shift.opened_by_email ?? '—'} />
        <Row label="opened at" value={new Date(shift.opened_at).toLocaleString('en-GB')} />
        <hr className="settle-rule" />
        <Row label="opening float" value={formatNPR(shift.opening_float_cents)} />
        <Row label="cash in (sales + drops)" value={formatNPR(cashIn)} accent />
        {cashOut > 0 && (
          <Row label="cash out (drops)" value={'− ' + formatNPR(cashOut)} />
        )}
        <Row label="expected cash" value={formatNPR(expected)} bold />
      </div>

      <CashDropsPanel shiftId={shift.id} />

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (counted == null || counted < 0) {
            setErr('count required');
            return;
          }
          try {
            await close.mutateAsync({ id: shift.id, closing_count_cents: counted, notes });
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        {err && <div className="banner-error">{err}</div>}

        <div className="field">
          <label>Count from drawer (NPR)</label>
          <input
            autoFocus
            inputMode="decimal"
            value={countStr}
            onChange={(e) => setCountStr(e.target.value)}
            placeholder={(expected / 100).toString()}
          />
        </div>

        {variance != null && varianceSeverity && (
          <div className={`variance-pill ${varianceSeverity}`}>
            {varianceSeverity === 'ok' && 'matches expected ✓'}
            {varianceSeverity === 'minor' && (
              <>
                <span>
                  {formatNPR(variance)} {variance > 0 ? 'over' : 'short'}
                </span>
                <span className="meta">small variance — likely coin rounding</span>
              </>
            )}
            {(varianceSeverity === 'warn' || varianceSeverity === 'bad') && (
              <>
                <AlertTriangle size={12} strokeWidth={1.5} />
                <span>
                  {formatNPR(variance)} {variance > 0 ? 'over' : 'short'}
                </span>
                <span className="meta">
                  {varianceSeverity === 'bad'
                    ? 'large variance — investigate before close'
                    : 'investigate then add a note'}
                </span>
              </>
            )}
          </div>
        )}

        <div className="field">
          <label>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={
              varianceSeverity === 'warn' || varianceSeverity === 'bad'
                ? 'explain the variance — required for audit'
                : 'optional'
            }
          />
        </div>

        <button
          type="submit"
          className="btn primary"
          disabled={close.isPending}
          style={{ width: '100%' }}
        >
          <Lock size={14} strokeWidth={1.5} />
          {close.isPending ? 'Closing…' : 'Close shift'}
        </button>
      </form>
    </>
  );
}

// -------------------------------------------------------------------------

function HistoryRow({ shift }: { shift: Shift }) {
  const variance = shift.variance_cents ?? 0;
  const closed = !!shift.closed_at;
  const status =
    !closed
      ? { label: 'open', cls: 'pill warn' }
      : variance === 0
      ? { label: 'matched', cls: 'pill ok' }
      : variance > 0
      ? { label: `+${formatNPR(variance)}`, cls: 'pill warn' }
      : { label: formatNPR(variance), cls: 'pill bad' };

  return (
    <div className="exp">
      <div className="left">
        <span className="name">
          {new Date(shift.opened_at).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <span className="meta">
          {shift.opened_by_email ?? '—'} · float {formatNPR(shift.opening_float_cents)}
          {closed && shift.expected_cash_cents != null && (
            <> · expected {formatNPR(shift.expected_cash_cents)}</>
          )}
        </span>
      </div>
      <span className={status.cls}>
        {variance < 0 && closed && <AlertTriangle size={10} strokeWidth={1.5} />} {status.label}
      </span>
      <span className="amt">
        {closed && shift.closing_count_cents != null
          ? formatNPR(shift.closing_count_cents)
          : '—'}
      </span>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string | number;
  bold?: boolean;
  accent?: boolean;
}) {
  const cls = ['settle-row'];
  if (bold) cls.push('bold');
  if (accent) cls.push('accent');
  return (
    <div className={cls.join(' ')}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

// -------------------------------------------------------------------------
// Cash drops panel — pay-ins/pay-outs against the open drawer.
// Drawer-paid expenses show up here automatically (kind='expense'); transfers
// involving cash do too (kind='transfer'). Manual rows are owner_draw,
// bank_deposit, paid_in/out, petty_change, correction.
// -------------------------------------------------------------------------

const KIND_LABELS: Record<CashDropKind, string> = {
  owner_draw: 'Owner draw',
  bank_deposit: 'Bank deposit',
  expense: 'Expense',
  transfer: 'Transfer',
  paid_out: 'Paid out',
  paid_in: 'Paid in',
  petty_change: 'Petty change',
  correction: 'Correction',
  other: 'Other',
};

// Kinds the user can post manually from this panel.
const POSTABLE_KINDS: CashDropKind[] = [
  'owner_draw',
  'bank_deposit',
  'paid_out',
  'paid_in',
  'petty_change',
  'correction',
  'other',
];

function CashDropsPanel({ shiftId }: { shiftId: string }) {
  const drops = useCashDrops(shiftId);
  const create = useCreateCashDrop(shiftId);
  const del = useDeleteCashDrop(shiftId);

  const [adding, setAdding] = useState(false);

  return (
    <section style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ink-800)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <span
          className="eyebrow"
          style={{ fontSize: 10, letterSpacing: '0.14em', color: 'var(--ink-300)' }}
        >
          drawer ledger
        </span>
        {!adding && (
          <button type="button" className="btn small" onClick={() => setAdding(true)}>
            <Plus size={12} strokeWidth={1.5} /> Record movement
          </button>
        )}
      </div>

      {adding && <CashDropForm onClose={() => setAdding(false)} create={create} />}

      {drops.isPending && <div className="empty-state">loading…</div>}
      {drops.data?.length === 0 && !adding && (
        <div className="empty-state" style={{ fontSize: 11 }}>
          no drawer movements yet — owner draws, bank deposits, and drawer-paid
          expenses show up here.
        </div>
      )}
      {drops.data && drops.data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {drops.data.map((d) => (
            <CashDropRow
              key={d.id}
              drop={d}
              onDelete={() => del.mutate(d.id)}
              deleting={del.isPending}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CashDropRow({
  drop,
  onDelete,
  deleting,
}: {
  drop: CashDrop;
  onDelete: () => void;
  deleting: boolean;
}) {
  const confirm = useConfirm();
  const isOut = drop.direction === 'out';
  const linked = drop.kind === 'expense' || drop.kind === 'transfer';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '24px 1fr auto auto',
        gap: 10,
        alignItems: 'center',
        padding: '8px 10px',
        background: 'var(--ink-900)',
        border: '1px solid var(--ink-800)',
        borderRadius: 4,
      }}
    >
      <span style={{ color: isOut ? 'var(--amber-fg)' : 'var(--lime-fg)' }}>
        {isOut ? <ArrowUpRight size={14} strokeWidth={1.5} /> : <ArrowDownRight size={14} strokeWidth={1.5} />}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ color: 'var(--ink-50)', fontSize: 13 }}>
          {KIND_LABELS[drop.kind]}
          {drop.reason && (
            <span style={{ color: 'var(--ink-400)', fontWeight: 400 }}> — {drop.reason}</span>
          )}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.06em',
            color: 'var(--ink-400)',
          }}
        >
          {new Date(drop.recorded_at).toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          {drop.recorded_by_email && ` · ${drop.recorded_by_email}`}
        </span>
      </span>
      <span
        className="num"
        style={{
          color: isOut ? 'var(--amber-fg)' : 'var(--lime-fg)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {isOut ? '−' : '+'} {formatNPR(drop.amount_cents)}
      </span>
      {linked ? (
        <span className="pill" style={{ fontSize: 9 }} title="managed by linked record">
          linked
        </span>
      ) : (
        <button
          type="button"
          className="btn icon danger"
          aria-label="remove"
          onClick={async () => {
            const ok = await confirm({
              title: 'Remove drawer movement?',
              message: (
                <>
                  Remove the <strong>{KIND_LABELS[drop.kind]}</strong> of{' '}
                  <strong>
                    {isOut ? '−' : '+'} {formatNPR(drop.amount_cents)}
                  </strong>
                  {drop.reason ? (
                    <>
                      {' '}
                      ({drop.reason})
                    </>
                  ) : null}
                  ? The shift's expected cash will be recomputed.
                </>
              ),
              confirmLabel: 'Remove',
              danger: true,
            });
            if (ok) onDelete();
          }}
          disabled={deleting}
        >
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

function CashDropForm({
  onClose,
  create,
}: {
  onClose: () => void;
  create: ReturnType<typeof useCreateCashDrop>;
}) {
  const [kind, setKind] = useState<CashDropKind>('owner_draw');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Direction is implicit for most kinds; only 'correction' or 'other' lets
  // the user pick.
  const directionPickable = kind === 'correction' || kind === 'other';

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        const cents = parsePriceInput(amount);
        if (cents == null || cents <= 0) {
          setErr('amount required');
          return;
        }
        try {
          await create.mutateAsync({
            kind,
            amount_cents: cents,
            reason,
            notes,
            direction: directionPickable ? direction : undefined,
          });
          onClose();
        } catch (e: unknown) {
          setErr((e as { message?: string }).message ?? 'Failed');
        }
      }}
      style={{
        padding: 12,
        marginBottom: 10,
        background: 'var(--ink-900)',
        border: '1px solid var(--ink-700)',
        borderRadius: 6,
      }}
    >
      {err && <div className="banner-error">{err}</div>}
      <div className="row-inputs">
        <div className="field">
          <label>Kind</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CashDropKind)}
          >
            {POSTABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Amount (NPR)</label>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="500"
            autoFocus
          />
        </div>
      </div>
      {directionPickable && (
        <div className="field">
          <label>Direction</label>
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
            <option value="out">out — cash leaves the drawer</option>
            <option value="in">in — cash added to drawer</option>
          </select>
        </div>
      )}
      <div className="field">
        <label>Reason</label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            kind === 'owner_draw'
              ? 'e.g. owner advance'
              : kind === 'bank_deposit'
              ? 'e.g. NIBL deposit slip 2034'
              : 'short label'
          }
        />
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Record'}
        </button>
      </div>
    </form>
  );
}
