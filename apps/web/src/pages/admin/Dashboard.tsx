import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Coffee,
  Receipt,
  LayoutDashboard,
  Activity,
  Compass,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  BarChart3,
  List,
  Clock,
  Wallet,
  Banknote,
  Globe,
  Users,
} from 'lucide-react';

import {
  useReportsDashboard,
  useHourly,
  useExpenses,
  useInventoryItems,
  useTenantSettings,
  useCafeBalance,
  type DashboardRange,
  type DashboardCustom,
  type PaymentMix,
  type TabBreakdownRow,
} from '@/lib/api';
import { useTour, useOnceNudge } from '@/guide/tour/TourProvider';
import { todayIso, addDaysIso } from '@/lib/dates';
import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { formatNPR } from '@/components/Money';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { InfoHint } from '@/components/InfoHint';
import { FeatureGate } from '@/components/FeatureGate';
import { UpgradePrompt } from '@/components/UpgradePrompt';
import { Tabs, type TabItem } from '@/components/Tabs';
import {
  TopMoversPanel,
  CategoryMixPanel,
  HeatmapPanel,
  VelocityPanel,
  TableMixPanel,
} from './AnalyticsPanels';

// -------------------------------------------------------------------------
// Page shell — owns the header, range picker, and tab nav. Each tab body
// is mounted only when active so its data hooks don't fire until visited.
// -------------------------------------------------------------------------

const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'mtd', label: 'This Month' },
];

type TabKey = 'overview' | 'sales' | 'hourly' | 'operations';

const TAB_ITEMS: TabItem<TabKey>[] = [
  { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={12} strokeWidth={1.6} /> },
  { key: 'sales', label: 'Sales', icon: <Activity size={12} strokeWidth={1.6} /> },
  { key: 'hourly', label: 'Hourly', icon: <Clock size={12} strokeWidth={1.6} /> },
  { key: 'operations', label: 'Operations', icon: <Receipt size={12} strokeWidth={1.6} /> },
];

// -------------------------------------------------------------------------
// Period selection — a preset chip, a whole month, or an explicit from–to
// range. Persisted in the URL: ?range=<preset> | ?range=custom&month=YYYY-MM |
// ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD.
// -------------------------------------------------------------------------

type PeriodSel =
  | { kind: 'preset'; range: DashboardRange }
  | { kind: 'month'; month: string } // YYYY-MM
  | { kind: 'custom'; from: string; to: string };

const PRESET_VALUES: DashboardRange[] = ['today', 'yesterday', '7d', '30d', 'mtd', 'ytd'];
const YM_RE = /^\d{4}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriod(params: URLSearchParams): PeriodSel {
  const r = (params.get('range') || 'today') as DashboardRange;
  if (r === 'custom') {
    const month = params.get('month');
    if (month && YM_RE.test(month)) return { kind: 'month', month };
    const from = params.get('from');
    const to = params.get('to');
    if (from && to && ISO_RE.test(from) && ISO_RE.test(to)) return { kind: 'custom', from, to };
    return { kind: 'preset', range: 'today' };
  }
  return { kind: 'preset', range: PRESET_VALUES.includes(r) ? r : 'today' };
}

// Resolve the selection into what the report hooks expect.
function selToQuery(sel: PeriodSel): { range: DashboardRange; custom?: DashboardCustom } {
  if (sel.kind === 'preset') return { range: sel.range };
  if (sel.kind === 'month') return { range: 'custom', custom: monthBounds(sel.month) };
  return { range: 'custom', custom: { from: sel.from, to: sel.to } };
}

// First-of-month → last-of-month (clamped to today), both inclusive YYYY-MM-DD.
function monthBounds(ym: string): DashboardCustom {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  const lastIso = `${ym}-${String(lastDay).padStart(2, '0')}`;
  const today = todayIso();
  return { from: `${ym}-01`, to: lastIso > today ? today : lastIso };
}

