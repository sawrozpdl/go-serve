import { useState } from 'react';
import { ArrowRight, Plus, Trash2, Wallet } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR, parsePriceInput } from '@/components/Money';
import {
  useAccountBalances,
  useTransfers,
  useCreateTransfer,
  useDeleteTransfer,
  type AccountBalance,
} from '@/lib/api';

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash drawer',
  esewa: 'eSewa',
  khalti: 'Khalti',
  card: 'Card / POS',
  bank: 'Bank',
  other: 'Other',
};

export function AccountsPage() {
  const balances = useAccountBalances();
  const transfers = useTransfers();
  const [transferring, setTransferring] = useState(false);

  const total = (balances.data ?? []).reduce((s, a) => s + a.balance_cents, 0);

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">money on hand</span>
          <h1>Accounts</h1>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setTransferring(true)}>
            <ArrowRight size={14} strokeWidth={1.5} /> Move money
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>Balances</h3>
          <span className="meta">live · refreshes every 30s</span>
        </div>

        {balances.isPending && <div className="empty-state">loading…</div>}

        {balances.data && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            {balances.data.map((a) => (
              <BalanceCard key={a.method} acct={a} />
            ))}
          </div>
        )}

        {balances.data && balances.data.length > 0 && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: '1px solid var(--ink-800)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--ink-300)',
              }}
            >
              total across all accounts
            </span>
            <span
              className="num"
              style={{
                fontFamily: 'var(--font-num)',
                fontSize: 24,
                color: total >= 0 ? 'var(--lime-500)' : '#ff8a80',
              }}
            >
              {formatNPR(total)}
            </span>
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Transfers</h3>
          <span className="meta">last 200</span>
        </div>

        {transfers.isPending && <div className="empty-state">loading…</div>}
        {transfers.data?.length === 0 && (
          <div className="empty-state">
            no transfers yet — moving cash from drawer to bank, or eSewa to bank, lands here.
          </div>
        )}
        {transfers.data && transfers.data.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>When</th>
                <th>From → To</th>
                <th>Reference</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>Fee</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {transfers.data.map((t) => (
                <TransferRow key={t.id} t={t} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <TransferModal open={transferring} onClose={() => setTransferring(false)} />
    </>
  );
}

// -------------------------------------------------------------------------

function BalanceCard({ acct }: { acct: AccountBalance }) {
  const positive = acct.balance_cents >= 0;
  return (
    <div
      style={{
        padding: 14,
        background: 'var(--ink-900)',
        border: '1px solid var(--ink-800)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--ink-300)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        <Wallet size={12} strokeWidth={1.5} />
        {acct.label}
      </div>
      <div
        className="num"
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 22,
          color: positive ? 'var(--ink-50)' : '#ff8a80',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatNPR(acct.balance_cents)}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--ink-400)',
          paddingTop: 6,
          borderTop: '1px solid var(--ink-800)',
        }}
      >
        <span>+ {formatNPR(acct.payments_cents)} sales</span>
        <span style={{ textAlign: 'right' }}>+ {formatNPR(acct.transfers_in_cents)} in</span>
        <span>− {formatNPR(acct.expenses_cents)} expenses</span>
        <span style={{ textAlign: 'right' }}>− {formatNPR(acct.transfers_out_cents)} out</span>
      </div>
    </div>
  );
}

function TransferRow({
  t,
}: {
  t: {
    id: string;
    from_method: string;
    to_method: string;
    amount_cents: number;
    fee_cents: number;
    reference_no: string;
    transferred_at: string;
    shift_id?: string | null;
  };
}) {
  const del = useDeleteTransfer();
  const confirm = useConfirm();
  const fromLabel = METHOD_LABEL[t.from_method] ?? t.from_method;
  const toLabel = METHOD_LABEL[t.to_method] ?? t.to_method;
  return (
    <tr>
      <td className="sku">
        {new Date(t.transferred_at).toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </td>
      <td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="pill">{fromLabel}</span>
          <ArrowRight size={12} strokeWidth={1.5} style={{ color: 'var(--ink-400)' }} />
          <span className="pill ok">{toLabel}</span>
        </span>
      </td>
      <td className="sku">{t.reference_no || '—'}</td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-num)' }}>
        {formatNPR(t.amount_cents)}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-num)' }}>
        {t.fee_cents > 0 ? formatNPR(t.fee_cents) : '—'}
      </td>
      <td>
        <button
          type="button"
          className="btn icon danger"
          onClick={async () => {
            const ok = await confirm({
              title: 'Delete transfer?',
              message: (
                <>
                  Reverse the <strong>{formatNPR(t.amount_cents)}</strong>{' '}
                  transfer from <strong>{fromLabel}</strong> to{' '}
                  <strong>{toLabel}</strong>? Both account balances will be
                  restored.
                </>
              ),
              danger: true,
            });
            if (ok) del.mutate(t.id);
          }}
          aria-label="delete"
          disabled={del.isPending}
        >
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </td>
    </tr>
  );
}

// -------------------------------------------------------------------------

const TRANSFERABLE = ['cash', 'esewa', 'khalti', 'bank', 'card', 'other'];

function TransferModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateTransfer();
  const [fromMethod, setFromMethod] = useState('esewa');
  const [toMethod, setToMethod] = useState('bank');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="move money."
      subtitle="transfer between accounts"
    >
      {err && <div className="banner-error">{err}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const cents = parsePriceInput(amount);
          if (cents == null || cents <= 0) {
            setErr('amount required');
            return;
          }
          if (fromMethod === toMethod) {
            setErr('from and to must differ');
            return;
          }
          try {
            await create.mutateAsync({
              from_method: fromMethod,
              to_method: toMethod,
              amount_cents: cents,
              fee_cents: parsePriceInput(fee) ?? 0,
              reference_no: reference,
              notes,
            });
            setAmount('');
            setFee('');
            setReference('');
            setNotes('');
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <div className="row-inputs">
          <div className="field">
            <label>From</label>
            <select value={fromMethod} onChange={(e) => setFromMethod(e.target.value)}>
              {TRANSFERABLE.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>To</label>
            <select value={toMethod} onChange={(e) => setToMethod(e.target.value)}>
              {TRANSFERABLE.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          </div>
        </div>

        {(fromMethod === 'cash' || toMethod === 'cash') && (
          <div className="banner-info" style={{ marginBottom: 14 }}>
            cash side requires an open shift — the matching drawer movement is recorded automatically.
          </div>
        )}

        <div className="row-inputs">
          <div className="field">
            <label>Amount (NPR)</label>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="5000"
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label>Fee (NPR, optional)</label>
            <input
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0"
            />
          </div>
        </div>

        <label>Reference</label>
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="bank slip no, transaction id…"
        />

        <label>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={create.isPending}>
            <Plus size={12} strokeWidth={1.5} />
            {create.isPending ? 'Saving…' : 'Record transfer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
