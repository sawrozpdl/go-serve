import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Receipt, Wallet, FileText, Plus, Landmark, ArrowLeftRight, Trash2 } from 'lucide-react';

import {
  useAdminRevenue,
  useAdminStatement,
  useAdminCash,
  useAdminPlatformExpenses,
  useAdminExpenseCategories,
  useAdminDepositCash,
  useAdminHandoverCash,
  useAdminCreatePlatformExpense,
  useAdminDeletePlatformExpense,
  type CashHolder,
  type PaidFrom,
  type FinanceRange,
} from '@/lib/api';
import { CASH_KIND_LABEL, CASH_KIND_SIGN } from '@cafe-mgmt/api-types';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { Tabs, type TabItem } from '@/components/Tabs';
import { Modal } from '@/components/Modal';
import { DatePicker } from '@/components/DatePicker';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR } from '@/components/Money';
import { fmtDay, fmtDayLong, fmtRelative, todayIso, addDaysIso } from '@/lib/dates';

type MoneyTab = 'revenue' | 'expenses' | 'cash' | 'statement';

const TABS: TabItem<MoneyTab>[] = [
  { key: 'revenue', label: 'Revenue', icon: <Banknote size={12} strokeWidth={1.6} /> },
  { key: 'expenses', label: 'Expenses', icon: <Receipt size={12} strokeWidth={1.6} /> },
  { key: 'cash', label: 'Cash', icon: <Wallet size={12} strokeWidth={1.6} /> },
  { key: 'statement', label: 'Statement', icon: <FileText size={12} strokeWidth={1.6} /> },
];

/* The platform's own books. Answers three questions the tenant-payments table
 * alone couldn't: what did we take in, what did we spend, and — the one that
 * actually goes missing — who is physically holding collected cash right now. */
export function SuperMoneyPage() {
  const [tab, setTab] = useState<MoneyTab>('revenue');
  const [range, setRange] = useState<FinanceRange>({
    from: addDaysIso(todayIso(), -90),
    to: todayIso(),
  });

  return (
    <PageShell
      eyebrow="Platform"
      title="Money"
      subtitle="What came in, what went out, and where it is now"
      docTitle="Money"
      actions={
        <div className="super-inline">
          <DatePicker value={range.from ?? ''} onChange={(from) => setRange((r) => ({ ...r, from }))} compact />
          <span className="muted">→</span>
          <DatePicker value={range.to ?? ''} onChange={(to) => setRange((r) => ({ ...r, to }))} compact />
        </div>
      }
      tabs={<Tabs items={TABS} active={tab} onChange={setTab} ariaLabel="Money sections" />}
    >
      {tab === 'revenue' && <RevenueTab range={range} />}
      {tab === 'expenses' && <ExpensesTab range={range} />}
      {tab === 'cash' && <CashTab />}
      {tab === 'statement' && <StatementTab range={range} />}
    </PageShell>
  );
}

/* --- Revenue ------------------------------------------------------------ */

function RevenueTab({ range }: { range: FinanceRange }) {
  const q = useAdminRevenue(range);
  const rows = q.data?.payments ?? [];

  return (
    <>
      {q.data && (
        <div className="kpis">
          <div className="kpi">
            <span className="label">Collected</span>
            <span className="value">{formatNPR(q.data.total_cents)}</span>
          </div>
          <div className="kpi">
            <span className="label">Payments</span>
            <span className="value">{rows.length}</span>
          </div>
          <BreakdownKpi label="By method" data={q.data.by_method} />
          <BreakdownKpi label="By collector" data={q.data.by_collector} />
        </div>
      )}

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={rows.length === 0}
        errorTitle="Could not load revenue"
        emptyTitle="No payments in this range"
        emptyHint="Widen the dates above, or record a payment from a café’s Billing tab."
      >
        <div className="table-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Recorded</th><th>Café</th><th>Plan</th>
                <th className="num">Amount</th><th>Into</th><th>Collected by</th><th>Covers to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDay(p.created_at)}</td>
                  <td><Link to={`/super/tenants/${p.tenant_id}`}>{p.cafe_name}</Link></td>
                  <td>{p.plan_name ?? <span className="muted">—</span>}</td>
                  <td className="num">{formatNPR(p.amount_cents)}</td>
                  <td><span className="pill">{p.received_into}</span></td>
                  <td>
                    {p.collected_by_name ?? (
                      // Worth flagging rather than leaving blank: an
                      // unattributed cash payment is money nobody is answerable
                      // for.
                      p.received_into === 'cash'
                        ? <span className="usage-warn">unattributed</span>
                        : <span className="muted">—</span>
                    )}
                  </td>
                  <td>{p.period_end}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </>
  );
}

