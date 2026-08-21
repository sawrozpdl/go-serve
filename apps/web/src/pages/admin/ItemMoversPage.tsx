import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

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
import { SearchInput } from '@/components/SearchInput';
import { SearchSelect } from '@/components/SearchSelect';
import { ReportToolbar, ToolbarEnd, RangeChips, ReportCaption } from '@/components/ReportToolbar';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { ReportExportButton } from '@/components/ReportExportButton';
import { IconGlyph } from '@/components/IconPicker';
import { InfoHint } from '@/components/InfoHint';
import { DeltaPill } from './AnalyticsPanels';
import type { RangePreset, ReportRange } from '@/reports/range';

// Dashboard-range presets the movers report understands. `custom` isn't a
// DashboardRange the API knows — it's the chip that reveals the From/To pair.
const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 'today', label: 'today' },
  { value: 'yesterday', label: 'yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'mtd', label: 'this month' },
  { value: 'ytd', label: 'year-to-date' },
  { value: 'custom', label: 'custom' },
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

  // The period the chips/From-To currently describe, handed to the builder so
  // "Export PDF" opens on the same window the user is looking at.
  const reportRange: ReportRange =
    range === 'custom'
      ? { kind: 'custom', from, to }
      : { kind: 'preset', preset: range as RangePreset };

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
    <PageShell
      eyebrow="item performance"
      title="Movers"
      className="page-shell--fill movers-shell"
      actions={<ReportExportButton template="menu_performance" range={reportRange} />}
    >
      <ReportToolbar>
        <RangeChips options={RANGES} value={range} onChange={setRange} />
        {range === 'custom' && (
          <div className="filter-daterange">
            <label className="fdr-field">
              <span>From</span>
              <DatePicker value={from} onChange={setFrom} max={to || todayIso()} />
            </label>
            <label className="fdr-field">
              <span>To</span>
              <DatePicker value={to} onChange={setTo} min={from || undefined} max={todayIso()} />
            </label>
          </div>
        )}
        <ToolbarEnd>
          <SearchSelect
            options={[
              { value: '', label: 'All categories' },
              ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
            value={categoryId}
            onChange={setCategoryId}
            placeholder="All categories"
          />
          <SearchInput
            compact
            value={qInput}
            onChange={setQInput}
            placeholder="Search items…"
            ariaLabel="Search items by name"
            minWidth={200}
          />
        </ToolbarEnd>
      </ReportToolbar>

      <div className={`movers-layout${drillId ? ' movers-layout--split' : ''}`}>
        <section className="movers-table-panel">
          <ReportCaption
            title={
              <>
                All items<InfoHint topic="top-movers" />
              </>
            }
          >
            <span className="meta">{total} item(s) · vs prior period</span>
            {total > PAGE_SIZE && (
              <span className="report-pager">
                <button
                  type="button"
                  className="btn icon"
                  aria-label="Previous page"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft size={15} strokeWidth={1.6} />
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
                  <ChevronRight size={15} strokeWidth={1.6} />
                </button>
              </span>
            )}
          </ReportCaption>

          {movers.isPending && <LoadingState compact />}
          {movers.isError && !movers.data && <ErrorState compact onRetry={() => movers.refetch()} />}
          {movers.data && rows.length === 0 && (
            <div className="empty-state">No sales match these filters.</div>
          )}

          {rows.length > 0 && (
            <div className="movers-table-wrap">
              <table className="movers-table">
                {/* Percentages, not pixels: fixed pixel numerics dumped every
                    spare pixel into the item column and left a canyon between
                    the name and Qty. These spread with the viewport. */}
                <colgroup>
                  <col style={{ width: '4%' }} />
                  <col style={{ width: '32%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '19%' }} />
                  <col style={{ width: '17%' }} className="mt-col-prev" />
                  <col style={{ width: '16%' }} />
                </colgroup>
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
                    <th className="mt-num mt-prev">Prev</th>
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
                        <td className="mt-item">
                          <span className="mover-icon">
                            <IconGlyph name={r.icon} size={16} />
                          </span>
                          <span className="mt-name" title={r.name}>{r.name}</span>
                          <span className="mt-cat">{r.category_name ?? '—'}</span>
                        </td>
                        <td className="mt-num">{formatQty(r.qty)}</td>
                        <td className="mt-num mt-rev">{formatNPR(r.revenue_cents)}</td>
                        <td className="mt-num mt-muted mt-prev">{formatNPR(r.prev_revenue_cents)}</td>
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