function monthLabel(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function currentYm(): string {
  return todayIso().slice(0, 7);
}

function shiftYm(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Last `n` months (YYYY-MM), most recent first, ending at the current month.
function recentMonths(n: number): string[] {
  const out: string[] = [];
  let ym = currentYm();
  for (let i = 0; i < n; i++) {
    out.push(ym);
    ym = shiftYm(ym, -1);
  }
  return out;
}

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const sel = parsePeriod(params);
  const { range, custom } = selToQuery(sel);
  const tabParam = params.get('tab');
  const tab: TabKey = TAB_ITEMS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview';

  const { startTour } = useTour();
  const [showNudge, dismissNudge] = useOnceNudge('dashboard-tour');

  const setPeriod = (next: PeriodSel) => {
    const p = new URLSearchParams(params);
    p.delete('from');
    p.delete('to');
    p.delete('month');
    if (next.kind === 'preset') {
      p.set('range', next.range);
    } else if (next.kind === 'month') {
      p.set('range', 'custom');
      p.set('month', next.month);
    } else {
      p.set('range', 'custom');
      p.set('from', next.from);
      p.set('to', next.to);
    }
    setParams(p, { replace: true });
  };
  const setTab = (v: TabKey) => {
    const next = new URLSearchParams(params);
    next.set('tab', v);
    setParams(next, { replace: true });
  };

  return (
    <PageShell
      eyebrow={new Date().toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      })}
      title="Dashboard"
      actions={
        <div className="dash-period" data-tour="dash-period">
          <div className="filter-row" style={{ marginBottom: 0 }}>
            {RANGES.map((r) => (
              <button
                type="button"
                key={r.value}
                className={`chip ${sel.kind === 'preset' && sel.range === r.value ? 'active' : ''}`}
                onClick={() => setPeriod({ kind: 'preset', range: r.value })}
              >
                {r.label}
              </button>
            ))}
          </div>
          <MonthJumper sel={sel} onChange={setPeriod} />
        </div>
      }
      tabs={<Tabs items={TAB_ITEMS} active={tab} onChange={setTab} ariaLabel="Dashboard sections" />}
    >
      {showNudge && (
        <div className="guide-nudge">
          <span>New to GoServe? Take a quick tour of your dashboard.</span>
          <div className="guide-nudge__actions">
            <button
              type="button"
              className="btn small primary"
              onClick={() => {
                dismissNudge();
                startTour('dashboard');
              }}
            >
              Start tour
            </button>
            <button type="button" className="btn small ghost" onClick={dismissNudge}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {tab === 'overview' && <OverviewTab range={range} custom={custom} />}
      {tab === 'sales' && <SalesTab range={range} custom={custom} />}
      {tab === 'hourly' && <HourlyTab />}
      {tab === 'operations' && <OperationsTab range={range} custom={custom} />}
    </PageShell>
  );
}

// -------------------------------------------------------------------------
// MonthJumper — sits next to the preset chips. Steps months with ◀ ▶ when a
// month is active, and a ▾ dropdown picks any recent month or a custom range.
// -------------------------------------------------------------------------

function MonthJumper({ sel, onChange }: { sel: PeriodSel; onChange: (s: PeriodSel) => void }) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(sel.kind === 'custom');
  const [cFrom, setCFrom] = useState(sel.kind === 'custom' ? sel.from : '');
  const [cTo, setCTo] = useState(sel.kind === 'custom' ? sel.to : '');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const months = useMemo(() => recentMonths(12), []);
  const curYm = currentYm();
  const isMonth = sel.kind === 'month';
  const atCurrent = isMonth && sel.month >= curYm;

  const label =
    sel.kind === 'month'
      ? monthLabel(sel.month)
      : sel.kind === 'custom'
        ? `${sel.from} → ${sel.to}`
        : 'Other';

  return (
    <div className="month-jumper" ref={wrapRef}>
      {isMonth && (
        <button
          type="button"
          className="btn icon"
          aria-label="Previous month"
          onClick={() => onChange({ kind: 'month', month: shiftYm((sel as { month: string }).month, -1) })}
        >
          <ChevronLeft size={14} strokeWidth={1.6} />
        </button>
      )}
      <button
        type="button"
        className={`btn month-jumper-trigger ${sel.kind !== 'preset' ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <ChevronDown size={12} strokeWidth={1.8} />
      </button>
      {isMonth && (
        <button
          type="button"
          className="btn icon"
          aria-label="Next month"
          disabled={atCurrent}
          onClick={() => onChange({ kind: 'month', month: shiftYm((sel as { month: string }).month, 1) })}
        >
          <ChevronRight size={14} strokeWidth={1.6} />
        </button>
      )}
      {open && (
        <div className="month-jumper-pop" role="dialog">
          {!customMode ? (
            <>
              <div className="mj-months">
                {months.map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={`chip ${isMonth && (sel as { month: string }).month === m ? 'active' : ''}`}
                    onClick={() => {
                      onChange({ kind: 'month', month: m });
                      setOpen(false);
                    }}
                  >
                    {monthLabel(m)}
                  </button>
                ))}
              </div>
              <button type="button" className="mj-custom-link" onClick={() => setCustomMode(true)}>
                Custom range…
              </button>
            </>
          ) : (
            <div className="mj-custom">
              <label className="prc-field">
                <span>From</span>
                <DatePicker value={cFrom} onChange={setCFrom} max={cTo || todayIso()} />
              </label>
              <label className="prc-field">
                <span>To</span>
                <DatePicker value={cTo} onChange={setCTo} min={cFrom || undefined} max={todayIso()} />
              </label>
              <div className="mj-custom-actions">
                <button type="button" className="btn" onClick={() => setCustomMode(false)}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!cFrom || !cTo}
                  onClick={() => {
                    if (cFrom && cTo) {
                      onChange({ kind: 'custom', from: cFrom, to: cTo });
                      setOpen(false);
                    }
                  }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Overview tab — at-a-glance health. Numbers + trend + alerts; no deep
// analytics. Three data sources: the dashboard report (KPIs + sparkline +
// top sellers), the cafe balance, and the inventory list for the low-stock
// alert. Cheap first paint.
// -------------------------------------------------------------------------

function OverviewTab({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const dash = useReportsDashboard(range, custom);
  const balance = useCafeBalance();
  const inv = useInventoryItems();
  const tenant = useTenantSettings();

  const [dailyView, setDailyView] = useState<'chart' | 'list'>('chart');

  const k = dash.data?.kpis;
  const daily = dash.data?.daily ?? [];
  const maxBar = useMemo(
    () => daily.reduce((m, d) => Math.max(m, d.sales_cents), 0),
    [daily],
  );
  // Average daily sales across the days shown (drives the reference line + caption).
  const avgBar = useMemo(
    () => (daily.length ? Math.round(daily.reduce((s, d) => s + d.sales_cents, 0) / daily.length) : 0),
    [daily],
  );
  const avgPct = maxBar > 0 ? (avgBar / maxBar) * 100 : 0;
  const todayKey = new Date().toISOString().slice(0, 10);
  const lowStock = (inv.data ?? []).filter((i) => i.is_low_stock).length;

  if (dash.isPending) return <LoadingState />;
  if (dash.isError && !dash.data) return <ErrorState onRetry={() => dash.refetch()} />;

  return (
    <>
      <div className="kpis" data-tour="dash-kpis">
        <Kpi
          label="Cafe balance"
          cents={balance.data?.total_cents ?? 0}
          hintTopic="cafe-balance"
          subtext={
            balance.data
              ? `drawer ${formatNPR(balance.data.drawer_cents)} · online ${formatNPR(
                  (balance.data.channels ?? []).reduce((s, c) => s + c.balance_cents, 0),
                )} · bank ${formatNPR(balance.data.bank_cents)}${
                  // Owner-held cash is part of the total — show it whenever an
                  // owner is holding any, so the parts always sum to the total.
                  balance.data.owner_cash_cents
                    ? ` · owner cash ${formatNPR(balance.data.owner_cash_cents)}`
                    : ''
                }`
              : ''
          }
        />
        <SalesKpi
          salesCents={k?.sales_cents ?? 0}
          tabCents={k?.tab_cents ?? 0}
          paymentMix={dash.data?.payment_mix}
          tabBreakdown={dash.data?.tab_breakdown ?? []}
        />
        <Kpi label="Orders" raw={k?.order_count ?? 0} hintTopic="orders" />
        <Kpi
          label="Net (sales − expenses)"
          cents={k?.net_cents ?? 0}
          sign
          hintTopic="net"
          subtext={`Expenses ${formatNPR(k?.expenses_cents ?? 0)}`}
        />
      </div>

      <section className="panel" style={{ marginTop: 16 }} data-tour="dash-daily">
        <div className="panel-head">
          <h3>
            Daily sales
            <InfoHint topic="daily-sales" />
          </h3>
          <div className="daily-head-right">
            <span className="meta">avg {formatNPR(avgBar)}/day</span>
            <div className="seg" role="tablist" aria-label="Daily sales view">
              <button
                type="button"
                role="tab"
                aria-selected={dailyView === 'chart'}
                className={`seg-btn ${dailyView === 'chart' ? 'active' : ''}`}
                onClick={() => setDailyView('chart')}
                aria-label="Chart view"
                title="Chart"
              >
                <BarChart3 size={13} strokeWidth={1.6} />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dailyView === 'list'}
                className={`seg-btn ${dailyView === 'list' ? 'active' : ''}`}
                onClick={() => setDailyView('list')}
                aria-label="List view"
                title="List"
              >
                <List size={13} strokeWidth={1.6} />
              </button>
            </div>
          </div>
        </div>

        {daily.length === 0 && <div className="empty-state">No data.</div>}

        {daily.length > 0 && dailyView === 'chart' && (
          <>
            <div className="chart">
              {avgBar > 0 && (
                <div
                  className="chart-avg"
                  style={{ bottom: `${avgPct}%` }}
                  title={`avg ${formatNPR(avgBar)}/day`}
                  aria-hidden
                />
              )}
              {daily.map((d) => {
                const h = maxBar > 0 ? Math.max(2, (d.sales_cents / maxBar) * 100) : 2;
                const isToday = d.day === todayKey;
                return (
                  <Link
                    key={d.day}
                    to={`/admin/history?date=${d.day}`}
                    className={`bar${isToday ? ' alt' : ''}`}
                    style={{ height: `${h}%` }}
                    title={`${d.day} · ${formatNPR(d.sales_cents)} — view history`}
                    aria-label={`View order history for ${d.day}`}
                  />
                );
              })}
            </div>
            <div className="chart-x">
              {daily.map((d) => (
                <Link key={d.day} to={`/admin/history?date=${d.day}`} title={`View order history for ${d.day}`}>
                  {d.day.slice(5)}
                </Link>
              ))}
            </div>
          </>
        )}

        {daily.length > 0 && dailyView === 'list' && (
          <div className="daily-list">
            {[...daily].reverse().map((d) => (
              <Link
                key={d.day}
                to={`/admin/history?date=${d.day}`}
                className={`daily-row${d.day === todayKey ? ' alt' : ''}`}
                title={`View order history for ${d.day}`}
              >
                <span className="dl-day">
                  {new Date(d.day).toLocaleDateString('en-GB', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                  })}
                </span>
                <span className="dl-amt">{formatNPR(d.sales_cents)}</span>
              </Link>
            ))}
            <div className="daily-row total">
              <span className="dl-day">Average / day</span>
              <span className="dl-amt">{formatNPR(avgBar)}</span>
            </div>
          </div>
        )}
      </section>

      <div className="row-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>
              Top sellers
              <InfoHint topic="top-sellers" />
            </h3>
            <span className="meta">{range}</span>
          </div>
          {(dash.data?.top_sellers ?? []).length === 0 && (
            <EmptyState
              compact
              icon={<Coffee size={32} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
              title="Quiet so far"
              hint="No sales in this window — check back after first orders close."
            />
          )}
          {dash.data?.top_sellers.map((s, i) => (
            <div key={s.menu_item_id} className="exp">
              <div className="left">
                <span className="name">
                  {i + 1}. {s.name}
                </span>
                <span className="meta">
                  {s.category_name ?? '—'} · {s.qty} sold
                </span>
              </div>
              <span className="amt">{formatNPR(s.revenue_cents)}</span>
            </div>
          ))}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Setup &amp; alerts</h3>
            <span className="meta">Live</span>
          </div>
          <div className="exp">
            <div className="left">
              <span className="name">Low-stock items</span>
              <span className="meta">Reorder before service</span>
            </div>
            <span className={`pill ${lowStock > 0 ? 'warn' : 'ok'}`}>
              {lowStock > 0 ? `${lowStock} Low` : 'All stocked'}
            </span>
          </div>
          {(() => {
            // Under 'none' VAT, drop all VAT wording: show only a service-charge
            // figure (and only if there is one), otherwise omit the card entirely.
            const vatNone = tenant.data?.vat_mode === 'none';
            const tax = k?.tax_cents ?? 0;
            const svc = k?.service_cents ?? 0;
            if (vatNone && svc <= 0) return null;
            return (
              <div className="exp">
                <div className="left">
                  <span className="name">{vatNone ? 'Service charge' : 'Tax collected'}</span>
                  <span className="meta">
                    {vatNone ? 'Collected in window' : 'VAT + service charge in window'}
                  </span>
                </div>
                <span className="amt">{formatNPR(vatNone ? svc : tax + svc)}</span>
              </div>
            );
          })()}
          <div className="exp">
            <div className="left">
              <span className="name">Discounts applied</span>
              <span className="meta">Total deducted on closed orders</span>
            </div>
            <span
              className="amt"
              style={{ color: (k?.discount_cents ?? 0) > 0 ? 'var(--amber-fg)' : undefined }}
            >
              {formatNPR(k?.discount_cents ?? 0)}
            </span>
          </div>
          <div className="exp">
            <div className="left">
              <span className="name">Voided items</span>
              <span className="meta">Audit log records each one</span>
            </div>
            <span className={`pill ${(k?.void_count ?? 0) > 0 ? 'warn' : 'ok'}`}>
              {k?.void_count ?? 0}
            </span>
          </div>
          <div className="exp">
            <div className="left">
              <span className="name">Inventory items</span>
              <span className="meta">Tracked in stock</span>
            </div>
            <span className="amt">{inv.data?.length ?? 0}</span>
          </div>
          {(balance.data?.owner_outstanding.loans_cents ?? 0) > 0 && (
            <div className="exp">
              <div className="left">
                <span className="name">Outstanding owner loans</span>
                <span className="meta">Owner-paid expenses awaiting reimbursement</span>
              </div>
              <span className="amt" style={{ color: 'var(--amber-fg)' }}>
                {formatNPR(balance.data?.owner_outstanding.loans_cents ?? 0)}
              </span>
            </div>
          )}
        </section>
      </div>

      <Link to="/admin/sitemap" className="sitemap-jump" style={{ marginTop: 16 }}>
        <Compass size={15} strokeWidth={1.6} />
        <span>Explore all sections</span>
        <ArrowRight size={14} strokeWidth={1.6} className="sitemap-jump-arrow" />
      </Link>
    </>
  );
}

// -------------------------------------------------------------------------
// Sales tab — what's selling, when, how fast. Lazy panels each own their
// own /v1/reports/* call.
// -------------------------------------------------------------------------

function SalesTab({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  // Every panel here is backed by an advanced-analytics endpoint, so gate the
  // whole tab behind the premium feature with one upgrade prompt.
  return (
    <FeatureGate feature="advanced_analytics" fallback={<div style={{ marginTop: 16 }}><UpgradePrompt feature="advanced_analytics" /></div>}>
      <div className="row-2" style={{ marginTop: 16 }}>
        <TopMoversPanel range={range} custom={custom} />
        <CategoryMixPanel range={range} custom={custom} />
      </div>
      <div className="row-2" style={{ marginTop: 16 }}>
        <HeatmapPanel range={range} custom={custom} />
        <VelocityPanel range={range} custom={custom} />
      </div>
    </FeatureGate>
  );
}

// -------------------------------------------------------------------------
// Operations tab — table mix + recent expenses. Where cash is going +
// where covers are sat.
// -------------------------------------------------------------------------

function OperationsTab({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const expenses = useExpenses();
  const recent = (expenses.data ?? []).slice(0, 8);

  return (
    <>
      <FeatureGate feature="advanced_analytics" fallback={<div style={{ marginTop: 16 }}><UpgradePrompt feature="advanced_analytics" compact /></div>}>
        <div className="row-1" style={{ marginTop: 16 }}>
          <TableMixPanel range={range} custom={custom} />
        </div>
      </FeatureGate>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Recent expenses</h3>
          <Link
            to="/admin/expenses"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.12em',
              color: 'var(--ink-300)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            All <ArrowRight size={10} strokeWidth={1.5} />
          </Link>
        </div>
        {expenses.isPending && <LoadingState compact />}
        {expenses.isError && !expenses.data && <ErrorState compact onRetry={() => expenses.refetch()} />}
        {expenses.data && recent.length === 0 && (
          <EmptyState
            compact
            icon={<Receipt size={32} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
            title="No expenses logged"
            hint={<>Track every restock and overhead from <strong>Admin · Expenses</strong>.</>}
          />
        )}
        {recent.map((e) => (
          <div key={e.id} className="exp">
            <div className="left">
              <span className="name">{e.vendor || '(no vendor)'}</span>
              <span className="meta">
                {e.expense_category_name ?? 'Uncategorised'} ·{' '}
                {e.payment_method.charAt(0).toUpperCase() + e.payment_method.slice(1)}
                {e.linked_inventory_name && <> · Stock</>}
              </span>
            </div>
            <span className="date">
              {new Date(e.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            </span>
            <span className="amt">{formatNPR(e.amount_cents)}</span>
          </div>
        ))}
      </section>
    </>
  );
}

// -------------------------------------------------------------------------

function Kpi({
  label,
  cents,
  raw,
  sign,
  subtext,
  hintTopic,
}: {
  label: string;
  cents?: number;
  raw?: number;
  sign?: boolean;
  subtext?: string;
  hintTopic?: string;
}) {
  const value = raw != null ? raw.toString() : formatNPR(cents ?? 0);
  const positive = (cents ?? raw ?? 0) >= 0;
  return (
    <div className="kpi">
      <div className="label">
        {label}
        {hintTopic && <InfoHint topic={hintTopic} />}
      </div>
      <div
        className="value"
        style={sign ? { color: positive ? 'var(--lime-fg)' : 'var(--danger-fg)' } : undefined}
      >
        {sign &&
          (positive ? (
            <TrendingUp size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />
          ) : (
            <TrendingDown size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />
          ))}
        {value}
      </div>
      {subtext && <div className="delta">{subtext}</div>}
    </div>
  );
}

// -------------------------------------------------------------------------
// Sales KPI — same card as the others, but the number drills into a full
// breakdown: collected split by channel (cash/online/bank) and who's on tab.
// Opens a portal modal so it never disrupts the KPI grid and works the same
// on phone and desktop.
// -------------------------------------------------------------------------

function SalesKpi({
  salesCents,
  tabCents,
  paymentMix,
  tabBreakdown,
}: {
  salesCents: number;
  tabCents: number;
  paymentMix?: PaymentMix;
  tabBreakdown: TabBreakdownRow[];
}) {
  const [open, setOpen] = useState(false);
  const collected = salesCents - tabCents;
  const canDrill = salesCents > 0;

  // The InfoHint is itself a <button>, so the drill trigger must be a sibling
  // (not a wrapping button) to keep the markup valid.
  return (
    <div className={`kpi${canDrill ? ' kpi--drillable' : ''}`}>
      <div className="label">
        Sales
        <InfoHint topic="sales" />
      </div>
      <div className="value">{formatNPR(salesCents)}</div>
      {tabCents > 0 && (
        <div className="delta">
          {formatNPR(tabCents)} on tab · {formatNPR(collected)} collected
        </div>
      )}
      {canDrill && (
        <button
          type="button"
          className="kpi-drill"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Breakdown <ChevronDown size={11} strokeWidth={1.7} />
        </button>
      )}
      {canDrill && (
        <Modal
          open={open}
          title="Sales breakdown"
          subtitle={`${formatNPR(salesCents)} total`}
          onClose={() => setOpen(false)}
        >
          <SalesBreakdownBody
            collected={collected}
            tabCents={tabCents}
            paymentMix={paymentMix}
            tabBreakdown={tabBreakdown}
          />
        </Modal>
      )}
    </div>
  );
}

function SalesBreakdownBody({
  collected,
  tabCents,
  paymentMix,
  tabBreakdown,
}: {
  collected: number;
  tabCents: number;
  paymentMix?: PaymentMix;
  tabBreakdown: TabBreakdownRow[];
}) {
  const mix = paymentMix ?? { cash_cents: 0, bank_cents: 0, online_cents: 0 };
  return (
    <div className="drill">
      <div className="drill-section">
        <div className="drill-section-head">
          <span>Collected (in hand)</span>
          <span className="drill-section-total">{formatNPR(collected)}</span>
        </div>
        <DrillRow icon={<Wallet size={14} strokeWidth={1.6} />} label="Cash" cents={mix.cash_cents} />
        <DrillRow icon={<Globe size={14} strokeWidth={1.6} />} label="Online" cents={mix.online_cents} />
        <DrillRow icon={<Banknote size={14} strokeWidth={1.6} />} label="Bank" cents={mix.bank_cents} />
      </div>

      {tabCents > 0 && (
        <div className="drill-section">
          <div className="drill-section-head">
            <span>On tab (owed, not in hand)</span>
            <span className="drill-section-total">{formatNPR(tabCents)}</span>
          </div>
          {tabBreakdown.length === 0 ? (
            <div className="drill-empty">Charged to house tabs.</div>
          ) : (
            tabBreakdown.map((t) => (
              <DrillRow
                key={t.house_tab_id}
                icon={<Users size={14} strokeWidth={1.6} />}
                label={t.name}
                cents={t.amount_cents}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function DrillRow({ icon, label, cents }: { icon: React.ReactNode; label: string; cents: number }) {
  return (
    <div className="drill-row">
      <span className="drill-row-label">
        <span className="drill-row-icon">{icon}</span>
        {label}
      </span>
      <span className="drill-row-amt">{formatNPR(cents)}</span>
    </div>
  );
}

// -------------------------------------------------------------------------
// Hourly tab — orders/sales bucketed by hour for one day (defaults to today).
// A "last completed hour" (or, for a past day, "busiest hour") summary card
// sits above a per-hour bar chart. Configurable: day stepper + orders|sales
// metric toggle. Reuses the daily-sales chart styling.
// -------------------------------------------------------------------------

// 0..23 → compact 12h label, e.g. 0→"12a", 13→"1p".
function hourLabel(h: number): string {
  const period = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${period}`;
}
// "2–3 PM" style range for the summary card.
function hourRangeLabel(h: number): string {
  const fmt = (x: number) => {
    const p = x < 12 ? 'AM' : 'PM';
    const h12 = x % 12 === 0 ? 12 : x % 12;
    return `${h12} ${p}`;
  };
  return `${fmt(h)}–${fmt((h + 1) % 24)}`;
}

function HourlyTab() {
  const [date, setDate] = useState(() => todayIso());
  const [metric, setMetric] = useState<'orders' | 'sales'>('orders');
  const hourly = useHourly(date);

  const today = todayIso();
  const isToday = date === today;
  const atToday = date >= today;

  const hours = hourly.data?.hours ?? [];
  const val = (h: { order_count: number; revenue_cents: number }) =>
    metric === 'orders' ? h.order_count : h.revenue_cents;
  const maxVal = useMemo(() => hours.reduce((m, h) => Math.max(m, val(h)), 0), [hours, metric]);

  // Current local hour drives the highlight + last-hour summary (only meaningful
  // when viewing today).
  const nowHour = new Date().getHours();
  const lastCompleted = nowHour - 1; // -1 before 1 AM → no completed hour yet

  // Summary card: last completed hour today, else the busiest hour of the day.
  const summary = useMemo(() => {
    if (hours.length !== 24) return null;
    if (isToday) {
      if (lastCompleted < 0) {
        const bucket = hours[nowHour];
        return bucket ? { kind: 'live' as const, hour: nowHour, bucket } : null;
      }
      const bucket = hours[lastCompleted];
      return bucket ? { kind: 'last' as const, hour: lastCompleted, bucket } : null;
    }
    let peak = 0;
    for (let i = 1; i < 24; i++) {
      if ((hours[i]?.order_count ?? 0) > (hours[peak]?.order_count ?? 0)) peak = i;
    }
    const bucket = hours[peak];
    return bucket ? { kind: 'peak' as const, hour: peak, bucket } : null;
  }, [hours, isToday, lastCompleted, nowHour]);

  const dayLabel = isToday
    ? 'Today'
    : date === addDaysIso(today, -1)
      ? 'Yesterday'
      : new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });

  return (
    <>
      <div className="hourly-controls" style={{ marginTop: 16 }}>
        <div className="day-stepper">
          <button
            type="button"
            className="btn icon"
            aria-label="Previous day"
            onClick={() => setDate((d) => addDaysIso(d, -1))}
          >
            <ChevronLeft size={15} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={`btn day-stepper-label ${!isToday ? 'active' : ''}`}
            onClick={() => setDate(today)}
            title="Jump to today"
          >
            {dayLabel}
          </button>
          <button
            type="button"
            className="btn icon"
            aria-label="Next day"
            disabled={atToday}
            onClick={() => setDate((d) => addDaysIso(d, 1))}
          >
            <ChevronRight size={15} strokeWidth={1.6} />
          </button>
        </div>
        <div className="seg" role="tablist" aria-label="Hourly metric">
          <button
            type="button"
            role="tab"
            aria-selected={metric === 'orders'}
            className={`seg-btn ${metric === 'orders' ? 'active' : ''}`}
            onClick={() => setMetric('orders')}
          >
            Orders
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={metric === 'sales'}
            className={`seg-btn ${metric === 'sales' ? 'active' : ''}`}
            onClick={() => setMetric('sales')}
          >
            Sales
          </button>
        </div>
      </div>

      {hourly.isPending && <LoadingState />}
      {hourly.isError && !hourly.data && <ErrorState onRetry={() => hourly.refetch()} />}

      {hourly.data && (
        <>
          {summary && (
            <section className="panel hourly-summary" style={{ marginTop: 16 }}>
              <div className="hourly-summary-eyebrow">
                {summary.kind === 'last'
                  ? `Last hour · ${hourRangeLabel(summary.hour)}`
                  : summary.kind === 'live'
                    ? `This hour (so far) · ${hourRangeLabel(summary.hour)}`
                    : `Busiest hour · ${hourRangeLabel(summary.hour)}`}
              </div>
              <div className="hourly-summary-stats">
                <div className="hourly-summary-stat">
                  <span className="num">{summary.bucket.order_count}</span>
                  <span className="lbl">{summary.bucket.order_count === 1 ? 'order' : 'orders'}</span>
                </div>
                <div className="hourly-summary-stat">
                  <span className="num">{formatNPR(summary.bucket.revenue_cents)}</span>
                  <span className="lbl">sales</span>
                </div>
              </div>
            </section>
          )}

          <section className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head">
              <h3>
                Orders by hour
                <InfoHint>
                  Each bar is one hour of {dayLabel.toLowerCase()}, by when orders were settled. Toggle
                  Orders / Sales above. Use the arrows to step days.
                </InfoHint>
              </h3>
              <span className="meta">{dayLabel}</span>
            </div>

            {maxVal === 0 ? (
              <EmptyState
                compact
                icon={<Clock size={32} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
                title="No orders this day"
                hint="Pick another day with the arrows above, or check back after the first orders close."
              />
            ) : (
              <>
                <div className="chart">
                  {hours.map((h) => {
                    const v = val(h);
                    const height = maxVal > 0 ? Math.max(2, (v / maxVal) * 100) : 2;
                    const isNow = isToday && h.hour === nowHour;
                    return (
                      <div
                        key={h.hour}
                        className={`bar${isNow ? ' alt' : ''}`}
                        style={{ height: `${height}%` }}
                        title={`${hourRangeLabel(h.hour)} · ${h.order_count} ${
                          h.order_count === 1 ? 'order' : 'orders'
                        } · ${formatNPR(h.revenue_cents)}`}
                      />
                    );
                  })}
                </div>
                <div className="chart-x">
                  {hours.map((h) => (
                    <span key={h.hour}>{h.hour % 3 === 0 ? hourLabel(h.hour) : ''}</span>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
