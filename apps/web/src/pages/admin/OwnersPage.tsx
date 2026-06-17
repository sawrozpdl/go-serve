import { useMemo, useState } from 'react';
import {
  Crown,
  Plus,
  TrendingUp,
  TrendingDown,
  HandCoins,
  Wallet,
  Trash2,
  Pencil,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Sparkles,
  Undo2,
  Eye,
  EyeOff,
  Banknote,
  Landmark,
  ShoppingBag,
  RotateCcw,
} from 'lucide-react';

import { Drawer } from '@/components/Drawer';
import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { RefreshButton } from '@/components/RefreshButton';
import { PageShell } from '@/components/PageShell';
import { Tabs, type TabItem } from '@/components/Tabs';
import { usePermissions } from '@/lib/permissions';
import {
  useCafeOwners,
  useCreateCafeOwner,
  useUpdateCafeOwner,
  useDeactivateCafeOwner,
  useRecordInvestment,
  useRecordPayouts,
  useRepayLoan,
  useOwnerLedger,
  useCafeBalance,
  useCafeSummary,
  useCorrectLedgerEntry,
  useMe,
  useMembers,
  useOwnerCash,
  useOwnerCashWithdraw,
  useOwnerCashReturn,
  useOwnerCashDeposit,
  useDeleteOwnerCashEntry,
  useDeleteExpense,
  useCreateExpense,
  useExpenseCategories,
  type CafeOwner,
  type CafeSummary,
  type OwnerLedgerEntry,
  type OwnerLedgerKind,
  type OwnerCashEntry,
  type OwnerCashHolding,
} from '@/lib/api';
import { toast } from '@/lib/toast';

const KIND_LABEL: Record<OwnerLedgerKind, string> = {
  investment: 'Investment',
  payout: 'Payout',
  loan_advance: 'Loan advance',
  loan_repayment: 'Loan repayment',
};

function kindTone(k: OwnerLedgerKind): 'in' | 'out' | 'debt' {
  if (k === 'investment') return 'in';
  if (k === 'payout' || k === 'loan_repayment') return 'out';
  return 'debt';
}

// =========================================================================
// Page
// =========================================================================

type OwnersTabKey = 'roster' | 'financials' | 'cash';

const OWNERS_TABS: TabItem<OwnersTabKey>[] = [
  { key: 'roster', label: 'Roster', icon: <Crown size={12} strokeWidth={1.6} /> },
  { key: 'financials', label: 'Financials', icon: <Wallet size={12} strokeWidth={1.6} /> },
  { key: 'cash', label: 'Cash with owners', icon: <Banknote size={12} strokeWidth={1.6} /> },
];

