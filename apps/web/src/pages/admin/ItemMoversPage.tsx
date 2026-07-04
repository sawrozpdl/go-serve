import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';

import {
  useMovers,
  useItemAnalytics,
  useMenuCategories,
  formatQty,
  type DashboardRange,
  type DashboardCustom,
  type MoversQuery,
} from '@/lib/api';
import { todayIso } from '@/lib/dates';
import { formatNPR } from '@/components/Money';
import { DatePicker } from '@/components/DatePicker';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { IconGlyph } from '@/components/IconPicker';
import { InfoHint } from '@/components/InfoHint';
import { DeltaPill } from './AnalyticsPanels';

// Dashboard-range presets the movers report understands (custom rides From/To).
const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 'today', label: 'today' },
  { value: 'yesterday', label: 'yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'mtd', label: 'this month' },
  { value: 'ytd', label: 'year-to-date' },
];

const PAGE_SIZE = 50;

export function ItemMoversPage() {
  const [range, setRange] = useState<DashboardRange>('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sort, setSort] = useState<'revenue' | 'qty'>('revenue');
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [drillId, setDrillId] = useState<string | null>(null);

  // Debounce the search box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [range, from, to, categoryId, sort, order, q]);

  const custom: DashboardCustom = { from, to };
  const filters: MoversQuery = {
    category_id: categoryId || undefined,
    sort,
    order,
    q: q || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const categories = useMenuCategories();
  const movers = useMovers(range, custom, filters);
  const rows = movers.data?.rows ?? [];
  const total = movers.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setHeaderSort = (col: 'revenue' | 'qty') => {
    if (sort === col) setOrder((o) => (o === 'desc' ? 'asc' : 'desc'));
    else {
      setSort(col);
      setOrder('desc');
    }
  };
  const sortMark = (col: 'revenue' | 'qty') =>
    sort === col ? (order === 'desc' ? ' ↓' : ' ↑') : '';

  return (
    <PageShell eyebrow="item performance" title="Movers" className="page-shell--fill movers-shell">
      {/* Range chips + custom From/To */}
      <div className="filter-row">
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
        <button
          type="button"
          className={`chip ${range === 'custom' ? 'active' : ''}`}
          onClick={() => setRange('custom')}
        >
          custom
        </button>
      </div>

      {range === 'custom' && (
        <div className="profit-custom-range">
          <label className="prc-field">
            <span>From</span>
            <DatePicker value={from} onChange={setFrom} max={to || todayIso()} />
          </label>
          <label className="prc-field">
            <span>To</span>
            <DatePicker value={to} onChange={setTo} min={from || undefined} max={todayIso()} />
          </label>
        </div>
      )}

      {/* Category + search filters */}
      <div className="movers-filters">
        <select
          className="movers-cat"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="movers-search">
          <Search size={14} strokeWidth={1.6} />
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search items…"
            aria-label="Search items by name"
          />
          {qInput && (
            <button type="button" className="btn icon" aria-label="Clear search" onClick={() => setQInput('')}>
              <X size={13} strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>

      <div className="movers-layout">
        <section className="movers-table-panel">
          <div className="panel-head">
            <h3>
              All items<InfoHint topic="top-movers" />
            </h3>
            <span className="meta">{total} item(s) · vs prior period</span>
          </div>

          {movers.isPending && <LoadingState compact />}
          {movers.isError && !movers.data && <ErrorState compact onRetry={() => movers.refetch()} />}
          {movers.data && rows.length === 0 && (
            <div className="empty-state">No sales match these filters.</div>
          )}

          {rows.length > 0 && (
            <div className="movers-table-wrap">
              <table className="movers-table">
                <thead>
                  <tr>
                    <th className="mt-rank">#</th>
                    <th>Item</th>
                    <th className="mt-num mt-sortable" onClick={() => setHeaderSort('qty')}>
                      Qty{sortMark('qty')}
                    </th>
                    <th className="mt-num mt-sortable" onClick={() => setHeaderSort('revenue')}>
                      Revenue{sortMark('revenue')}
                    </th>
                    <th className="mt-num">Prev</th>
                    <th className="mt-delta">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const positive = (r.delta_pct ?? 0) >= 0;
                    return (
                      <tr
                        key={r.menu_item_id}
                        className={`movers-row ${drillId === r.menu_item_id ? 'active' : ''}`}
                        onClick={() => setDrillId(r.menu_item_id)}
                      >
                        <td className="mt-rank">{page * PAGE_SIZE + i + 1}</td>
                        <td>
                          <span className="mover-icon">
                            <IconGlyph name={r.icon} size={16} />
                          </span>
                          <span className="mt-name">{r.name}</span>
                          <span className="mt-cat">{r.category_name ?? '—'}</span>
                        </td>
                        <td className="mt-num">{formatQty(r.qty)}</td>
                        <td className="mt-num">{formatNPR(r.revenue_cents)}</td>
                        <td className="mt-num mt-muted">{formatNPR(r.prev_revenue_cents)}</td>
                        <td className="mt-delta">
                          <DeltaPill deltaPct={r.delta_pct} positive={positive} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {total > PAGE_SIZE && (
            <div className="movers-pager">
              <button
                type="button"
                className="btn icon"
                aria-label="Previous page"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft size={16} strokeWidth={1.6} />
              </button>
              <span className="meta">
                {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                className="btn icon"
                aria-label="Next page"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight size={16} strokeWidth={1.6} />
              </button>
            </div>
          )}
        </section>

        {drillId && (
          <ItemDrilldownPanel
            menuItemId={drillId}
            range={range}
            custom={custom}
            onClose={() => setDrillId(null)}
          />
        )}
      </div>
    </PageShell>
  );
}

function ItemDrilldownPanel({
  menuItemId,
  range,
  custom,
  onClose,
}: {
  menuItemId: string;
  range: DashboardRange;
  custom: DashboardCustom;
  onClose: () => void;
}) {
  const item = useItemAnalytics(menuItemId, range, custom);
  const d = item.data;

  const revDelta =
    d && d.prev_revenue_cents > 0
      ? ((d.revenue_cents - d.prev_revenue_cents) / d.prev_revenue_cents) * 100
      : null;
  const qtyDelta =
    d && d.prev_qty > 0 ? ((d.qty - d.prev_qty) / d.prev_qty) * 100 : null;

  const maxSeries = useMemo(
    () => (d ? d.series.reduce((m, p) => Math.max(m, p.revenue_cents), 0) : 0),
    [d],
  );
  const maxHour = useMemo(() => (d ? Math.max(0, ...d.by_hour) : 0), [d]);

  return (
    <section className="panel item-drill">
      <div className="panel-head">
        <h3>
          {d ? (
            <>
              <span className="mover-icon">
                <IconGlyph name={d.icon} size={16} />
              </span>
              {d.name}
            </>
          ) : (
            'Item'
          )}
        </h3>
        <button type="button" className="btn icon" aria-label="Close" onClick={onClose}>
          <X size={15} strokeWidth={1.6} />
        </button>
      </div>

      {item.isPending && <LoadingState compact />}
      {item.isError && !d && <ErrorState compact onRetry={() => item.refetch()} />}

      {d && (
        <>
          <div className="item-drill-kpis">
            <div className="idk">
              <span className="idk-label">Qty sold</span>
              <span className="idk-val">{formatQty(d.qty)}</span>
              <DeltaPill deltaPct={qtyDelta == null ? null : Math.round(qtyDelta * 10) / 10} positive={(qtyDelta ?? 0) >= 0} />
            </div>
            <div className="idk">
              <span className="idk-label">Revenue</span>
              <span className="idk-val">{formatNPR(d.revenue_cents)}</span>
              <DeltaPill deltaPct={revDelta == null ? null : Math.round(revDelta * 10) / 10} positive={(revDelta ?? 0) >= 0} />
            </div>
            <div className="idk">
              <span className="idk-label">Margin</span>
              <span className="idk-val">{d.margin_pct == null ? '—' : `${d.margin_pct.toFixed(0)}%`}</span>
              <span className="idk-sub">cost {formatNPR(d.cost_cents)}</span>
            </div>
          </div>

          <div className="item-drill-sub">
            Trend · {d.category_name ?? '—'}
          </div>
          {d.series.length === 0 ? (
            <div className="empty-state">No sales in this window.</div>
          ) : (
            <div className="item-trend" role="img" aria-label="Daily revenue trend">
              {d.series.map((p) => (
                <div key={p.date} className="it-bar-col" title={`${p.date}: ${formatNPR(p.revenue_cents)} · ${formatQty(p.qty)}`}>
                  <div
                    className="it-bar"
                    style={{ height: `${maxSeries > 0 ? (p.revenue_cents / maxSeries) * 100 : 0}%` }}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="item-drill-sub">Busiest hours</div>
          <div className="item-hours" role="img" aria-label="Quantity by hour of day">
            {d.by_hour.map((qty, hr) => (
              <div key={hr} className="ih-col" title={`${hr}:00 — ${formatQty(qty)}`}>
                <div
                  className="ih-bar"
                  style={{ height: `${maxHour > 0 ? (qty / maxHour) * 100 : 0}%` }}
                />
                {hr % 6 === 0 && <span className="ih-label">{hr}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
