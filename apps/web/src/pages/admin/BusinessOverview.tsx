import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpRight } from 'lucide-react';
import type { BranchData, BranchStatus, ReportsDashboard } from '@cafe-mgmt/api-types';

import {
  useBusinessCafeBalance,
  useBusinessDashboard,
  type DashboardCustom,
  type DashboardRange,
} from '@/lib/api';
import { branchColor, branchLabel, sharePercents } from '@/lib/branches';
import { useBranchNav, useOverview } from '@/lib/useBranchNav';
import { formatNPR } from '@/components/Money';
import { Kpi } from '@/components/Kpi';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';

/*
 * The all-branches dashboard. Every figure is a branch's OWN dashboard answer
 * (the server runs the branch's report as that branch) added up — so the
 * total here always equals the sum of what each branch shows on its own.
 */

type Props = { range: DashboardRange; custom?: DashboardCustom };

const WHY: Record<BranchStatus['status'], string> = {
  ok: '',
  forbidden: "you can't see its reports",
  plan_upgrade_required: "its plan doesn't include this",
  not_found: 'not found',
  error: "it didn't answer — try again",
};

/** "Showing 2 of 3 branches — Lakeside: you can't see its reports". Never
 *  lets a partial total pass for the whole business. */
function CoverageNote({ statuses }: { statuses: BranchStatus[] }) {
  const missing = statuses.filter((s) => s.status !== 'ok');
  if (missing.length === 0) return null;
  const ok = statuses.length - missing.length;
  return (
    <div className="bo-coverage" role="status">
      <AlertTriangle size={14} strokeWidth={1.6} aria-hidden />
      <span>
        Showing {ok} of {statuses.length} branches.{' '}
        {missing.map((m) => `${m.name || m.slug}: ${WHY[m.status]}`).join(' · ')}
      </span>
    </div>
  );
}

/** Branch colours are assigned over the whole business, not just the branches
 *  that answered, so a branch keeps its colour when another one drops out. */
function useColours() {
  const { branches, business } = useOverview();
  return {
    colour: (slug: string) => branchColor(branches, slug),
    label: (name: string) => branchLabel(name, business?.name),
  };
}

