// Extra analytics panels shown on the Dashboard: peak-hours heatmap,
// category-mix donut + bar, table mix table, top-sellers with prior-period
// delta. Reuses the existing range chips on Dashboard via props.

import { useMemo } from 'react';
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
        <span className="meta">vs prior {range}</span>
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

function DeltaPill({ deltaPct, positive }: { deltaPct?: number | null; positive: boolean }) {
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
// Category mix — colored stacked bar + legend.
// -----------------------------------------------------------------------------

export function CategoryMixPanel({ range, custom }: { range: DashboardRange; custom?: DashboardCustom }) {
  const data = useCategoryMix(range, custom);
  const rows = data.data?.rows ?? [];
  const colors = ['#FFA319', '#A3F02C', '#6FB9FF', '#FF7AA3', '#C28DFF', '#FFD166', '#5BD1A4'];

  const palette = (idx: number, raw?: string | null) => raw || colors[idx % colors.length];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Category Mix<InfoHint topic="category-mix" /></h3>
        <span className="meta">Revenue share</span>
      </div>
      {data.isPending && <LoadingState compact />}
      {data.isError && !data.data && <ErrorState compact onRetry={() => data.refetch()} />}
      {data.data && rows.length === 0 && (
        <div className="empty-state">No sales to allocate.</div>
      )}
      {rows.length > 0 && (
        <>
          <div className="cat-mix-bar">
            {rows.map((r, i) => (
              <div
                key={r.category_id}
                style={{
                  width: `${r.share_pct}%`,
                  background: palette(i, r.color),
                }}
                title={`${r.name}: ${r.share_pct}% (${formatNPR(r.revenue_cents)})`}
              />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            {rows.map((r, i) => (
              <div key={r.category_id} className="exp" style={{ paddingTop: 6, paddingBottom: 6 }}>
                <div className="left" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: palette(i, r.color),
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ width: 22, color: r.color || palette(i, r.color), display: 'flex', justifyContent: 'center' }}>
                    <IconGlyph name={r.icon} color={r.color || palette(i, r.color)} size={16} />
                  </span>
                  <span className="name">{r.name}</span>
                </div>
                <span className="amt">
                  {formatNPR(r.revenue_cents)} · {r.share_pct.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </>
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
        <div className="heatmap">
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
              <th>Revenue</th>
              <th style={{ textAlign: 'right' }}>Avg ticket</th>
              <th style={{ width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const w = max > 0 ? (r.revenue_cents / max) * 100 : 0;
              return (
                <tr key={r.table_id}>
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
