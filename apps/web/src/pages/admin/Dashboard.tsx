import { useMemo } from 'react';
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
} from 'lucide-react';

import {
  useReportsDashboard,
  useExpenses,
  useInventoryItems,
  useMe,
  useTenantSettings,
  useCafeBalance,
  type DashboardRange,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { formatNPR } from '@/components/Money';
import { Greeting } from '@/components/Greeting';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
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

type TabKey = 'overview' | 'sales' | 'operations';

const TAB_ITEMS: TabItem<TabKey>[] = [
  { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={12} strokeWidth={1.6} /> },
  { key: 'sales', label: 'Sales', icon: <Activity size={12} strokeWidth={1.6} /> },
  { key: 'operations', label: 'Operations', icon: <Receipt size={12} strokeWidth={1.6} /> },
];

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const range = (params.get('range') as DashboardRange) || 'today';
  const tabParam = params.get('tab');
  const tab: TabKey = TAB_ITEMS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview';

  const me = useMe();
  const tenant = useTenantSettings();
  const { slug } = useTenant();

  const branding = tenant.data?.branding;
  const cafeName =
    branding?.cafeName ??
    tenant.data?.name ??
    me.data?.memberships.find((m) => m.tenant_slug === slug)?.tenant_name ??
    'your cafe';
  const firstName = me.data?.name?.split(' ')[0];

  const setRange = (v: DashboardRange) => {
    const next = new URLSearchParams(params);
    next.set('range', v);
    setParams(next, { replace: true });
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
        <div className="filter-row" style={{ marginBottom: 0 }}>
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.value}
              className={`chip ${range === r.value ? 'active' : ''}`}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
      tabs={<Tabs items={TAB_ITEMS} active={tab} onChange={setTab} ariaLabel="Dashboard sections" />}
    >
      <Greeting
        cafeName={cafeName}
        firstName={firstName}
        tagline={branding?.tagline}
        emoji={branding?.accentEmoji}
      />
      {tab === 'overview' && <OverviewTab range={range} />}
      {tab === 'sales' && <SalesTab range={range} />}
      {tab === 'operations' && <OperationsTab range={range} />}
    </PageShell>
  );
}

// -------------------------------------------------------------------------
// Overview tab — at-a-glance health. Numbers + trend + alerts; no deep
// analytics. Three data sources: the dashboard report (KPIs + sparkline +
// top sellers), the cafe balance, and the inventory list for the low-stock
// alert. Cheap first paint.
// -------------------------------------------------------------------------

function OverviewTab({ range }: { range: DashboardRange }) {
  const dash = useReportsDashboard(range);
  const balance = useCafeBalance();
  const inv = useInventoryItems();

  const k = dash.data?.kpis;
  const daily = dash.data?.daily ?? [];
  const maxBar = useMemo(
    () => daily.reduce((m, d) => Math.max(m, d.sales_cents), 0),
    [daily],
  );
  const todayKey = new Date().toISOString().slice(0, 10);
  const lowStock = (inv.data ?? []).filter((i) => i.is_low_stock).length;

  if (dash.isPending) return <LoadingState />;
  if (dash.isError) return <ErrorState onRetry={() => dash.refetch()} />;

  return (
    <>
      <div className="kpis">
        <Kpi
          label="Cafe balance"
          cents={balance.data?.total_cents ?? 0}
          subtext={
            balance.data
              ? `drawer ${formatNPR(balance.data.drawer_cents)} · online ${formatNPR(
                  (balance.data.channels ?? []).reduce((s, c) => s + c.balance_cents, 0),
                )} · bank ${formatNPR(balance.data.bank_cents)}`
              : ''
          }
        />
        <Kpi
          label="Sales"
          cents={k?.sales_cents ?? 0}
          subtext={
            (k?.tab_cents ?? 0) > 0
              ? `${formatNPR(k!.tab_cents)} on tab (not in hand) · ${formatNPR(
                  (k?.sales_cents ?? 0) - (k?.tab_cents ?? 0),
                )} collected`
              : undefined
          }
        />
        <Kpi label="Orders" raw={k?.order_count ?? 0} />
        <Kpi
          label="Net (sales − expenses)"
          cents={k?.net_cents ?? 0}
          sign
          subtext={`Expenses ${formatNPR(k?.expenses_cents ?? 0)}`}
        />
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Daily sales</h3>
          <span className="meta">Last 14 days</span>
        </div>
        <div className="chart">
          {daily.length === 0 && <div className="empty-state">No data.</div>}
          {daily.map((d) => {
            const h = maxBar > 0 ? Math.max(2, (d.sales_cents / maxBar) * 100) : 2;
            const isToday = d.day === todayKey;
            return (
              <div
                key={d.day}
                className={`bar${isToday ? ' alt' : ''}`}
                style={{ height: `${h}%` }}
                title={`${d.day} · ${formatNPR(d.sales_cents)}`}
              />
            );
          })}
        </div>
        <div className="chart-x">
          {daily.map((d) => (
            <span key={d.day}>{d.day.slice(5)}</span>
          ))}
        </div>
      </section>

      <div className="row-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Top sellers</h3>
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
          <div className="exp">
            <div className="left">
              <span className="name">Tax collected</span>
              <span className="meta">VAT + service charge in window</span>
            </div>
            <span className="amt">{formatNPR((k?.tax_cents ?? 0) + (k?.service_cents ?? 0))}</span>
          </div>
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

function SalesTab({ range }: { range: DashboardRange }) {
  // Every panel here is backed by an advanced-analytics endpoint, so gate the
  // whole tab behind the premium feature with one upgrade prompt.
  return (
    <FeatureGate feature="advanced_analytics" fallback={<div style={{ marginTop: 16 }}><UpgradePrompt feature="advanced_analytics" /></div>}>
      <div className="row-2" style={{ marginTop: 16 }}>
        <TopMoversPanel range={range} />
        <CategoryMixPanel range={range} />
      </div>
      <div className="row-2" style={{ marginTop: 16 }}>
        <HeatmapPanel range={range} />
        <VelocityPanel range={range} />
      </div>
    </FeatureGate>
  );
}

// -------------------------------------------------------------------------
// Operations tab — table mix + recent expenses. Where cash is going +
// where covers are sat.
// -------------------------------------------------------------------------

function OperationsTab({ range }: { range: DashboardRange }) {
  const expenses = useExpenses();
  const recent = (expenses.data ?? []).slice(0, 8);

  return (
    <>
      <FeatureGate feature="advanced_analytics" fallback={<div style={{ marginTop: 16 }}><UpgradePrompt feature="advanced_analytics" compact /></div>}>
        <div className="row-1" style={{ marginTop: 16 }}>
          <TableMixPanel range={range} />
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
        {expenses.isError && <ErrorState compact onRetry={() => expenses.refetch()} />}
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
}: {
  label: string;
  cents?: number;
  raw?: number;
  sign?: boolean;
  subtext?: string;
}) {
  const value = raw != null ? raw.toString() : formatNPR(cents ?? 0);
  const positive = (cents ?? raw ?? 0) >= 0;
  return (
    <div className="kpi">
      <div className="label">{label}</div>
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