export function OwnersPage() {
  const { can } = usePermissions();
  const owners = useCafeOwners();
  const balance = useCafeBalance();
  const summary = useCafeSummary();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [payingOut, setPayingOut] = useState(false);
  const [selected, setSelected] = useState<CafeOwner | null>(null);
  const [tab, setTab] = useState<OwnersTabKey>('roster');

  const activeOwners = useMemo(
    () => (owners.data ?? []).filter((o) => !o.active_to),
    [owners.data],
  );
  const totalShares = activeOwners.reduce((s, o) => s + o.share_units, 0);
  const totalOutstanding = activeOwners.reduce((s, o) => s + o.outstanding_loans_cents, 0);
  const totalInvested = activeOwners.reduce((s, o) => s + o.lifetime_investment_cents, 0);
  const totalPaid = activeOwners.reduce((s, o) => s + o.lifetime_payouts_cents, 0);

  // If the logged-in user is an active owner of this cafe, surface a
  // personalised line below the cafe-wide totals. Match by user_id first
  // (immutable), fall back to email for owners linked by email only.
  const myOwner = useMemo<CafeOwner | undefined>(() => {
    const u = me.data;
    if (!u) return undefined;
    return activeOwners.find(
      (o) => (o.user_id && o.user_id === u.user_id) || (o.user_email && o.user_email === u.email),
    );
  }, [me.data, activeOwners]);

  return (
    <PageShell
      eyebrow="Equity & lending"
      title="Owners"
      actions={
        <>
          <RefreshButton
            onClick={() => Promise.all([owners.refetch(), balance.refetch()])}
            busy={owners.isFetching || balance.isFetching}
            label="Refresh"
          />
          {can('finance:payout') && (
            <button
              type="button"
              className="btn"
              disabled={activeOwners.length === 0}
              onClick={() => setPayingOut(true)}
            >
              <HandCoins size={14} strokeWidth={1.5} /> Record payout
            </button>
          )}
          {can('finance:create_owner') && (
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={1.5} /> Add owner
            </button>
          )}
        </>
      }
      tabs={<Tabs items={OWNERS_TABS} active={tab} onChange={setTab} ariaLabel="Owners sections" />}
    >
      {tab === 'roster' && (
        <section className="panel">
          <div className="panel-head">
            <h3>Roster</h3>
            <span className="meta">
              {totalShares > 0
                ? `${activeOwners.length} owners · ${totalShares} shares total`
                : 'no owners yet'}
            </span>
          </div>

          {owners.isPending && <LoadingState />}
          {owners.isError && !owners.data && <ErrorState onRetry={() => owners.refetch()} />}
          {owners.data?.length === 0 && (
            <EmptyState
              icon={<Crown size={36} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
              title="No owners yet"
              hint={
                <>
                  Add yourself + partners. Use <strong>share units</strong> (1:1:1 or 1:2:3) — the
                  ratio drives payout splits.
                </>
              }
            />
          )}
          {owners.data && owners.data.length > 0 && (
            <div className="owners-grid">
              {owners.data.map((o) => (
                <OwnerCard
                  key={o.id}
                  owner={o}
                  totalShares={totalShares}
                  paidLifetime={totalPaid}
                  onClick={() => setSelected(o)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'financials' && (
        <>
          {/* Summary KPIs */}
          <div className="kpis" style={{ marginBottom: 'var(--space-4)' }}>
            <SummaryKpi label="Active owners" value={activeOwners.length.toString()} />
            <SummaryKpi label="Total shares" value={totalShares.toString()} />
            <SummaryKpi label="Lifetime invested" cents={totalInvested} />
            <SummaryKpi
              label="Outstanding loans"
              cents={totalOutstanding}
              tone={totalOutstanding > 0 ? 'warn' : 'ok'}
            />
          </div>

          {/* Returns / transparency card — answers "I put in X, where is it?" */}
          <ReturnsCard summary={summary.data} myOwner={myOwner} totalShares={totalShares} />

          {/* Imbalance warning — equity says one split, actual money in says
           * another. */}
          <EquityVsInvestmentWarning
            owners={activeOwners}
            totalShares={totalShares}
            totalInvested={totalInvested}
          />
        </>
      )}

      {tab === 'cash' && <CashWithOwnersTab canManage={can('finance:owner_cash')} />}

      <OwnerEditorModal open={creating} onClose={() => setCreating(false)} />

      {selected && (
        <OwnerDetailDrawer
          owner={selected}
          onClose={() => setSelected(null)}
          totalShares={totalShares}
        />
      )}

      <PayoutModal
        open={payingOut}
        onClose={() => setPayingOut(false)}
        owners={activeOwners}
        bankCents={balance.data?.bank_cents ?? 0}
      />
    </PageShell>
  );
}

// =========================================================================
// Sub-components
// =========================================================================

// EquityVsInvestmentWarning compares the agreed share split (share_units)
// against the actual capital each owner has put in. When the two drift
// past a small tolerance, partners are silently subsidising each other —
// surface it so they can rebalance before payouts amplify the gap.
//
// Quiet when:
//   - fewer than 2 active owners (no split to compare against)
//   - nobody has invested yet (we'd be comparing against zero)
//   - max deviation from "fair share" is under the threshold below
function EquityVsInvestmentWarning({
  owners,
  totalShares,
  totalInvested,
}: {
  owners: CafeOwner[];
  totalShares: number;
  totalInvested: number;
}) {
  // 5 percentage points — small enough to catch a genuine drift, large
  // enough that a 95 / 5 split with one owner being a few rupees short
  // doesn't nag.
  const TOLERANCE_PCT = 5;

  const rows = useMemo(() => {
    if (owners.length < 2 || totalShares === 0 || totalInvested === 0) return [];
    return owners.map((o) => {
      const equityPct = (o.share_units / totalShares) * 100;
      const fairCents = Math.round((totalInvested * o.share_units) / totalShares);
      const investedPct =
        totalInvested > 0 ? (o.lifetime_investment_cents / totalInvested) * 100 : 0;
      // Positive deltaCents = this owner has put in MORE than their share
      // would imply (subsidising others). Negative = under-funded.
      const deltaCents = o.lifetime_investment_cents - fairCents;
      return { owner: o, equityPct, investedPct, fairCents, deltaCents };
    });
  }, [owners, totalShares, totalInvested]);

  const maxDeviation = rows.reduce(
    (m, r) => Math.max(m, Math.abs(r.equityPct - r.investedPct)),
    0,
  );
  if (rows.length < 2 || maxDeviation < TOLERANCE_PCT) return null;

  return (
    <section
      className="panel"
      style={{
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
        background: 'rgba(var(--amber-glow), 0.04)',
        border: '1px solid rgba(var(--amber-glow), 0.25)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          marginBottom: 10,
          color: 'var(--amber-fg)',
        }}
      >
        <AlertTriangle size={14} strokeWidth={1.6} />
        <strong style={{ fontSize: 'var(--text-md)' }}>Contributions don't match equity split</strong>
      </div>
      <div
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--ink-300)',
          marginBottom: 'var(--space-3)',
          lineHeight: 1.45,
        }}
      >
        Each owner's share of capital invested is more than {TOLERANCE_PCT}% away from their
        agreed equity. Top up the under-funded owner(s), or adjust share units, before the next
        payout — otherwise you'll be paying out on a ratio you haven't actually contributed to.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => {
          const off = r.equityPct - r.investedPct;
          const tone = Math.abs(off) >= TOLERANCE_PCT ? 'var(--amber-fg)' : 'var(--ink-300)';
          return (
            <div
              key={r.owner.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto auto',
                gap: 'var(--space-3)',
                alignItems: 'baseline',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-300)',
              }}
            >
              <span
                style={{
                  color: 'var(--ink-100)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--text-md)',
                }}
              >
                {r.owner.display_name}
              </span>
              <span>equity {r.equityPct.toFixed(1)}%</span>
              <span>in {r.investedPct.toFixed(1)}%</span>
              <span style={{ color: tone, fontFamily: 'var(--font-num)' }}>
                {r.deltaCents >= 0 ? '+' : '−'}
                {formatNPR(Math.abs(r.deltaCents))} vs fair share
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReturnsCard({
  summary,
  myOwner,
  totalShares,
}: {
  summary: CafeSummary | undefined;
  myOwner: CafeOwner | undefined;
  totalShares: number;
}) {
  if (!summary) return null;

  const myShareUnits = myOwner?.share_units ?? 0;
  const myShareFraction = totalShares > 0 ? myShareUnits / totalShares : 0;
  const myShareOfProfit = Math.round(summary.cafe_net_profit_cents * myShareFraction);
  // Net position = what you've received + your share of retained profit −
  // what you put in. Retained profit shows up via the cafe balance + loans
  // it has paid down, hence including the share-of-profit in "what you've
  // earned so far on paper".
  const myInvested = myOwner?.lifetime_investment_cents ?? 0;
  const myPaidOut = myOwner?.lifetime_payouts_cents ?? 0;
  const myNetPosition = myPaidOut + myShareOfProfit - myInvested;

  return (
    <section
      className="panel"
      style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-5)', background: 'var(--ink-950)' }}
    >
      <div className="panel-head" style={{ marginBottom: 14 }}>
        <h3>Returns</h3>
        <span className="meta">cafe finance at a glance · lifetime</span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
        }}
      >
        <ReturnsKpi label="Invested" cents={summary.lifetime_invested_cents} tone="ok" />
        <ReturnsKpi label="Paid out" cents={summary.lifetime_payouts_cents} />
        <ReturnsKpi
          label="Net profit (lifetime)"
          cents={summary.cafe_net_profit_cents}
          tone={summary.cafe_net_profit_cents >= 0 ? 'ok' : 'warn'}
          hint="revenue − direct cogs − expenses"
        />
        <ReturnsKpi label="Cash position now" cents={summary.cafe_balance_cents} />
      </div>

      <div
        style={{
          marginTop: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          letterSpacing: '0.06em',
          color: 'var(--ink-400)',
          display: 'flex',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <span>Revenue {formatNPR(summary.lifetime_revenue_cents)}</span>
        <span>Direct COGS {formatNPR(summary.lifetime_direct_cogs_cents)}</span>
        <span>Expenses {formatNPR(summary.lifetime_expenses_cents)}</span>
        {summary.outstanding_loans_cents > 0 && (
          <span style={{ color: 'var(--amber-fg)' }}>
            Open loans {formatNPR(summary.outstanding_loans_cents)}
          </span>
        )}
      </div>

      {myOwner && totalShares > 0 && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--ink-800)',
            display: 'flex',
            alignItems: 'baseline',
            gap: 18,
            flexWrap: 'wrap',
            fontSize: 'var(--text-md)',
            color: 'var(--ink-200)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-400)',
            }}
          >
            Your position
          </span>
          <span>
            Share <strong>{(myShareFraction * 100).toFixed(1)}%</strong>
          </span>
          <span>
            In <strong style={{ color: 'var(--lime-fg)' }}>{formatNPR(myInvested)}</strong>
          </span>
          <span>
            Out <strong>{formatNPR(myPaidOut)}</strong>
          </span>
          <span>
            Share of profit <strong>{formatNPR(myShareOfProfit)}</strong>
          </span>
          <span>
            Net{' '}
            <strong style={{ color: myNetPosition >= 0 ? 'var(--lime-fg)' : 'var(--amber-fg)' }}>
              {myNetPosition >= 0 ? '+' : '−'}
              {formatNPR(Math.abs(myNetPosition))}
            </strong>
          </span>
        </div>
      )}
    </section>
  );
}

function ReturnsKpi({
  label,
  cents,
  tone,
  hint,
}: {
  label: string;
  cents: number;
  tone?: 'ok' | 'warn';
  hint?: string;
}) {
  return (
    <div
      style={{
        padding: 'var(--space-3)',
        background: 'var(--ink-900)',
        border: '1px solid var(--ink-800)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--ink-400)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 22,
          fontWeight: 500,
          color:
            tone === 'warn' ? 'var(--amber-fg)' : tone === 'ok' ? 'var(--lime-fg)' : 'var(--ink-50)',
        }}
      >
        {formatNPR(cents)}
      </div>
      {hint && (
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.08em',
            color: 'var(--ink-500)',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function SummaryKpi({
  label,
  value,
  cents,
  tone,
}: {
  label: string;
  value?: string;
  cents?: number;
  tone?: 'ok' | 'warn';
}) {
  const text = value ?? formatNPR(cents ?? 0);
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div
        className="value"
        style={
          tone === 'warn'
            ? { color: 'var(--amber-fg)' }
            : tone === 'ok'
            ? { color: 'var(--lime-fg)' }
            : undefined
        }
      >
        {text}
      </div>
    </div>
  );
}

function OwnerCard({
  owner,
  totalShares,
  paidLifetime: _paidLifetime,
  onClick,
}: {
  owner: CafeOwner;
  totalShares: number;
  paidLifetime: number;
  onClick: () => void;
}) {
  const pct = totalShares > 0 ? (owner.share_units / totalShares) * 100 : 0;
  const exited = !!owner.active_to;
  return (
    <div
      className="owner-card"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Open ${owner.display_name}'s ledger`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="head">
        <div>
          <div className="name">{owner.display_name}</div>
          <div className="sub">
            {owner.user_email ?? 'silent partner'}
            {exited && ` · exited ${owner.active_to}`}
          </div>
        </div>
        <span
          className="pill"
          style={{
            background: 'rgba(var(--amber-glow), 0.12)',
            color: 'var(--amber-fg)',
            fontFamily: 'var(--font-num)',
            fontSize: 'var(--text-sm)',
            letterSpacing: 0,
            textTransform: 'none',
            padding: 'var(--space-1) var(--space-2)',
          }}
        >
          {owner.share_units} {owner.share_units === 1 ? 'share' : 'shares'}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--ink-300)',
          letterSpacing: '0.08em',
        }}
      >
        <span>
          <strong style={{ color: 'var(--ink-50)', fontFamily: 'var(--font-num)', fontSize: 14 }}>
            {pct.toFixed(1)}%
          </strong>{' '}
          equity
        </span>
        {owner.outstanding_loans_cents > 0 && (
          <span style={{ color: 'var(--amber-fg)' }}>
            owes {formatNPR(owner.outstanding_loans_cents)}
          </span>
        )}
      </div>
      <div className="stats">
        <span>Invested</span>
        <span className="num" style={{ textAlign: 'right', color: 'var(--lime-fg)' }}>
          {formatNPR(owner.lifetime_investment_cents)}
        </span>
        <span>Paid out</span>
        <span className="num" style={{ textAlign: 'right' }}>
          {formatNPR(owner.lifetime_payouts_cents)}
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------

function OwnerDetailDrawer({
  owner,
  onClose,
  totalShares,
}: {
  owner: CafeOwner;
  onClose: () => void;
  totalShares: number;
}) {
  const { can } = usePermissions();
  const ledger = useOwnerLedger({ owner_id: owner.id });
  const repay = useRepayLoan();
  const correct = useCorrectLedgerEntry();
  const confirm = useConfirm();
  const deactivate = useDeactivateCafeOwner();
  const [editing, setEditing] = useState(false);
  const [investing, setInvesting] = useState(false);
  const [repayLoan, setRepayLoan] = useState<OwnerLedgerEntry | null>(null);
  const [showCorrected, setShowCorrected] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Set of original ledger ids that have been reversed by a correction row.
  // Used to (a) hide reversed pairs by default and (b) suppress the reverse
  // button on rows that are already reversed.
  const reversedIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of ledger.data ?? []) {
      if (e.is_correction && e.corrects_id) s.add(e.corrects_id);
    }
    return s;
  }, [ledger.data]);

  const visibleLedger = useMemo(() => {
    const rows = ledger.data ?? [];
    if (showCorrected) return rows;
    return rows.filter((e) => !e.is_correction && !reversedIds.has(e.id));
  }, [ledger.data, reversedIds, showCorrected]);

  const hiddenCount = (ledger.data?.length ?? 0) - visibleLedger.length;

  const onReverseInvestment = async (entry: OwnerLedgerEntry) => {
    const ok = await confirm({
      title: 'Delete this investment?',
      message: (
        <>
          Reverse the <strong>{formatNPR(entry.amount_cents)}</strong> investment recorded on{' '}
          {new Date(entry.occurred_at).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })}
          ? A paired correction row preserves the audit trail.
        </>
      ),
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await correct.mutateAsync({
        id: entry.id,
        notes: 'reversed via owner drawer',
      });
      toast.success('Investment reversed', formatNPR(entry.amount_cents));
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed to reverse');
    }
  };

  const loans = (ledger.data ?? []).filter((e) => e.kind === 'loan_advance' && !e.is_correction);
  const pct = totalShares > 0 ? (owner.share_units / totalShares) * 100 : 0;
  const exited = !!owner.active_to;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={owner.display_name}
        subtitle={`${owner.share_units} share${owner.share_units === 1 ? '' : 's'} · ${pct.toFixed(
          1,
        )}% equity · ${owner.user_email ?? 'silent partner'}${
          exited ? ` · exited ${owner.active_to}` : ''
        }`}
        headerExtra={
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--ink-300)',
            }}
          >
            owner
          </div>
        }
      >
          {err && <div className="banner-error">{err}</div>}

          {/* Quick stats */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 10,
              marginBottom: 'var(--space-5)',
            }}
          >
            <MiniStat label="Invested" cents={owner.lifetime_investment_cents} tone="ok" />
            <MiniStat label="Paid out" cents={owner.lifetime_payouts_cents} />
            <MiniStat
              label="Outstanding"
              cents={owner.outstanding_loans_cents}
              tone={owner.outstanding_loans_cents > 0 ? 'warn' : undefined}
            />
          </div>

          {/* Action buttons */}
          {!exited && (
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                flexWrap: 'wrap',
                marginBottom: 'var(--space-5)',
              }}
            >
              {can('finance:invest') && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setInvesting(true)}
                >
                  <TrendingUp size={14} strokeWidth={1.5} /> Record investment
                </button>
              )}
              {can('finance:update_owner') && (
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  <Pencil size={14} strokeWidth={1.5} /> Edit
                </button>
              )}
              {can('finance:delete_owner') && (
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Deactivate owner?',
                    message: (
                      <>
                        Mark <strong>{owner.display_name}</strong> as exited. Their ledger
                        history is preserved.
                        {owner.outstanding_loans_cents > 0 && (
                          <>
                            {' '}
                            They still have <strong>{formatNPR(owner.outstanding_loans_cents)}</strong>{' '}
                            outstanding — confirm you've settled this offline before proceeding.
                          </>
                        )}
                      </>
                    ),
                    danger: true,
                    confirmLabel: 'Deactivate',
                  });
                  if (!ok) return;
                  try {
                    await deactivate.mutateAsync({
                      id: owner.id,
                      force: owner.outstanding_loans_cents > 0,
                    });
                    onClose();
                  } catch (e: unknown) {
                    setErr((e as { message?: string }).message ?? 'Failed');
                  }
                }}
              >
                <Trash2 size={14} strokeWidth={1.5} /> Deactivate
              </button>
              )}
            </div>
          )}

          {/* Outstanding loans */}
          {loans.length > 0 && (
            <section style={{ marginBottom: 22 }}>
              <SectionTitle>Outstanding loans</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {loans.map((loan) => {
                  const remaining = loan.amount_cents - (loan.repaid_cents ?? 0);
                  if (remaining <= 0) return null;
                  return (
                    <div
                      key={loan.id}
                      style={{
                        padding: 'var(--space-3)',
                        border: '1px solid var(--ink-800)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'rgba(var(--amber-glow), 0.04)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: 'var(--space-3)',
                        }}
                      >
                        <div>
                          <div style={{ color: 'var(--ink-50)', fontSize: 'var(--text-md)' }}>
                            {loan.expense_vendor ?? loan.notes ?? 'Loan advance'}
                          </div>
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 'var(--text-2xs)',
                              color: 'var(--ink-400)',
                              marginTop: 2,
                            }}
                          >
                            {new Date(loan.occurred_at).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: '2-digit',
                            })}{' '}
                            · {formatNPR(loan.amount_cents)} advanced · {formatNPR(loan.repaid_cents ?? 0)} repaid
                          </div>
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--font-num)',
                            color: 'var(--amber-fg)',
                            fontSize: 18,
                          }}
                        >
                          {formatNPR(remaining)}
                        </div>
                      </div>
                      {can('finance:repay') && (
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => setRepayLoan(loan)}
                          disabled={repay.isPending}
                          style={{ marginTop: 'var(--space-2)' }}
                        >
                          <HandCoins size={12} strokeWidth={1.5} /> Repay from bank
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Full ledger */}
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-2)',
            }}
          >
            <SectionTitle>Activity</SectionTitle>
            {hiddenCount > 0 && (
              <button
                type="button"
                className="btn small"
                onClick={() => setShowCorrected((v) => !v)}
                title="Reversed entries are kept for the audit trail"
              >
                {showCorrected ? (
                  <>
                    <EyeOff size={12} strokeWidth={1.5} /> Hide reversed
                  </>
                ) : (
                  <>
                    <Eye size={12} strokeWidth={1.5} /> Show {hiddenCount} reversed
                  </>
                )}
              </button>
            )}
          </div>
          {ledger.isPending && <LoadingState compact />}
          {ledger.isError && !ledger.data && <ErrorState compact onRetry={() => ledger.refetch()} />}
          {ledger.data?.length === 0 && (
            <div className="empty-state" style={{ fontSize: 'var(--text-sm)' }}>
              No money flows yet — record an investment to start.
            </div>
          )}
          {ledger.data && visibleLedger.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visibleLedger.map((e) => (
                <LedgerRow
                  key={e.id}
                  entry={e}
                  onReverse={
                    can('finance:correct') &&
                    e.kind === 'investment' &&
                    !e.is_correction &&
                    !reversedIds.has(e.id) &&
                    !exited
                      ? () => onReverseInvestment(e)
                      : undefined
                  }
                  pending={correct.isPending}
                />
              ))}
            </div>
          )}
      </Drawer>

      <OwnerEditorModal
        open={editing}
        onClose={() => setEditing(false)}
        existing={owner}
      />

      <InvestmentModal
        open={investing}
        onClose={() => setInvesting(false)}
        owner={owner}
      />

      {repayLoan && (
        <RepayLoanModal
          loan={repayLoan}
          onClose={() => setRepayLoan(null)}
        />
      )}
    </>
  );
}