export function BusinessOverviewTab({ range, custom, onCompare }: Props & { onCompare: () => void }) {
  const dash = useBusinessDashboard(range, custom);
  const { branches } = useOverview();
  const canSeeBalance = branches.some((b) => b.can?.finance_read);
  const balance = useBusinessCafeBalance(canSeeBalance);
  const { colour, label } = useColours();

  const rows = dash.data?.per_branch ?? [];
  const sales = rows.map((r) => r.data.kpis.sales_cents);
  const pct = sharePercents(sales);

  if (dash.isPending) return <LoadingState />;
  if (dash.isError && !dash.data) return <ErrorState onRetry={() => dash.refetch()} />;
  const k = dash.data?.totals.kpis;

  return (
    <>
      <CoverageNote statuses={dash.data?.branches ?? []} />
      <div className="kpis">
        {canSeeBalance && (
          <Kpi
            label="Cafe balance"
            cents={balance.data?.totals.total_cents ?? 0}
            hintTopic="cafe-balance"
            subtext={
              balance.data
                ? balance.data.per_branch.map((b) => `${label(b.name)} ${formatNPR(b.data.total_cents)}`).join(' · ')
                : ''
            }
          />
        )}
        <Kpi label="Sales" cents={k?.sales_cents ?? 0} hintTopic="sales" subtext={`Avg ticket ${formatNPR(k?.avg_ticket_cents ?? 0)}`} />
        <Kpi label="Orders" raw={k?.order_count ?? 0} hintTopic="orders" />
        <Kpi
          label="Net (sales − expenses)"
          cents={k?.net_cents ?? 0}
          sign
          hintTopic="net"
          subtext={`Expenses ${formatNPR(k?.expenses_cents ?? 0)}`}
        />
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Sales by branch</h3>
          <button type="button" className="btn ghost small" onClick={onCompare}>
            Compare branches <ArrowUpRight size={13} strokeWidth={1.6} />
          </button>
        </div>
        {(k?.sales_cents ?? 0) === 0 ? (
          <div className="empty-state">No sales in this period yet.</div>
        ) : (
          <>
            <div className="bo-share" role="img" aria-label={rows.map((r, i) => `${label(r.name)} ${pct[i]}%`).join(', ')}>
              {rows.map((r, i) =>
                sales[i]! > 0 ? (
                  <span
                    key={r.slug}
                    className="bo-share__seg"
                    style={{ flexGrow: sales[i], background: colour(r.slug) }}
                    title={`${label(r.name)} · ${formatNPR(sales[i]!)} · ${pct[i]}%`}
                  />
                ) : null,
              )}
            </div>
            <ul className="bo-legend">
              {rows.map((r, i) => (
                <li key={r.slug}>
                  <span className="branch-dot" style={{ background: colour(r.slug) }} aria-hidden />
                  <span className="bo-legend__name">{label(r.name)}</span>
                  <span className="bo-legend__amt">{formatNPR(sales[i]!)}</span>
                  <span className="bo-legend__pct">{pct[i]}%</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <StackedDaily rows={rows} totals={dash.data?.totals} />
      {dash.data?.mixed_timezones && (
        <p className="field-hint" style={{ marginTop: 8 }}>
          Your branches are in different timezones: each day is that branch's own local day.
        </p>
      )}
    </>
  );
}

/** Daily sales, one bar per day, stacked by branch colour. */
function StackedDaily({ rows, totals }: { rows: BranchData<ReportsDashboard>[]; totals?: ReportsDashboard }) {
  const { colour, label } = useColours();
  const days = totals?.daily ?? [];
  const byBranch = useMemo(
    () =>
      rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        byDay: new Map(r.data.daily.map((d) => [d.day, d.sales_cents])),
      })),
    [rows],
  );
  const max = days.reduce((m, d) => Math.max(m, d.sales_cents), 0);

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h3>Daily sales</h3>
        {days.length > 0 && (
          <span className="meta">
            {days[0]!.day.slice(5)} – {days[days.length - 1]!.day.slice(5)}
          </span>
        )}
      </div>
      {days.length === 0 ? (
        <div className="empty-state">No data.</div>
      ) : (
        <>
          <div className="chart">
            {days.map((d) => {
              const h = max > 0 ? Math.max(2, (d.sales_cents / max) * 100) : 2;
              const parts = byBranch
                .map((b) => ({ ...b, cents: b.byDay.get(d.day) ?? 0 }))
                .filter((b) => b.cents > 0);
              return (
                <div
                  key={d.day}
                  className="bar bo-stack"
                  style={{ height: `${h}%` }}
                  title={`${d.day} · ${formatNPR(d.sales_cents)}\n${parts.map((p) => `${label(p.name)} ${formatNPR(p.cents)}`).join('\n')}`}
                >
                  {parts.map((p) => (
                    <span key={p.slug} style={{ flexGrow: p.cents, background: colour(p.slug) }} />
                  ))}
                </div>
              );
            })}
          </div>
          <div className="chart-x">
            {days.map((d, i) => (
              <span key={d.day}>{days.length <= 14 || i % Math.ceil(days.length / 10) === 0 ? d.day.slice(5) : ''}</span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

type SortKey = 'name' | 'sales' | 'orders' | 'avg' | 'expenses' | 'net';

const COLS: { key: SortKey; label: string; num: boolean }[] = [
  { key: 'name', label: 'Branch', num: false },
  { key: 'sales', label: 'Sales', num: true },
  { key: 'orders', label: 'Orders', num: true },
  { key: 'avg', label: 'Avg ticket', num: true },
  { key: 'expenses', label: 'Expenses', num: true },
  { key: 'net', label: 'Net', num: true },
];

function sortValue(r: BranchData<ReportsDashboard>, key: SortKey): number | string {
  const k = r.data.kpis;
  switch (key) {
    case 'name':
      return r.name.toLowerCase();
    case 'sales':
      return k.sales_cents;
    case 'orders':
      return k.order_count;
    case 'avg':
      return k.avg_ticket_cents;
    case 'expenses':
      return k.expenses_cents;
    case 'net':
      return k.net_cents;
  }
}

/** Branch-vs-branch comparison: one row per branch, a totals row, % of sales.
 *  A row opens that branch's own dashboard for the same period. */
export function BranchesCompareTab({ range, custom }: Props) {
  const dash = useBusinessDashboard(range, custom);
  const { colour, label } = useColours();
  const { goToBranch } = useBranchNav();
  const loc = useLocation();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'sales', desc: true });

  const rows = useMemo(() => dash.data?.per_branch ?? [], [dash.data]);
  const pctBySlug = useMemo(() => {
    const p = sharePercents(rows.map((r) => r.data.kpis.sales_cents));
    return new Map(rows.map((r, i) => [r.slug, p[i] ?? 0]));
  }, [rows]);
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, sort]);

  if (dash.isPending) return <LoadingState />;
  if (dash.isError && !dash.data) return <ErrorState onRetry={() => dash.refetch()} />;
  const t = dash.data?.totals.kpis;

  // Open the branch's own dashboard on the same period (tab dropped — the
  // Branches tab only exists here).
  const openBranch = (slug: string) => {
    const p = new URLSearchParams(loc.search);
    p.delete('tab');
    const qs = p.toString();
    goToBranch(slug, `/admin${qs ? `?${qs}` : ''}`);
  };

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }));

  return (
    <>
      <CoverageNote statuses={dash.data?.branches ?? []} />
      <section className="panel bo-compare">
        <div className="bo-compare__scroll">
          <table className="t">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={c.num ? 'num' : undefined}
                    aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                  >
                    <button type="button" className="bo-sort" onClick={() => onSort(c.key)}>
                      {c.label}
                      {sort.key === c.key &&
                        (sort.desc ? <ArrowDown size={11} strokeWidth={1.8} /> : <ArrowUp size={11} strokeWidth={1.8} />)}
                    </button>
                  </th>
                ))}
                <th className="num">Cash / online</th>
                <th className="num">% of sales</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const k = r.data.kpis;
                const mix = r.data.payment_mix;
                return (
                  <tr
                    key={r.slug}
                    className="bo-row"
                    tabIndex={0}
                    onClick={() => openBranch(r.slug)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openBranch(r.slug);
                      }
                    }}
                    aria-label={`Open ${label(r.name)}'s dashboard`}
                  >
                    <td>
                      <span className="bo-branch">
                        <span className="branch-dot" style={{ background: colour(r.slug) }} aria-hidden />
                        {label(r.name)}
                      </span>
                    </td>
                    <td className="num">{formatNPR(k.sales_cents)}</td>
                    <td className="num">{k.order_count}</td>
                    <td className="num">{formatNPR(k.avg_ticket_cents)}</td>
                    <td className="num">{formatNPR(k.expenses_cents)}</td>
                    <td className={`num ${k.net_cents < 0 ? 'neg' : ''}`}>{formatNPR(k.net_cents)}</td>
                    <td className="num bo-mix">
                      {formatNPR(mix.cash_cents)} / {formatNPR(mix.online_cents + mix.bank_cents)}
                    </td>
                    <td className="num">
                      <span className="bo-pct">
                        <span className="bo-pct__bar" style={{ width: `${pctBySlug.get(r.slug) ?? 0}%`, background: colour(r.slug) }} />
                        {pctBySlug.get(r.slug) ?? 0}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {t && (
              <tfoot>
                <tr>
                  <th scope="row">All branches</th>
                  <td className="num">{formatNPR(t.sales_cents)}</td>
                  <td className="num">{t.order_count}</td>
                  <td className="num">{formatNPR(t.avg_ticket_cents)}</td>
                  <td className="num">{formatNPR(t.expenses_cents)}</td>
                  <td className={`num ${t.net_cents < 0 ? 'neg' : ''}`}>{formatNPR(t.net_cents)}</td>
                  <td className="num bo-mix">
                    {formatNPR(dash.data!.totals.payment_mix.cash_cents)} /{' '}
                    {formatNPR(dash.data!.totals.payment_mix.online_cents + dash.data!.totals.payment_mix.bank_cents)}
                  </td>
                  <td className="num">{rows.length ? '100%' : '—'}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>
          Click a branch to open its own dashboard for the same period. Average ticket for all branches is total sales ÷
          total orders, not an average of the branches' averages.
        </p>
      </section>
    </>
  );
}
