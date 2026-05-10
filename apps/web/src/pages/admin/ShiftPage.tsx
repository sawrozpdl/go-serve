import { useMemo, useState } from 'react';
import { Banknote, Lock, AlertTriangle, Info } from 'lucide-react';

import {
  useCurrentShift,
  useShifts,
  useOpenShift,
  useCloseShift,
  type Shift,
} from '@/lib/api';
import { formatNPR, parsePriceInput } from '@/components/Money';

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
          <h1>shift.</h1>
        </div>
      </div>

      <div className="row-2">
        <section className="panel">
          <div className="panel-head">
            <h3>{current.data ? 'current shift' : 'no shift open'}</h3>
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
            <h3>history</h3>
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

  const expected = shift.live_expected_cash_cents;
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
        <Row label="cash taken in" value={formatNPR(shift.live_cash_count_cents)} accent />
        <Row label="expected cash" value={formatNPR(expected)} bold />
      </div>

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
