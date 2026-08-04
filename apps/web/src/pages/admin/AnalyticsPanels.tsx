// Extra analytics panels shown on the Dashboard: peak-hours heatmap,
// category-mix donut + ranked legend, table mix table, top-sellers with
// prior-period delta. Reuses the existing range chips on Dashboard via props.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

import {
  useTopSellers,
  useHeatmap,
  useCategoryMix,
  useTableMix,
  useVelocity,
  type DashboardRange,
  type DashboardCustom,
  type HeatmapCell,
} from '@/lib/api';
import { formatNPR } from '@/components/Money';
import { ErrorState } from '@/components/ErrorState';
import { IconGlyph } from '@/components/IconPicker';
import { InfoHint } from '@/components/InfoHint';
import { LoadingState } from '@/components/LoadingState';
import { OTHER_COLOR, pickSliceColor } from '@/lib/chartColors';
import { OTHER_KEY, arcs, rollUpSlices, type Slice } from '@/lib/donut';

// -----------------------------------------------------------------------------
// Top movers with prior-period delta arrows.
// -----------------------------------------------------------------------------

export function TopMoversPanel({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const data = useTopSellers(range, custom);
  const rows = data.data?.top ?? [];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Top Movers<InfoHint topic="top-movers" /></h3>
        <Link className="panel-link" to="/admin/reports/movers">View all →</Link>
      </div>
      {data.isPending && <LoadingState compact />}
      {data.isError && !data.data && <ErrorState compact onRetry={() => data.refetch()} />}
      {data.data && rows.length === 0 && (
        <div className="empty-state">No sales in this window.</div>
      )}
      {rows.map((r, i) => {
        const delta = r.delta_pct;
        const positive = (delta ?? 0) >= 0;
        return (
          <div key={r.menu_item_id} className="mover">
            <span className="mover-rank">{i + 1}</span>
            <span className="mover-icon">
              <IconGlyph name={r.icon} size={18} />
            </span>
            <div className="mover-body">
              <span className="mover-name">{r.name}</span>
              <span className="mover-meta">
                {r.category_name ?? '—'} · {r.qty} sold
                {delta != null && r.prev_qty !== r.qty && (
                  <> · prev {r.prev_qty}</>
                )}
              </span>
            </div>
            <div className="mover-right">
              <span className="mover-amt">{formatNPR(r.revenue_cents)}</span>
              <DeltaPill deltaPct={delta} positive={positive} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function DeltaPill({ deltaPct, positive }: { deltaPct?: number | null; positive: boolean }) {
  if (deltaPct == null) {
    return (
      <span className="pill" title="No prior-period data">
        <Minus size={10} strokeWidth={1.5} /> new
      </span>
    );
  }
  if (deltaPct === 0) {
    return (
      <span className="pill">
        <Minus size={10} strokeWidth={1.5} /> 0%
      </span>
    );
  }
  const fmt = `${positive ? '+' : ''}${deltaPct.toFixed(1)}%`;
  return (
    <span className={`pill ${positive ? 'ok' : 'bad'}`}>
      {positive ? <TrendingUp size={10} strokeWidth={1.5} /> : <TrendingDown size={10} strokeWidth={1.5} />}
      {fmt}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Category mix — donut + ranked legend.
// -----------------------------------------------------------------------------

/** Ring geometry. r is chosen so 2πr lands near 100, which keeps the dash
 *  numbers legible in the DOM; stroke width is the ring's thickness. */
const DONUT = { size: 132, r: 52, stroke: 18 };
const CIRC = 2 * Math.PI * DONUT.r;

export function CategoryMixPanel({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const data = useCategoryMix(range, custom);
  // Not `?? []` out here — that allocates a fresh array on every render and the
  // memos below would never actually memoize. The default goes inside.
  const rows = data.data?.rows;

  // Fold the long tail before drawing: the endpoint returns every category, and
  // a menu with two dozen of them produced slices too thin to see.
  const slices = useMemo(() => rollUpSlices(rows ?? []), [rows]);
  const ring = useMemo(() => arcs(slices, CIRC), [slices]);
  const colorFor = (s: Slice, i: number) =>
    s.key === OTHER_KEY ? OTHER_COLOR : pickSliceColor(i, s.color);

  const total = slices.reduce((n, s) => n + s.revenueCents, 0);
  // The chart is decorative — the legend below carries the same numbers as text —
  // so one summary label is enough for a screen reader.
  const summary = slices
    .map((s) => `${s.name} ${s.sharePct.toFixed(1)}%`)
    .join(', ');

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Category Mix<InfoHint topic="category-mix" /></h3>
        <span className="meta">Revenue share</span>
      </div>
      {data.isPending && <LoadingState compact />}
      {data.isError && !data.data && <ErrorState compact onRetry={() => data.refetch()} />}
      {data.data && slices.length === 0 && (
        <div className="empty-state">No sales to allocate.</div>
      )}
      {slices.length > 0 && (
        <div className="cat-mix">
          <div className="cat-donut">
            <svg
              viewBox={`0 0 ${DONUT.size} ${DONUT.size}`}
              width={DONUT.size}
              height={DONUT.size}
              role="img"
              aria-label={`Revenue share by category: ${summary}`}
            >
              {/* -90° so the first (largest) slice starts at 12 o'clock — SVG
                  dashes otherwise begin at 3 o'clock. */}
              <g transform={`rotate(-90 ${DONUT.size / 2} ${DONUT.size / 2})`}>
                <circle
                  className="cat-donut__track"
                  cx={DONUT.size / 2}
                  cy={DONUT.size / 2}
                  r={DONUT.r}
                  strokeWidth={DONUT.stroke}
                />
                {ring.map((a, i) => (
                  <circle
                    key={a.key}
                    className="cat-donut__arc"
                    cx={DONUT.size / 2}
                    cy={DONUT.size / 2}
                    r={DONUT.r}
                    strokeWidth={DONUT.stroke}
                    stroke={colorFor(a.slice, i)}
                    strokeDasharray={a.dashArray}
                    strokeDashoffset={a.dashOffset}
                    data-slice={a.key}
                  />
                ))}
              </g>
            </svg>
            <div className="cat-donut__mid">
              <span className="cat-donut__total">{formatNPR(total)}</span>
              <span className="cat-donut__cap">total</span>
            </div>
          </div>

          <ul className="cat-legend">
            {slices.map((s, i) => (
              <li key={s.key} className="cat-row">
                <span className="cat-row__dot" style={{ background: colorFor(s, i) }} />
                <span className="cat-row__name">
                  {s.key !== OTHER_KEY && <IconGlyph name={s.icon} size={14} />}
                  <span className="cat-row__label">{s.name}</span>
                  {s.count > 1 && (
                    <span className="cat-row__n">{s.count} categories</span>
                  )}
                </span>
                <span className="cat-row__amt">{formatNPR(s.revenueCents)}</span>
                <span className="cat-row__pct">{s.sharePct.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Heatmap — 7 rows × 24 cols. Color intensity = order count.
// -----------------------------------------------------------------------------

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function HeatmapPanel({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const data = useHeatmap(range, custom);
  const cells = data.data?.cells ?? [];

  // Index by dow*24 + hour for O(1) lookups while drawing the grid.
  const { grid, max } = useMemo(() => {
    const g = new Array<HeatmapCell | null>(7 * 24).fill(null);
    let m = 0;
    for (const c of cells) {
      const idx = c.dow * 24 + c.hour;
      g[idx] = c;
      if (c.order_count > m) m = c.order_count;
    }
    return { grid: g, max: m };
  }, [cells]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Peak Hours<InfoHint topic="peak-hours" /></h3>
        <span className="meta">Orders by hour × day</span>
      </div>
      {data.isPending && <LoadingState compact />}
      {data.isError && !data.data && <ErrorState compact onRetry={() => data.refetch()} />}
      {data.data && max === 0 && (
        <div className="empty-state">No orders to plot.</div>
      )}
      {max > 0 && (
        // The grid scrolls horizontally on phones (see admin.css), so it is a
        // focusable labelled region — a scroll container that only responds to
        // touch/trackpad leaves keyboard users unable to reach later hours.
        <div
          className="heatmap"
          role="region"
          aria-label="Orders by hour and day of week"
          tabIndex={0}
        >
          <div className="heatmap-hours">
            <span />
            {Array.from({ length: 24 }).map((_, h) => (
              <span key={h} className={h % 3 === 0 ? 'hr-major' : 'hr-minor'}>
                {h % 3 === 0 ? h : ''}
              </span>
            ))}
          </div>
          {DOW_LABELS.map((label, d) => (
            <div key={d} className="heatmap-row">
              <span className="heatmap-row-label">{label}</span>
              {Array.from({ length: 24 }).map((_, h) => {
                const c = grid[d * 24 + h];
                const v = c?.order_count ?? 0;
                const intensity = max > 0 ? v / max : 0;
                return (
                  <div
                    key={h}
                    className="heatmap-cell"
                    style={{
                      background:
                        intensity === 0
                          ? 'var(--tint-3)'
                          : `rgba(255, 163, 25, ${0.15 + intensity * 0.85})`,
                    }}
                    title={
                      c
                        ? `${label} ${h}:00 — ${c.order_count} orders · ${formatNPR(c.revenue_cents)}`
                        : `${label} ${h}:00 — no orders`
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Velocity — daily sparkline of avg ticket + items/order.
// -----------------------------------------------------------------------------

export function VelocityPanel({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const data = useVelocity(range, custom);
  const series = data.data?.series ?? [];
  const maxRev = series.reduce((m, p) => Math.max(m, p.revenue_cents), 0);
  const maxIpo = series.reduce((m, p) => Math.max(m, p.items_per_order_x10), 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Throughput<InfoHint topic="velocity" /></h3>
        <span className="meta">Revenue · items per order</span>
      </div>
      {data.isPending && <LoadingState compact />}
      {data.isError && !data.data && <ErrorState compact onRetry={() => data.refetch()} />}
      {data.data && (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
            <Stat label="Orders" value={data.data.total_orders.toLocaleString()} />
            <Stat label="Avg ticket" value={formatNPR(data.data.avg_ticket_cents)} />
            <Stat
              label="Items / order"
              value={(data.data.avg_items_per_order_x10 / 10).toFixed(1)}
            />
          </div>
          <div className="velocity-chart">
            {series.map((p) => {
              const revH = maxRev > 0 ? (p.revenue_cents / maxRev) * 100 : 0;
              const ipoH = maxIpo > 0 ? (p.items_per_order_x10 / maxIpo) * 100 : 0;
              return (
                <div key={p.day} className="velocity-col" title={`${p.day} · ${formatNPR(p.revenue_cents)} · ${(p.items_per_order_x10 / 10).toFixed(1)} items/order`}>
                  <div className="velocity-rev" style={{ height: `${revH}%` }} />
                  <div className="velocity-ipo" style={{ height: `${ipoH}%` }} />
                </div>
              );
            })}
          </div>
          <div className="velocity-legend">
            <span><i className="legend-dot rev" /> Revenue</span>
            <span><i className="legend-dot ipo" /> Items / order</span>
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1 }}>
      <div className="label" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-400)' }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-num)', fontSize: 20, color: 'var(--ink-50)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Table utilization — list every table with revenue + order count.
// -----------------------------------------------------------------------------

export function TableMixPanel({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const data = useTableMix(range, custom);
  const rows = data.data?.rows ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.revenue_cents), 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Table Utilization<InfoHint topic="table-mix" /></h3>
        <span className="meta">Revenue per table</span>
      </div>
      {data.isPending && <LoadingState compact />}
      {data.isError && !data.data && <ErrorState compact onRetry={() => data.refetch()} />}
      {data.data && rows.length === 0 && (
        <div className="empty-state">No tables.</div>
      )}
      {rows.length > 0 && (
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>Name</th>
              <th>Capacity</th>
              <th>Orders</th>
              <th>Billed sales</th>
              <th style={{ textAlign: 'right' }}>Avg ticket</th>
              <th style={{ width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const w = max > 0 ? (r.revenue_cents / max) * 100 : 0;
              return (
                <tr key={r.table_id ?? r.name}>
                  <td>
                    <span style={{ color: 'var(--amber-fg)' }}>
                      <IconGlyph name={r.icon} size={18} />
                    </span>
                  </td>
                  <td><strong>{r.name}</strong></td>
                  <td className="sku">{r.capacity}</td>
                  <td className="sku">{r.order_count}</td>
                  <td className="num">{formatNPR(r.revenue_cents)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{formatNPR(r.avg_ticket_cents)}</td>
                  <td>
                    <div className="table-mix-bar">
                      <div style={{ width: `${w}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
