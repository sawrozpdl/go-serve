import { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  X,
  Info,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { useProfitability, useProfitabilityDrilldown, type ProfitRange } from '@/lib/api';
import { todayIso, yesterdayIso, addDaysIso } from '@/lib/dates';
import { formatNPR } from '@/components/Money';
import { DatePicker } from '@/components/DatePicker';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';

// Multi-day spans live as chips below the single-day stepper. Single days are
// driven by the ◀ ▶ day-nav (mirrors History) and queried as a custom range
// with from === to, so any past day is reachable — not just today/yesterday.
const SPAN_RANGES: { value: ProfitRange; label: string }[] = [
  { value: 'thisweek', label: 'this week' },
  { value: 'mtd', label: 'this month' },
  { value: 'lastmonth', label: 'last month' },
  { value: 'ytd', label: 'year-to-date' },
  { value: 'all', label: 'all-time' },
];

// Which control is driving the report. 'day' = the single-day stepper,
// 'span' = one of the SPAN_RANGES chips, 'custom' = an explicit From/To range.
type Mode = 'day' | 'span' | 'custom';

export function ProfitabilityPage() {
  // Deep-link support: e.g. History's "View profit for this day" links to
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD. When both are valid we open on that exact
  // custom range; otherwise we default to today as before.
  const [params] = useSearchParams();
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const linkFrom = params.get('from') ?? '';
  const linkTo = params.get('to') ?? '';
  const deepLinked = isoRe.test(linkFrom) && isoRe.test(linkTo);
  // A single-day deep link (from === to) lands on the day stepper; a true range
  // opens the custom From/To row. No deep link → default to today.
  const deepDay = deepLinked && linkFrom === linkTo;
  const deepRange = deepLinked && linkFrom !== linkTo;

  const [mode, setMode] = useState<Mode>(deepRange ? 'custom' : 'day');
  const [day, setDay] = useState(deepDay ? linkFrom : todayIso());
  const [span, setSpan] = useState<ProfitRange>('thisweek');
  const [from, setFrom] = useState(deepRange ? linkFrom : '');
  const [to, setTo] = useState(deepRange ? linkTo : '');
  const [drillId, setDrillId] = useState<string | null>(null);

  // Resolve the active control into the (range, custom) the API expects. Span
  // mode uses a real server range; day/custom both ride the 'custom' range.
  const effRange: ProfitRange = mode === 'span' ? span : 'custom';
  const effCustom = mode === 'day' ? { from: day, to: day } : { from, to };

  const report = useProfitability(effRange, effCustom);
  const atToday = day >= todayIso();

  const stepDay = (delta: number) => {
    setMode('day');
    setDay((d) => addDaysIso(d, delta));
  };

  const totals = report.data?.totals;
  const cats = report.data?.categories ?? [];
  const maxBarWidth = cats.reduce((m, c) => Math.max(m, Math.abs(c.revenue_cents), Math.abs(c.cogs_cents)), 0);

  // A category with revenue but no allocated COGS shows up as 100% margin —
  // useful to flag because it's almost always missing-config rather than a
  // truly cost-free product.
  const phantom100Pct = cats.filter((c) => c.revenue_cents > 0 && c.cogs_cents === 0);
  const unallocated = report.data?.unallocated_cogs_cents ?? 0;

  return (
    <PageShell eyebrow="cost-center accounting" title="Profitability">
      {/* Single-day stepper — same ◀ date ▶ pattern as History. Reachable to
          any past day; the right arrow is disabled (but legible) on today. */}
      <div className="profit-day-nav">
        <div className="history-day-nav">
          <button
            type="button"
            className="btn icon"
            aria-label="Previous day"
            onClick={() => stepDay(-1)}
          >
            <ChevronLeft size={16} strokeWidth={1.6} />
          </button>
          <DatePicker
            value={day}
            onChange={(d) => {
              setMode('day');
              setDay(d);
            }}
            max={todayIso()}
            presets={[
              { label: 'Today', value: todayIso() },
              { label: 'Yesterday', value: yesterdayIso() },
            ]}
          />
          <button
            type="button"
            className="btn icon"
            aria-label="Next day"
            disabled={atToday}
            onClick={() => stepDay(1)}
          >
            <ChevronRight size={16} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      <div className="filter-row">
        {SPAN_RANGES.map((r) => (
          <button
            type="button"
            key={r.value}
            className={`chip ${mode === 'span' && span === r.value ? 'active' : ''}`}
            onClick={() => {
              setMode('span');
              setSpan(r.value);
            }}
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          className={`chip ${mode === 'custom' ? 'active' : ''}`}
          onClick={() => setMode('custom')}
        >
          custom
        </button>
      </div>

      {mode === 'custom' && (
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

      {totals && (phantom100Pct.length > 0 || unallocated > 0) && (
        <div className="banner-info" style={{ marginBottom: 14 }}>
          <Info size={14} strokeWidth={1.5} />
          <span>
            <strong>How COGS is calculated:</strong> revenue comes from closed orders.
            Costs come from two sources, summed together: (1) <em>direct cost</em> per
            menu item (set the <em>Cost per unit</em> on each <Link to="/admin/menu">menu item</Link>);
            (2) <em>allocated</em> from <Link to="/admin/expenses">expenses</Link>
            tagged to a menu category. Use direct cost for stable per-unit costs (e.g.
            "Americano = Rs 30 to make"). Use allocations for batch / overhead expenses
            (e.g. "5kg of flour for momos this month").
            {phantom100Pct.length > 0 && (
              <>
                {' '}
                <strong style={{ color: 'var(--amber-fg)' }}>
                  {phantom100Pct.length} categor{phantom100Pct.length === 1 ? 'y' : 'ies'}
                  {' '}showing 100% margin
                </strong>{' '}
                ({phantom100Pct.map((c) => c.name).join(', ')}) — set per-item costs in
                Menu, or tag expenses to these categories.
              </>
            )}
            {unallocated > 0 && (
              <>
                {' '}
                <strong>{formatNPR(unallocated)}</strong> of expenses are not allocated
                to any menu category and don't reduce per-category margin —{' '}
                <Link to="/admin/expenses">tag them now</Link>.
              </>
            )}
          </span>
        </div>
      )}

      {totals && (
        <div className="kpis">
          <div className="kpi">
            <div className="label">Revenue</div>
            <div className="value">{formatNPR(totals.revenue_cents)}</div>
          </div>
          <div className="kpi">
            <div className="label">COGS (allocated)</div>
            <div className="value" style={{ color: 'var(--amber-fg)' }}>
              {formatNPR(totals.cogs_cents)}
            </div>
          </div>
          <div className="kpi">
            <div className="label">Gross profit</div>
            <div
              className="value"
              style={{
                color: totals.gross_profit_cents >= 0 ? 'var(--lime-fg)' : 'var(--danger-fg)',
              }}
            >
              {totals.gross_profit_cents >= 0 ? (
                <TrendingUp size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />
              ) : (
                <TrendingDown size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />
              )}
              {formatNPR(totals.gross_profit_cents)}
            </div>
          </div>
          <div className="kpi">
            <div className="label">Margin</div>
            <div className="value">
              {totals.margin_pct == null ? '—' : `${totals.margin_pct.toFixed(1)}%`}
            </div>
            {(report.data?.unallocated_cogs_cents ?? 0) > 0 && (
              <div className="delta">
                + {formatNPR(report.data!.unallocated_cogs_cents)} unallocated
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>By category</h3>
          <span className="meta">Click a row to drill in</span>
        </div>

        {/* isLoading (not isPending): a query disabled while waiting on custom
            dates is "pending" with nothing fetching — isPending would pin the
            spinner on "Computing…" forever. isLoading = pending && fetching. */}
        {report.isLoading && <LoadingState label="Computing…" />}
        {report.isError && !report.data && <ErrorState onRetry={() => report.refetch()} />}
        {report.data && cats.length === 0 && (
          <div className="empty-state">No menu categories yet.</div>
        )}

        {cats.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Category</th>
                <th>Bars (revenue / cogs)</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
                <th style={{ textAlign: 'right' }}>COGS</th>
                <th style={{ textAlign: 'right' }}>Gross profit</th>
                <th style={{ textAlign: 'right', width: 100 }}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr
                  key={c.menu_category_id ?? c.name}
                  onClick={() => c.menu_category_id && setDrillId(c.menu_category_id)}
                  style={{ cursor: c.menu_category_id ? 'pointer' : 'default' }}
                >
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td>
                    <ProfitBars
                      revenue={c.revenue_cents}
                      cogs={c.cogs_cents}
                      max={maxBarWidth || 1}
                    />
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {formatNPR(c.revenue_cents)}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--amber-fg)' }}>
                    {c.cogs_cents > 0 ? formatNPR(c.cogs_cents) : '—'}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      color: c.gross_profit_cents >= 0 ? 'var(--lime-fg)' : 'var(--danger-fg)',
                    }}
                  >
                    {formatNPR(c.gross_profit_cents)}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {c.margin_pct == null ? (
                      '—'
                    ) : c.revenue_cents > 0 && c.cogs_cents === 0 ? (
                      <span
                        title="100% margin = no COGS allocated. Tag an expense to this category in Expenses."
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'var(--amber-fg)',
                        }}
                      >
                        <AlertTriangle size={11} strokeWidth={1.5} />
                        100%
                      </span>
                    ) : (
                      `${c.margin_pct.toFixed(1)}%`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {drillId && (
        <DrilldownPanel
          categoryId={drillId}
          range={effRange}
          custom={effCustom}
          onClose={() => setDrillId(null)}
        />
      )}
    </PageShell>
  );
}

// -------------------------------------------------------------------------

function ProfitBars({ revenue, cogs, max }: { revenue: number; cogs: number; max: number }) {
  const rw = Math.max(2, (revenue / max) * 100);
  const cw = Math.max(0, (cogs / max) * 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
      <div
        style={{
          height: 6,
          width: `${rw}%`,
          background: 'var(--lime-fg)',
          opacity: revenue > 0 ? 0.85 : 0.15,
          borderRadius: 1,
        }}
        title={`revenue ${formatNPR(revenue)}`}
      />
      <div
        style={{
          height: 6,
          width: `${cw}%`,
          background: 'var(--amber-fg)',
          opacity: cogs > 0 ? 0.85 : 0.15,
          borderRadius: 1,
        }}
        title={`cogs ${formatNPR(cogs)}`}
      />
    </div>
  );
}

// -------------------------------------------------------------------------
// Drill-down (right-side panel)
// -------------------------------------------------------------------------

function DrilldownPanel({
  categoryId,
  range,
  custom,
  onClose,
}: {
  categoryId: string;
  range: ProfitRange;
  custom: { from: string; to: string };
  onClose: () => void;
}) {
  const drill = useProfitabilityDrilldown(categoryId, range, custom);
  const c = drill.data?.category;

  return (
    <div className="drill-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drill-panel">
        <div className="drill-head">
          <div>
            <span className="eyebrow">{drill.data?.range ?? range}</span>
            <h2 className="tab-title">{c?.name ?? 'loading…'}</h2>
            {c?.margin_pct != null && (
              <div className="tab-meta">margin {c.margin_pct.toFixed(1)}%</div>
            )}
          </div>
          <button type="button" className="btn icon" onClick={onClose} aria-label="close">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {drill.isLoading && <LoadingState compact />}
        {drill.isError && !drill.data && <ErrorState compact onRetry={() => drill.refetch()} />}
        {drill.data && (
          <>
            <div className="settle-totals" style={{ padding: '0 20px' }}>
              <Row label="revenue" value={c?.revenue_cents ?? 0} accent="ok" />
              <Row label="direct cost (per-item × qty)" value={c?.direct_cogs_cents ?? 0} accent="warn" />
              <Row label="allocated cost (expenses)" value={c?.allocated_cogs_cents ?? 0} accent="warn" />
              <hr className="settle-rule" />
              <Row label="total cogs" value={c?.cogs_cents ?? 0} accent="warn" />
              <Row label="gross profit" value={c?.gross_profit_cents ?? 0} bold accent={(c?.gross_profit_cents ?? 0) >= 0 ? 'ok' : 'bad'} />
            </div>

            <DrillSection title={`expenses (${drill.data.expenses.length})`}>
              {drill.data.expenses.length === 0 && <div className="kds-empty">No costs allocated to this bucket yet.</div>}
              {drill.data.expenses.map((e) => (
                <div key={e.expense_id} className="exp" style={{ padding: '10px 0' }}>
                  <div className="left">
                    <span className="name">{e.vendor || '(no vendor)'}</span>
                    <span className="meta">
                      {new Date(e.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} · {e.share_pct}% of {formatNPR(e.expense_amount_cents)}
                    </span>
                    {e.notes && <span className="meta">{e.notes}</span>}
                  </div>
                  <span className="amt" style={{ color: 'var(--amber-fg)' }}>
                    {formatNPR(e.allocated_cents)}
                  </span>
                </div>
              ))}
            </DrillSection>

            <DrillSection title={`items sold (${drill.data.items.length})`}>
              {drill.data.items.length === 0 && <div className="kds-empty">No sales of items in this category.</div>}
              {drill.data.items.map((i) => (
                <div key={i.menu_item_id} className="exp" style={{ padding: '10px 0' }}>
                  <div className="left">
                    <span className="name">{i.name}</span>
                    <span className="meta">
                      {i.qty} sold
                      {i.cost_cents > 0 && ` · cost ${formatNPR(i.cost_cents)}`}
                      {i.cost_cents > 0 && i.revenue_cents > 0 && (
                        <>
                          {' '}· margin{' '}
                          {(((i.revenue_cents - i.cost_cents) / i.revenue_cents) * 100).toFixed(0)}%
                        </>
                      )}
                    </span>
                  </div>
                  <span className="amt">{formatNPR(i.revenue_cents)}</span>
                </div>
              ))}
            </DrillSection>
          </>
        )}
      </aside>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: number;
  bold?: boolean;
  accent?: 'ok' | 'warn' | 'bad';
}) {
  const cls = ['settle-row'];
  if (bold) cls.push('bold');
  const color =
    accent === 'ok'
      ? 'var(--lime-fg)'
      : accent === 'warn'
      ? 'var(--amber-fg)'
      : accent === 'bad'
      ? 'var(--danger-fg)'
      : undefined;
  return (
    <div className={cls.join(' ')}>
      <span>{label}</span>
      <span className="num" style={color ? { color } : undefined}>
        {formatNPR(value)}
      </span>
    </div>
  );
}

function DrillSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '14px 20px', borderTop: '1px solid var(--ink-800)' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-400)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}