function MiniStat({
  label,
  cents,
  tone,
}: {
  label: string;
  cents: number;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div
      style={{
        padding: 'var(--space-3)',
        background: 'var(--ink-900)',
        border: '1px solid var(--ink-800)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--ink-400)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 17,
          color:
            tone === 'ok' ? 'var(--lime-fg)' : tone === 'warn' ? 'var(--amber-fg)' : 'var(--ink-50)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatNPR(cents)}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="eyebrow"
      style={{
        fontSize: 'var(--text-2xs)',
        letterSpacing: '0.14em',
        marginBottom: 'var(--space-2)',
        color: 'var(--ink-300)',
      }}
    >
      {children}
    </div>
  );
}

function LedgerRow({
  entry,
  onReverse,
  pending,
}: {
  entry: OwnerLedgerEntry;
  onReverse?: () => void;
  pending?: boolean;
}) {
  const tone = kindTone(entry.kind);
  const iconColor =
    tone === 'in' ? 'var(--lime-fg)' : tone === 'out' ? 'var(--amber-fg)' : 'var(--ink-300)';
  const Icon = tone === 'in' ? ArrowDownRight : tone === 'out' ? ArrowUpRight : Sparkles;
  return (
    <div className="ledger-row">
      <span style={{ color: iconColor }}>
        <Icon size={14} strokeWidth={1.5} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ color: 'var(--ink-50)', fontSize: 'var(--text-md)' }}>
          {KIND_LABEL[entry.kind]}
          {entry.is_correction && (
            <span
              className="pill warn"
              style={{ marginLeft: 'var(--space-2)', fontSize: 9, letterSpacing: '0.08em' }}
            >
              correction
            </span>
          )}
          {entry.expense_vendor && (
            <span style={{ color: 'var(--ink-400)', fontWeight: 400 }}>
              {' '}
              — {entry.expense_vendor}
            </span>
          )}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            letterSpacing: '0.06em',
            color: 'var(--ink-400)',
          }}
        >
          {new Date(entry.occurred_at).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {entry.notes && ` · ${entry.notes}`}
        </span>
      </span>
      <span
        className="num"
        style={{
          color: tone === 'in' ? 'var(--lime-fg)' : tone === 'out' ? 'var(--amber-fg)' : undefined,
        }}
      >
        {tone === 'out' ? '−' : tone === 'in' ? '+' : ''} {formatNPR(entry.amount_cents)}
      </span>
      <span>
        {onReverse && (
          <button
            type="button"
            className="btn icon danger"
            onClick={onReverse}
            disabled={pending}
            aria-label="Reverse this entry"
            title="Reverse this entry (creates a paired correction; audited)"
          >
            <Undo2 size={12} strokeWidth={1.5} />
          </button>
        )}
      </span>
    </div>
  );
}