function BreakdownKpi({ label, data }: { label: string; data: Record<string, number> }) {
  const parts = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className="value kpi-byplan">
        {parts.length === 0
          ? <em className="muted">—</em>
          : parts.map(([k, v]) => <em key={k}>{k}: {formatNPR(v)}</em>)}
      </span>
    </div>
  );
}

/* --- Expenses ----------------------------------------------------------- */

function ExpensesTab({ range }: { range: FinanceRange }) {
  const q = useAdminPlatformExpenses(range);
  const del = useAdminDeletePlatformExpense();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const rows = q.data?.expenses ?? [];

  const onDelete = async (id: string, fromCash: boolean) => {
    if (fromCash) {
      // The server refuses this too; saying so up front avoids a pointless
      // round-trip and explains the reasoning.
      await confirm({
        title: 'This one can’t be deleted',
        message: 'It was paid from someone’s collected cash, and that ledger is append-only. Record a correcting entry instead.',
        confirmLabel: 'Got it',
      });
      return;
    }
    if (await confirm({ title: 'Delete this expense?', danger: true, confirmLabel: 'Delete' })) {
      del.mutate(id);
    }
  };

  return (
    <>
      <div className="filter-row">
        <div className="kpi kpi--inline">
          <span className="label">Spent in range</span>
          <span className="value">{formatNPR(q.data?.total_cents ?? 0)}</span>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> Record spending
        </button>
      </div>

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={rows.length === 0}
        errorTitle="Could not load expenses"
        emptyTitle="Nothing recorded in this range"
        emptyHint="Hosting, travel, hardware — anything the platform itself spends."
      >
        <div className="table-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Date</th><th>Category</th><th>Vendor</th>
                <th className="num">Amount</th><th>Paid from</th><th>Café</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{e.occurred_on}</td>
                  <td>{e.category_name ?? <span className="muted">uncategorised</span>}</td>
                  <td>{e.vendor || <span className="muted">—</span>}</td>
                  <td className="num">{formatNPR(e.amount_cents)}</td>
                  <td>
                    {e.paid_from === 'person_cash'
                      ? <span className="pill warn">{e.paid_by_name}’s cash</span>
                      : <span className="pill">{e.paid_from}</span>}
                  </td>
                  <td>
                    {e.tenant_id
                      ? <Link to={`/super/tenants/${e.tenant_id}`}>{e.cafe_name}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="super-row-actions">
                    <button
                      className="btn icon"
                      title="Delete"
                      onClick={() => void onDelete(e.id, e.paid_from === 'person_cash')}
                    >
                      <Trash2 size={14} strokeWidth={1.7} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      {adding && <ExpenseModal onClose={() => setAdding(false)} />}
    </>
  );
}

function ExpenseModal({ onClose }: { onClose: () => void }) {
  const create = useAdminCreatePlatformExpense();
  const cats = useAdminExpenseCategories();
  const cash = useAdminCash();
  const [form, setForm] = useState({
    amount: '', category_id: '', occurred_on: todayIso(), vendor: '', note: '',
    paid_from: 'bank' as PaidFrom, paid_by_person_id: '',
  });

  const cents = Math.round((parseFloat(form.amount) || 0) * 100);
  const holder = cash.data?.holders.find((h) => h.person_id === form.paid_by_person_id);
  const overdrawn = form.paid_from === 'person_cash' && !!holder && cents > holder.held_cents;
  const canSave =
    cents > 0 &&
    !create.isPending &&
    !overdrawn &&
    (form.paid_from !== 'person_cash' || !!form.paid_by_person_id);

  const submit = async () => {
    await create.mutateAsync({
      amount_cents: cents,
      category_id: form.category_id || null,
      occurred_on: form.occurred_on,
      vendor: form.vendor.trim(),
      note: form.note.trim(),
      paid_from: form.paid_from,
      paid_by_person_id: form.paid_from === 'person_cash' ? form.paid_by_person_id : null,
    });
    onClose();
  };

  return (
    <Modal open title="Record spending" onClose={onClose}>
      <div className="field">
        <label>Amount</label>
        <input
          type="number" min={0} step="0.01" value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          placeholder="0.00" autoFocus
        />
      </div>
      <div className="field">
        <label>Category</label>
        <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
          <option value="">Uncategorised</option>
          {(cats.data?.categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Date</label>
        <DatePicker value={form.occurred_on} onChange={(occurred_on) => setForm({ ...form, occurred_on })} compact />
      </div>
      <div className="field">
        <label>Vendor</label>
        <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="who we paid" />
      </div>

      <div className="field">
        <label>Paid from</label>
        <div className="seg" role="radiogroup" aria-label="Paid from">
          {(['bank', 'wallet', 'person_cash'] as PaidFrom[]).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={form.paid_from === p}
              className={`seg-btn ${form.paid_from === p ? 'on' : ''}`}
              onClick={() => setForm({ ...form, paid_from: p })}
            >
              {p === 'person_cash' ? 'Collected cash' : p === 'bank' ? 'Bank' : 'Wallet'}
            </button>
          ))}
        </div>
        {form.paid_from === 'person_cash' && (
          <div className="field-hint">
            Draws down what that person is holding — the money is already ours, this records it leaving.
          </div>
        )}
      </div>

      {form.paid_from === 'person_cash' && (
        <div className="field">
          <label>Whose cash</label>
          <select
            value={form.paid_by_person_id}
            onChange={(e) => setForm({ ...form, paid_by_person_id: e.target.value })}
          >
            <option value="">Pick someone</option>
            {(cash.data?.holders ?? [])
              .filter((h) => h.held_cents > 0)
              .map((h) => (
                <option key={h.person_id} value={h.person_id}>
                  {h.name} — holding {formatNPR(h.held_cents)}
                </option>
              ))}
          </select>
          {holder && (
            <div className={`field-hint${overdrawn ? ' field-error' : ''}`}>
              {overdrawn
                ? `${holder.name} is only holding ${formatNPR(holder.held_cents)}.`
                : `${formatNPR(holder.held_cents)} → ${formatNPR(holder.held_cents - cents)} after this.`}
            </div>
          )}
        </div>
      )}

      <div className="field">
        <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="note (optional)" />
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!canSave} onClick={() => void submit()}>
          {create.isPending ? 'Saving…' : 'Record'}
        </button>
      </div>
    </Modal>
  );
}

