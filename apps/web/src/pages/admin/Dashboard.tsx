import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, ArrowRight, Coffee, Receipt } from 'lucide-react';

import {
  useReportsDashboard,
  useExpenses,
  useInventoryItems,
  useMe,
  useTenantSettings,
  type DashboardRange,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { formatNPR } from '@/components/Money';
import { Greeting } from '@/components/Greeting';
import { EmptyState } from '@/components/EmptyState';

const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 'today', label: 'today' },
  { value: 'yesterday', label: 'yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'mtd', label: 'this month' },
];

export function Dashboard() {
  const [range, setRange] = useState<DashboardRange>('today');
  const dash = useReportsDashboard(range);
  const expenses = useExpenses();
  const inv = useInventoryItems();
  const me = useMe();
  const tenant = useTenantSettings();
  const { slug } = useTenant();

  const lowStock = (inv.data ?? []).filter((i) => i.is_low_stock).length;
  const recentExpenses = (expenses.data ?? []).slice(0, 5);

  const k = dash.data?.kpis;
  const daily = dash.data?.daily ?? [];
  const maxBar = daily.reduce((m, d) => Math.max(m, d.sales_cents), 0);
  const todayKey = new Date().toISOString().slice(0, 10);

  const branding = tenant.data?.branding;
  const cafeName =
    branding?.cafeName ??
    tenant.data?.name ??
    me.data?.memberships.find((m) => m.tenant_slug === slug)?.tenant_name ??
    'your cafe';
  const firstName = me.data?.name?.split(' ')[0];

  return (
    <>
      <Greeting
        cafeName={cafeName}
        firstName={firstName}
        tagline={branding?.tagline}
        emoji={branding?.accentEmoji}
      />
      <div className="topbar">
        <div>
          <span className="eyebrow">
            {dash.data ? new Date(dash.data.from).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) : 'loading…'}
            {' · '} {dash.data?.timezone}
          </span>
          <h1>Dashboard</h1>
        </div>
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
      </div>

      <div className="kpis">
        <Kpi label="Sales" cents={k?.sales_cents ?? 0} />
        <Kpi label="Orders" raw={k?.order_count ?? 0} />
        <Kpi label="Avg ticket" cents={k?.avg_ticket_cents ?? 0} />
        <Kpi
          label="Net (sales − expenses)"
          cents={k?.net_cents ?? 0}
          sign
          subtext={`Expenses ${formatNPR(k?.expenses_cents ?? 0)}`}
        />
      </div>

      <div className="row-2">
        <section className="panel">
          <div className="panel-head">
            <h3>Daily sales</h3>
            <span className="meta">last 14 days</span>
          </div>
          <div className="chart">
            {daily.length === 0 && <div className="empty-state">no data.</div>}
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

        <section className="panel">
          <div className="panel-head">
            <h3>Top sellers</h3>
            <span className="meta">{range}</span>
          </div>
          {(dash.data?.top_sellers ?? []).length === 0 && (
            <EmptyState
              compact
              icon={<Coffee size={32} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
              title="quiet so far"
              hint="no sales in this window — check back after first orders close."
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
      </div>

      <div className="row-2" style={{ marginTop: 16 }}>
        <section className="panel">
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
              all <ArrowRight size={10} strokeWidth={1.5} />
            </Link>
          </div>
          {recentExpenses.length === 0 && (
            <EmptyState
              compact
              icon={<Receipt size={32} strokeWidth={1.5} style={{ color: 'var(--amber-fg)' }} />}
              title="no expenses logged"
              hint={<>track every restock and overhead from <strong>admin · expenses</strong>.</>}
            />
          )}
          {recentExpenses.map((e) => (
            <div key={e.id} className="exp">
              <div className="left">
                <span className="name">{e.vendor || '(no vendor)'}</span>
                <span className="meta">
                  {e.expense_category_name ?? 'uncategorised'} · {e.payment_method}
                  {e.linked_inventory_name && <> · stock</>}
                </span>
              </div>
              <span className="date">
                {new Date(e.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              </span>
              <span className="amt">{formatNPR(e.amount_cents)}</span>
            </div>
          ))}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Setup &amp; alerts</h3>
            <span className="meta">live</span>
          </div>
          <div className="exp">
            <div className="left">
              <span className="name">Low-stock items</span>
              <span className="meta">reorder before service</span>
            </div>
            <span className={`pill ${lowStock > 0 ? 'warn' : 'ok'}`}>
              {lowStock > 0 ? `${lowStock} low` : 'all stocked'}
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
              <span className="meta">total deducted on closed orders</span>
            </div>
            <span className="amt" style={{ color: (k?.discount_cents ?? 0) > 0 ? 'var(--amber-fg)' : undefined }}>
              {formatNPR(k?.discount_cents ?? 0)}
            </span>
          </div>
          <div className="exp">
            <div className="left">
              <span className="name">Voided items</span>
              <span className="meta">audit log records each one</span>
            </div>
            <span className={`pill ${(k?.void_count ?? 0) > 0 ? 'warn' : 'ok'}`}>
              {k?.void_count ?? 0}
            </span>
          </div>
          <div className="exp">
            <div className="left">
              <span className="name">Inventory items</span>
              <span className="meta">tracked in stock</span>
            </div>
            <span className="amt">{inv.data?.length ?? 0}</span>
          </div>
        </section>
      </div>
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
      <div className="value" style={sign ? { color: positive ? 'var(--lime-fg)' : 'var(--danger-fg)' } : undefined}>
        {sign && (positive ? <TrendingUp size={20} strokeWidth={1.5} style={{ marginRight: 6 }} /> : <TrendingDown size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />)}
        {value}
      </div>
      {subtext && <div className="delta">{subtext}</div>}
    </div>
  );
}