// -------------------------------------------------------------------------
// Modals
// -------------------------------------------------------------------------

function OwnerEditorModal({
  open,
  onClose,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  existing?: CafeOwner;
}) {
  const create = useCreateCafeOwner();
  const update = useUpdateCafeOwner();
  const members = useMembers();
  const [displayName, setDisplayName] = useState(existing?.display_name ?? '');
  const [shareUnits, setShareUnits] = useState(String(existing?.share_units ?? 1));
  const [userId, setUserId] = useState(existing?.user_id ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Edit owner' : 'Add owner'}
      subtitle={
        existing
          ? 'Update share units and name. History is preserved.'
          : 'Integer share units (1:1:1, 1:2:3) drive payout splits.'
      }
    >
      {err && <div className="banner-error">{err}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const units = parseInt(shareUnits, 10);
          if (!displayName.trim()) {
            setErr('display name required');
            return;
          }
          if (!Number.isFinite(units) || units < 1) {
            setErr('share units must be a positive integer');
            return;
          }
          try {
            if (existing) {
              await update.mutateAsync({
                id: existing.id,
                patch: { display_name: displayName.trim(), share_units: units, notes },
              });
            } else {
              await create.mutateAsync({
                display_name: displayName.trim(),
                share_units: units,
                user_id: userId || undefined,
                notes,
              });
            }
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Display name</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Saroj P."
          autoFocus
          required
        />

        <label>Share units</label>
        <input
          inputMode="numeric"
          value={shareUnits}
          onChange={(e) => setShareUnits(e.target.value.replace(/[^0-9]/g, ''))}
          required
        />
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--ink-400)',
            marginTop: -8,
            marginBottom: 'var(--space-3)',
          }}
        >
          equal partners: enter 1 each. e.g. 2 vs 1 share = 67% vs 33%.
        </div>

        {!existing && (
          <>
            <label>Linked team member (optional)</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">— silent partner (no login) —</option>
              {(members.data ?? []).map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name || m.email} · {m.roles.join('+')}
                </option>
              ))}
            </select>
          </>
        )}

        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional — partnership terms, exit conditions…"
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={create.isPending || update.isPending}
          >
            {(create.isPending || update.isPending) ? 'Saving…' : existing ? 'Save' : 'Add owner'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InvestmentModal({
  open,
  onClose,
  owner,
}: {
  open: boolean;
  onClose: () => void;
  owner: CafeOwner;
}) {
  const record = useRecordInvestment();
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record investment from ${owner.display_name}`}
      subtitle="Credits the cafe bank balance — money is now in the bank."
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
          try {
            await record.mutateAsync({ owner_id: owner.id, amount_cents: cents, notes });
            setAmount('');
            setNotes('');
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Amount (NPR)</label>
        <input
          inputMode="decimal"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="100000"
        />

        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional — purpose, reference, deposit slip…"
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={record.isPending}>
            {record.isPending ? 'Saving…' : 'Record investment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RepayLoanModal({
  loan,
  onClose,
}: {
  loan: OwnerLedgerEntry;
  onClose: () => void;
}) {
  const repay = useRepayLoan();
  const remaining = loan.amount_cents - (loan.repaid_cents ?? 0);
  const [amount, setAmount] = useState((remaining / 100).toString());
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Repay ${loan.owner_name}`}
      subtitle={`Debits cafe bank · ${formatNPR(remaining)} remaining on this loan`}
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
          if (cents > remaining) {
            setErr(`only ${formatNPR(remaining)} remaining on this loan`);
            return;
          }
          try {
            await repay.mutateAsync({ loan_id: loan.id, amount_cents: cents, notes });
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Amount (NPR)</label>
        <input
          inputMode="decimal"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional — bank slip ref, transaction id…"
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={repay.isPending}>
            {repay.isPending ? 'Saving…' : 'Repay loan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PayoutModal({
  open,
  onClose,
  owners,
  bankCents,
}: {
  open: boolean;
  onClose: () => void;
  owners: CafeOwner[];
  bankCents: number;
}) {
  const record = useRecordPayouts();
  const [total, setTotal] = useState('');
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [autoSplit, setAutoSplit] = useState(true);

  const totalShares = owners.reduce((s, o) => s + o.share_units, 0);
  const totalCents = parsePriceInput(total) ?? 0;

  // Pre-fill entries from share ratio whenever total or autoSplit changes.
  const prefilled = useMemo(() => {
    if (!autoSplit || totalCents <= 0 || totalShares === 0) return {};
    const result: Record<string, string> = {};
    let used = 0;
    owners.forEach((o, i) => {
      if (i === owners.length - 1) {
        result[o.id] = ((totalCents - used) / 100).toString();
      } else {
        const share = Math.floor((totalCents * o.share_units) / totalShares);
        used += share;
        result[o.id] = (share / 100).toString();
      }
    });
    return result;
  }, [total, autoSplit, owners, totalCents, totalShares]);

  const enteredEntries = autoSplit ? prefilled : entries;
  const enteredTotal = owners.reduce((s, o) => {
    return s + (parsePriceInput(enteredEntries[o.id] ?? '0') ?? 0);
  }, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record owner payout"
      subtitle={`Bank balance: ${formatNPR(bankCents)} · auto-splits by share ratio`}
    >
      {err && <div className="banner-error">{err}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const list = owners
            .map((o) => ({
              owner_id: o.id,
              amount_cents: parsePriceInput(enteredEntries[o.id] ?? '0') ?? 0,
            }))
            .filter((x) => x.amount_cents > 0);
          if (list.length === 0) {
            setErr('enter at least one payout');
            return;
          }
          const sum = list.reduce((s, x) => s + x.amount_cents, 0);
          if (sum > bankCents) {
            setErr(`payout (${formatNPR(sum)}) exceeds bank balance (${formatNPR(bankCents)})`);
            return;
          }
          try {
            await record.mutateAsync({ entries: list, notes });
            setTotal('');
            setEntries({});
            setNotes('');
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Total to withdraw (NPR)</label>
        <input
          inputMode="decimal"
          autoFocus
          value={total}
          onChange={(e) => {
            setTotal(e.target.value);
            if (!autoSplit) setAutoSplit(true);
          }}
          placeholder="50000"
        />

        <div
          style={{
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--ink-800)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-2)',
            }}
          >
            <span className="eyebrow" style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-300)' }}>
              per-owner split
            </span>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-300)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoSplit}
                onChange={(e) => {
                  setAutoSplit(e.target.checked);
                  if (!e.target.checked) {
                    setEntries(prefilled);
                  }
                }}
              />
              auto-split from shares
            </label>
          </div>

          {owners.map((o) => {
            const pct = totalShares > 0 ? (o.share_units / totalShares) * 100 : 0;
            return (
              <div
                key={o.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 130px',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  padding: 'var(--space-2) 0',
                }}
              >
                <span>
                  <span style={{ color: 'var(--ink-50)' }}>{o.display_name}</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-2xs)',
                      color: 'var(--ink-400)',
                      marginLeft: 'var(--space-2)',
                    }}
                  >
                    {o.share_units}sh · {pct.toFixed(1)}%
                  </span>
                </span>
                <input
                  inputMode="decimal"
                  value={enteredEntries[o.id] ?? ''}
                  onChange={(e) => {
                    setAutoSplit(false);
                    setEntries((prev) => ({ ...prev, [o.id]: e.target.value }));
                  }}
                  placeholder="0"
                  style={{ textAlign: 'right' }}
                />
              </div>
            );
          })}
          <div
            style={{
              marginTop: 'var(--space-3)',
              paddingTop: 'var(--space-2)',
              borderTop: '1px solid var(--ink-800)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              letterSpacing: '0.08em',
              color: 'var(--ink-300)',
            }}
          >
            <span>SUM</span>
            <span
              className="num"
              style={{
                fontFamily: 'var(--font-num)',
                fontSize: 16,
                color: enteredTotal > bankCents ? 'var(--danger-fg)' : 'var(--ink-50)',
              }}
            >
              {formatNPR(enteredTotal)}
            </span>
          </div>
          {enteredTotal > bankCents && (
            <div className="field-warn" style={{ marginTop: 6 }}>
              <AlertTriangle size={11} strokeWidth={1.5} />
              exceeds bank balance — record a deposit first
            </div>
          )}
        </div>

        <label style={{ marginTop: 14 }}>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional — bank slip, period being paid out…"
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={record.isPending || enteredTotal === 0 || enteredTotal > bankCents}
          >
            <Wallet size={12} strokeWidth={1.5} />
            {record.isPending ? 'Saving…' : `Record ${formatNPR(enteredTotal)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// =========================================================================
// Cash with owners — custody tracking
// =========================================================================

type CashMode = 'withdraw' | 'deposit' | 'spend' | 'return';

const CASH_KIND_LABEL: Record<OwnerCashEntry['kind'], string> = {
  withdrawal: 'Took from drawer',
  bank_deposit: 'Deposited to bank',
  cafe_expense: 'Spent on cafe',
  return_to_drawer: 'Returned to drawer',
};

function CashWithOwnersTab({ canManage }: { canManage: boolean }) {
  const cash = useOwnerCash();
  const del = useDeleteOwnerCashEntry();
  const delExpense = useDeleteExpense();
  const confirm = useConfirm();
  const [action, setAction] = useState<{ mode: CashMode; owner: OwnerCashHolding } | null>(null);

  const holdings = cash.data?.holdings ?? [];
  const entries = cash.data?.entries ?? [];
  const totalHeld = holdings.reduce((s, h) => s + h.holding_cents, 0);

  const onDelete = async (e: OwnerCashEntry) => {
    // A "Spent on cafe" movement is just the custody side of an expense. Deleting
    // the expense is what reverses it (the server cascades the owner_cash_entries
    // row), so route the delete through there instead of dead-ending the user.
    if (e.kind === 'cafe_expense') {
      if (!e.expense_id) {
        toast.error('Delete the expense instead', 'This entry is linked to a cafe expense.');
        return;
      }
      const ok = await confirm({
        title: 'Remove this spend?',
        message: (
          <>
            This also deletes the linked <strong>{formatNPR(e.amount_cents)}</strong> expense
            {e.expense_vendor ? (
              <>
                {' '}for <strong>{e.expense_vendor}</strong>
              </>
            ) : null}{' '}
            and returns the cash to <strong>{e.owner_name}</strong>.
          </>
        ),
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
      try {
        await delExpense.mutateAsync(e.expense_id);
        toast.success('Spend removed', 'The linked expense was deleted too.');
      } catch (err: unknown) {
        toast.error('Could not remove', (err as { message?: string }).message ?? 'Failed');
      }
      return;
    }
    const ok = await confirm({
      title: 'Remove this entry?',
      message: (
        <>
          Undo the <strong>{formatNPR(e.amount_cents)}</strong> {CASH_KIND_LABEL[e.kind].toLowerCase()} for{' '}
          <strong>{e.owner_name}</strong>? Any paired drawer movement is reversed too.
        </>
      ),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync({ id: e.id });
      toast.success('Entry removed');
    } catch (err: unknown) {
      toast.error('Could not remove', (err as { message?: string }).message ?? 'Failed');
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h3>Cash held by owners</h3>
          <span className="meta">
            {totalHeld > 0 ? `${formatNPR(totalHeld)} out with owners` : 'all settled'}
          </span>
        </div>
        <p className="tab-sub" style={{ marginTop: 0 }}>
          Cash an owner has taken from the drawer but not yet accounted for. It's still cafe money —
          reconcile each holding by depositing it to the bank, spending it on the cafe, or returning
          it to the till.
        </p>

        {cash.isPending && <LoadingState />}
        {cash.isError && !cash.data && <ErrorState onRetry={() => cash.refetch()} />}
        {cash.data && holdings.length === 0 && (
          <EmptyState
            icon={<Banknote size={36} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
            title="No owners yet"
            hint="Add owners on the Roster tab, then record the cash they take here."
          />
        )}

        {holdings.length > 0 && (
          <div className="owners-grid">
            {holdings.map((h) => {
              const held = h.holding_cents;
              return (
                <div key={h.owner_id} className="owner-card" style={{ cursor: 'default' }}>
                  <div className="head">
                    <div>
                      <div className="name">{h.display_name}</div>
                      <div className="sub">{h.active ? 'holding cafe cash' : 'exited owner'}</div>
                    </div>
                    <span
                      className="num"
                      style={{
                        fontFamily: 'var(--font-num)',
                        fontSize: 20,
                        color:
                          held > 0 ? 'var(--amber-fg)' : held < 0 ? 'var(--danger-fg)' : 'var(--ink-300)',
                      }}
                    >
                      {formatNPR(held)}
                    </span>
                  </div>
                  {canManage && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 'var(--space-2)',
                        marginTop: 'var(--space-2)',
                      }}
                    >
                      <button
                        type="button"
                        className="btn small"
                        disabled={!h.active}
                        onClick={() => setAction({ mode: 'withdraw', owner: h })}
                      >
                        <ArrowDownRight size={12} strokeWidth={1.6} /> Take cash
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={held <= 0}
                        onClick={() => setAction({ mode: 'deposit', owner: h })}
                      >
                        <Landmark size={12} strokeWidth={1.6} /> Deposit to bank
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={held <= 0}
                        onClick={() => setAction({ mode: 'spend', owner: h })}
                      >
                        <ShoppingBag size={12} strokeWidth={1.6} /> Spend on cafe
                      </button>
                      <button
                        type="button"
                        className="btn small ghost"
                        disabled={held <= 0}
                        onClick={() => setAction({ mode: 'return', owner: h })}
                      >
                        <RotateCcw size={12} strokeWidth={1.6} /> Return
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 'var(--space-4)' }}>
        <div className="panel-head">
          <h3>Recent movements</h3>
        </div>
        {entries.length === 0 ? (
          <EmptyState
            icon={<Banknote size={32} strokeWidth={1.5} style={{ color: 'var(--ink-400)' }} />}
            title="Nothing recorded yet"
            hint="Owner cash withdrawals and reconciliations show up here."
          />
        ) : (
          <div>
            {entries.map((e) => (
              <CashEntryRow key={e.id} entry={e} canManage={canManage} onDelete={() => onDelete(e)} />
            ))}
          </div>
        )}
      </section>

      {action && (
        <OwnerCashModal
          mode={action.mode}
          owner={action.owner}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}

function CashEntryRow({
  entry,
  canManage,
  onDelete,
}: {
  entry: OwnerCashEntry;
  canManage: boolean;
  onDelete: () => void;
}) {
  const inflow = entry.kind === 'withdrawal'; // raises the owner's holding
  const sign = inflow ? '+' : '−';
  const when = new Date(entry.occurred_at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto auto',
        gap: 'var(--space-3)',
        alignItems: 'center',
        padding: 'var(--space-2) 0',
        borderBottom: '1px solid var(--ink-850)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--ink-50)' }}>
          {entry.owner_name}
          <span
            style={{
              marginLeft: 'var(--space-2)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              letterSpacing: '0.06em',
              color: 'var(--ink-400)',
              textTransform: 'uppercase',
            }}
          >
            {CASH_KIND_LABEL[entry.kind]}
          </span>
        </div>
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-400)' }}>
          {when}
          {entry.expense_vendor ? ` · ${entry.expense_vendor}` : ''}
          {entry.reference_no ? ` · ref ${entry.reference_no}` : ''}
          {entry.notes ? ` · ${entry.notes}` : ''}
        </div>
      </div>
      <span
        className="num"
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 14,
          color: inflow ? 'var(--amber-fg)' : 'var(--ink-200)',
          textAlign: 'right',
        }}
      >
        {sign} {formatNPR(entry.amount_cents)}
      </span>
      {canManage ? (
        <button
          type="button"
          className="btn small ghost"
          title={entry.kind === 'cafe_expense' ? 'Remove spend (deletes the linked expense)' : 'Remove this entry'}
          aria-label="Remove this entry"
          onClick={onDelete}
        >
          <Trash2 size={13} strokeWidth={1.6} />
        </button>
      ) : (
        <span style={{ width: 28 }} />
      )}
    </div>
  );
}

function OwnerCashModal({
  mode,
  owner,
  onClose,
}: {
  mode: CashMode;
  owner: OwnerCashHolding;
  onClose: () => void;
}) {
  const withdraw = useOwnerCashWithdraw();
  const deposit = useOwnerCashDeposit();
  const returnCash = useOwnerCashReturn();
  const spend = useCreateExpense();
  const categories = useExpenseCategories();

  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [vendor, setVendor] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const held = owner.holding_cents;
  const reconciling = mode !== 'withdraw';
  const pending =
    withdraw.isPending || deposit.isPending || returnCash.isPending || spend.isPending;

  const meta: Record<CashMode, { title: string; subtitle: string; cta: string }> = {
    withdraw: {
      title: `${owner.display_name} takes cash`,
      subtitle: 'Pulls cash out of the drawer — needs an open shift. Still cafe money until reconciled.',
      cta: 'Record withdrawal',
    },
    deposit: {
      title: `${owner.display_name} deposits to bank`,
      subtitle: `Moves held cash into the cafe bank · ${formatNPR(held)} on hand`,
      cta: 'Record deposit',
    },
    spend: {
      title: `${owner.display_name} spends on the cafe`,
      subtitle: `Records a cafe expense paid from held cash · ${formatNPR(held)} on hand`,
      cta: 'Record expense',
    },
    return: {
      title: `${owner.display_name} returns cash`,
      subtitle: `Puts held cash back in the till — needs an open shift · ${formatNPR(held)} on hand`,
      cta: 'Record return',
    },
  };

  return (
    <Modal open={true} onClose={onClose} title={meta[mode].title} subtitle={meta[mode].subtitle}>
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
          if (reconciling && cents > held) {
            setErr(`only ${formatNPR(held)} is on hand for ${owner.display_name}`);
            return;
          }
          try {
            if (mode === 'withdraw') {
              await withdraw.mutateAsync({ owner_id: owner.owner_id, amount_cents: cents, notes });
            } else if (mode === 'deposit') {
              await deposit.mutateAsync({
                owner_id: owner.owner_id,
                amount_cents: cents,
                reference_no: reference,
                notes,
              });
            } else if (mode === 'return') {
              await returnCash.mutateAsync({ owner_id: owner.owner_id, amount_cents: cents, notes });
            } else {
              await spend.mutateAsync({
                paid_from: 'owner_cash',
                owner_id: owner.owner_id,
                amount_cents: cents,
                vendor,
                notes,
                expense_category_id: categoryId || undefined,
              });
            }
            toast.success(meta[mode].cta.replace('Record ', '') + ' recorded', formatNPR(cents));
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Amount (NPR)</label>
        <input
          inputMode="decimal"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
        />

        {mode === 'spend' && (
          <>
            <label>Vendor / what for</label>
            <input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Local Mill, gas refill"
            />
            <label>Category</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">— uncategorised —</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}

        {mode === 'deposit' && (
          <>
            <label>Deposit slip / reference</label>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="optional — slip no., txn id"
            />
          </>
        )}

        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional"
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? 'Saving…' : meta[mode].cta}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Silence unused-icon import warnings used conditionally.
export const _ownerIcons = { Plus, TrendingUp, TrendingDown, Wallet };
