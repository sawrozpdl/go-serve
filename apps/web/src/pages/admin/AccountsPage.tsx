import { useState } from 'react';
import {
  ArrowRight,
  Plus,
  Trash2,
  Wallet,
  Banknote,
  Smartphone,
  CreditCard,
  Sparkles,
  AlertCircle,
} from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { RefreshButton } from '@/components/RefreshButton';
import {
  useAccountBalances,
  useTransfers,
  useCreateTransfer,
  useDeleteTransfer,
  useCafeBalance,
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

const METHOD_ICON: Record<string, typeof Banknote> = {
  cash: Banknote,
  esewa: Smartphone,
  khalti: Smartphone,
  card: CreditCard,
  bank: Wallet,
  other: Sparkles,
};

export function AccountsPage() {
  const balance = useCafeBalance();
  const balances = useAccountBalances();
  const transfers = useTransfers();
  const [transferring, setTransferring] = useState(false);
  const [transferDefaults, setTransferDefaults] = useState<{ from?: string; to?: string }>({});

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">Money on hand</span>
          <h1>Cafe balance</h1>
        </div>
        <div className="actions">
          <RefreshButton
            onClick={() =>
              Promise.all([balance.refetch(), balances.refetch(), transfers.refetch()])
            }
            busy={balance.isFetching || balances.isFetching || transfers.isFetching}
            label="Refresh"
          />
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setTransferDefaults({});
              setTransferring(true);
            }}
          >
            <ArrowRight size={14} strokeWidth={1.5} /> Move money
          </button>
        </div>
      </div>

      {/* HERO — total balance + drawer / bank / online breakdown */}
      <section
        style={{
          padding: 22,
          background: 'linear-gradient(135deg, var(--ink-900) 0%, var(--ink-800) 100%)',
          border: '1px solid var(--ink-700)',
          borderRadius: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--ink-300)',
              }}
            >
              total cafe balance
            </div>
            <div
              className="num"
              style={{
                fontFamily: 'var(--font-num)',
                fontSize: 44,
                color: 'var(--lime-fg)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.1,
                marginTop: 2,
              }}
            >
              {balance.isPending ? '…' : formatNPR(balance.data?.total_cents ?? 0)}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                color: 'var(--ink-400)',
                marginTop: 8,
              }}
            >
              {balance.data?.drawer_source === 'live'
                ? 'live · drawer reflects open shift'
                : balance.data?.drawer_source === 'last_close'
                ? `drawer as of last close · ${
                    balance.data.drawer_as_of
                      ? new Date(balance.data.drawer_as_of).toLocaleString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''
                  }`
                : 'no shift activity yet'}
            </div>
          </div>

          {/* Breakdown chips */}
          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <BreakdownTile
              icon={<Banknote size={14} strokeWidth={1.5} />}
              label="Drawer"
              cents={balance.data?.drawer_cents ?? 0}
            />
            <BreakdownTile
              icon={<Wallet size={14} strokeWidth={1.5} />}
              label="Bank"
              cents={balance.data?.bank_cents ?? 0}
              accent
            />
            <BreakdownTile
              icon={<Smartphone size={14} strokeWidth={1.5} />}
              label="Online"
              cents={(balance.data?.channels ?? []).reduce((s, c) => s + c.balance_cents, 0)}
            />
          </div>
        </div>

        {/* Outstanding loans pill */}
        {(balance.data?.owner_outstanding.loans_cents ?? 0) > 0 && (
          <div
            style={{
              marginTop: 16,
              padding: '10px 14px',
              background: 'rgba(255,176,32,0.08)',
              border: '1px solid rgba(255,176,32,0.25)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              color: 'var(--amber-fg)',
            }}
          >
            <AlertCircle size={14} strokeWidth={1.5} />
            <span>
              <strong>{formatNPR(balance.data?.owner_outstanding.loans_cents ?? 0)}</strong>{' '}
              owed back to owners (pocket-paid expenses awaiting reimbursement)
            </span>
          </div>
        )}
      </section>

      {/* Per-account tiles */}
      <section className="panel">
        <div className="panel-head">
          <h3>Channels</h3>
          <span className="meta">Live · refreshes every 30s</span>
        </div>

        {balances.isPending && <div className="empty-state">Loading…</div>}

        {balances.data && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            {balances.data.map((a) => (
              <BalanceCard
                key={a.method}
                acct={a}
                onTransferFrom={() => {
                  setTransferDefaults({ from: a.method });
                  setTransferring(true);
                }}
                onTransferTo={() => {
                  setTransferDefaults({ to: a.method });
                  setTransferring(true);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Transfers</h3>
          <span className="meta">Last 200</span>
        </div>

        {transfers.isPending && <div className="empty-state">Loading…</div>}
        {transfers.data?.length === 0 && (
          <div className="empty-state">
            No transfers yet — moving cash from drawer to bank, or eSewa to bank, lands here.
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

      <TransferModal
        open={transferring}
        defaults={transferDefaults}
        onClose={() => setTransferring(false)}
      />
    </>
  );
}

// -------------------------------------------------------------------------

function BreakdownTile({
  icon,
  label,
  cents,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  cents: number;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        padding: '12px 16px',
        background: accent ? 'rgba(163,240,44,0.06)' : 'var(--ink-950)',
        border: '1px solid ' + (accent ? 'rgba(163,240,44,0.18)' : 'var(--ink-800)'),
        borderRadius: 10,
        minWidth: 140,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: accent ? 'var(--lime-fg)' : 'var(--ink-300)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        {icon}
        {label}
      </div>
      <div
        className="num"
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 20,
          color: cents >= 0 ? 'var(--ink-50)' : 'var(--danger-fg)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 4,
        }}
      >
        {formatNPR(cents)}
      </div>
    </div>
  );
}

function BalanceCard({
  acct,
  onTransferFrom,
  onTransferTo,
}: {
  acct: AccountBalance;
  onTransferFrom: () => void;
  onTransferTo: () => void;
}) {
  const positive = acct.balance_cents >= 0;
  const Icon = METHOD_ICON[acct.method] ?? Wallet;
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
        <Icon size={12} strokeWidth={1.5} />
        {acct.label}
      </div>
      <div
        className="num"
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 22,
          color: positive ? 'var(--ink-50)' : 'var(--danger-fg)',
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
      {acct.method !== 'cash' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            type="button"
            className="btn small"
            style={{ flex: 1 }}
            onClick={onTransferFrom}
            title={`Move money out of ${acct.label}`}
          >
            <ArrowRight size={10} strokeWidth={1.5} /> Out
          </button>
          <button
            type="button"
            className="btn small"
            style={{ flex: 1 }}
            onClick={onTransferTo}
            title={`Move money into ${acct.label}`}
          >
            <ArrowRight size={10} strokeWidth={1.5} style={{ transform: 'rotate(180deg)' }} /> In
          </button>
        </div>
      )}
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
                  Reverse the <strong>{formatNPR(t.amount_cents)}</strong> transfer from{' '}
                  <strong>{fromLabel}</strong> to <strong>{toLabel}</strong>? Both account
                  balances will be restored.
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

function TransferModal({
  open,
  defaults,
  onClose,
}: {
  open: boolean;
  defaults: { from?: string; to?: string };
  onClose: () => void;
}) {
  const create = useCreateTransfer();
  const [fromMethod, setFromMethod] = useState(defaults.from ?? 'esewa');
  const [toMethod, setToMethod] = useState(defaults.to ?? 'bank');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Refresh defaults whenever the modal re-opens.
  if (open && defaults.from && fromMethod !== defaults.from && amount === '') {
    setFromMethod(defaults.from);
  }
  if (open && defaults.to && toMethod !== defaults.to && amount === '') {
    setToMethod(defaults.to);
  }

  return (
    <Modal open={open} onClose={onClose} title="Move Money" subtitle="Transfer between accounts">
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
            cash side requires an open shift — the matching drawer movement is recorded
            automatically.
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