/* --- Cash custody ------------------------------------------------------- */

function CashTab() {
  const q = useAdminCash();
  const [depositFor, setDepositFor] = useState<CashHolder | null>(null);
  const [handoverFrom, setHandoverFrom] = useState<CashHolder | null>(null);

  const holders = q.data?.holders ?? [];
  const withMoney = holders.filter((h) => h.held_cents !== 0);

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <span className="label">In people’s hands</span>
          <span className="value">{formatNPR(q.data?.total_held_cents ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="label">Holders</span>
          <span className="value">{withMoney.length}</span>
        </div>
      </div>

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        errorTitle="Could not load cash positions"
      >
        <div className="cash-cards">
          {holders.map((h) => (
            <div key={h.person_id} className={`panel cash-card${h.held_cents > 0 ? ' has-cash' : ''}`}>
              <div className="cash-card__head">
                <strong>{h.name}</strong>
                {!h.active && <span className="pill">inactive</span>}
              </div>
              <div className="cash-card__amount">{formatNPR(h.held_cents)}</div>
              {h.oldest_held_at && h.held_cents > 0 && (
                // The age is the actionable part: money collected weeks ago and
                // still in a bag is the thing worth chasing.
                <div className="cash-card__age">
                  oldest collection {fmtRelative(h.oldest_held_at)}
                </div>
              )}
              <div className="cash-card__actions">
                <button className="btn small" disabled={h.held_cents <= 0} onClick={() => setDepositFor(h)}>
                  <Landmark size={13} strokeWidth={1.7} style={{ marginRight: 4 }} /> Bank it
                </button>
                <button className="btn small" disabled={h.held_cents <= 0} onClick={() => setHandoverFrom(h)}>
                  <ArrowLeftRight size={13} strokeWidth={1.7} style={{ marginRight: 4 }} /> Hand over
                </button>
              </div>
            </div>
          ))}
        </div>

        <section className="panel" style={{ marginTop: 'var(--space-4)' }}>
          <div className="panel-head"><h3>Movements</h3></div>
          {(q.data?.entries.length ?? 0) === 0 ? (
            <p className="muted">Nothing yet. Recording a cash payment against a café starts the trail.</p>
          ) : (
            <div className="table-scroll">
              <table className="t">
                <thead>
                  <tr><th>When</th><th>Person</th><th>What</th><th className="num">Amount</th><th>Detail</th></tr>
                </thead>
                <tbody>
                  {(q.data?.entries ?? []).map((e) => (
                    <tr key={e.id}>
                      <td>{fmtDay(e.occurred_at)}</td>
                      <td>{e.person_name}</td>
                      <td>{CASH_KIND_LABEL[e.kind]}</td>
                      <td className={`num ${CASH_KIND_SIGN[e.kind] > 0 ? 'cash-in' : 'cash-out'}`}>
                        {CASH_KIND_SIGN[e.kind] > 0 ? '+' : '−'}{formatNPR(e.amount_cents)}
                      </td>
                      <td className="muted">
                        {e.cafe_name ?? e.counterparty_name ?? e.reference_no ?? e.notes ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </QueryState>

      {depositFor && <DepositModal holder={depositFor} onClose={() => setDepositFor(null)} />}
      {handoverFrom && (
        <HandoverModal
          from={handoverFrom}
          holders={holders.filter((h) => h.person_id !== handoverFrom.person_id && h.active)}
          onClose={() => setHandoverFrom(null)}
        />
      )}
    </>
  );
}

function DepositModal({ holder, onClose }: { holder: CashHolder; onClose: () => void }) {
  const deposit = useAdminDepositCash();
  const [amount, setAmount] = useState((holder.held_cents / 100).toFixed(2));
  const [ref, setRef] = useState('');
  const cents = Math.round((parseFloat(amount) || 0) * 100);
  const tooMuch = cents > holder.held_cents;

  return (
    <Modal
      open
      title={`Bank ${holder.name}’s cash`}
      subtitle="Moves it from their hands into the account. Not income — the money was already ours."
      onClose={onClose}
    >
      <div className="field">
        <label>Amount</label>
        <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        <div className={`field-hint${tooMuch ? ' field-error' : ''}`}>
          {tooMuch
            ? `They’re only holding ${formatNPR(holder.held_cents)}.`
            : `${formatNPR(holder.held_cents)} → ${formatNPR(holder.held_cents - cents)} in hand.`}
        </div>
      </div>
      <div className="field">
        <label>Deposit slip no. (optional)</label>
        <input value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={cents <= 0 || tooMuch || deposit.isPending}
          onClick={async () => {
            await deposit.mutateAsync({ person_id: holder.person_id, amount_cents: cents, reference_no: ref });
            onClose();
          }}
        >
          {deposit.isPending ? 'Saving…' : 'Record deposit'}
        </button>
      </div>
    </Modal>
  );
}

function HandoverModal({
  from, holders, onClose,
}: {
  from: CashHolder;
  holders: CashHolder[];
  onClose: () => void;
}) {
  const handover = useAdminHandoverCash();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const cents = Math.round((parseFloat(amount) || 0) * 100);
  const tooMuch = cents > from.held_cents;
  const target = useMemo(() => holders.find((h) => h.person_id === to), [holders, to]);

  return (
    <Modal
      open
      title={`Hand over from ${from.name}`}
      subtitle="Passes cash to someone else. The platform’s total in hand doesn’t change."
      onClose={onClose}
    >
      <div className="field">
        <label>To</label>
        <select value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
          <option value="">Pick someone</option>
          {holders.map((h) => (
            <option key={h.person_id} value={h.person_id}>
              {h.name}{h.held_cents > 0 ? ` — holding ${formatNPR(h.held_cents)}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Amount</label>
        <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className={`field-hint${tooMuch ? ' field-error' : ''}`}>
          {tooMuch
            ? `${from.name} is only holding ${formatNPR(from.held_cents)}.`
            : target && cents > 0
              ? `${from.name} ${formatNPR(from.held_cents - cents)} · ${target.name} ${formatNPR(target.held_cents + cents)}`
              : `${from.name} is holding ${formatNPR(from.held_cents)}.`}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!to || cents <= 0 || tooMuch || handover.isPending}
          onClick={async () => {
            await handover.mutateAsync({
              from_person_id: from.person_id, to_person_id: to, amount_cents: cents,
            });
            onClose();
          }}
        >
          {handover.isPending ? 'Saving…' : 'Record handover'}
        </button>
      </div>
    </Modal>
  );
}

/* --- Statement ---------------------------------------------------------- */

function StatementTab({ range }: { range: FinanceRange }) {
  const q = useAdminStatement(range);
  const s = q.data;

  return (
    <QueryState
      isPending={q.isPending}
      isError={q.isError}
      error={q.error}
      refetch={q.refetch}
      errorTitle="Could not load the statement"
    >
      {s && (
        <div className="super-detail-grid">
          <section className="panel">
            <div className="panel-head">
              <h3>Trading</h3>
              <span className="meta">{fmtDayLong(s.from)} – {fmtDayLong(s.to)}</span>
            </div>
            <dl className="super-dl statement-dl">
              <dt>Revenue</dt><dd className="num">{formatNPR(s.revenue_cents)}</dd>
              <dt>Expenses</dt><dd className="num">−{formatNPR(s.expenses_cents)}</dd>
              <dt className="statement-net">Net</dt>
              <dd className={`num statement-net ${s.net_cents < 0 ? 'cash-out' : 'cash-in'}`}>
                {formatNPR(s.net_cents)}
              </dd>
            </dl>

            {Object.keys(s.expenses_by_category).length > 0 && (
              <>
                <div className="panel-head" style={{ marginTop: 'var(--space-4)' }}><h3>Where it went</h3></div>
                <dl className="super-dl statement-dl">
                  {Object.entries(s.expenses_by_category)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, cents]) => (
                      <div key={name} style={{ display: 'contents' }}>
                        <dt>{name}</dt><dd className="num">{formatNPR(cents)}</dd>
                      </div>
                    ))}
                </dl>
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>Where the money is</h3>
              <span className="meta">right now</span>
            </div>
            <p className="hint">
              All-time, not for the range above — how much is in the bank isn’t a property of a date range.
            </p>
            <dl className="super-dl statement-dl">
              <dt>Bank</dt><dd className="num">{formatNPR(s.cash_position.bank_cents)}</dd>
              <dt>Wallet</dt><dd className="num">{formatNPR(s.cash_position.wallet_cents)}</dd>
              <dt>In people’s hands</dt>
              <dd className={`num ${s.cash_position.held_by_people_cents > 0 ? 'usage-warn' : ''}`}>
                {formatNPR(s.cash_position.held_by_people_cents)}
              </dd>
            </dl>
            {s.cash_position.held_by_people_cents > 0 && (
              <p className="hint">
                Real money we own but can’t spend from an account. Kept separate on purpose —
                rolled into one “cash” figure it’s exactly what goes unnoticed.
              </p>
            )}
          </section>
        </div>
      )}
    </QueryState>
  );
}
