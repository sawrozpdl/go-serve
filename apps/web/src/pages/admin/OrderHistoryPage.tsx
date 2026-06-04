import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronLeft, Clock, Receipt } from 'lucide-react';
import { Link } from 'react-router-dom';

import {
  useServiceTables,
  useOrderHistory,
  useMe,
  can,
  type HistoryOrder,
  type HistoryPayment,
} from '@/lib/api';
import { formatNPR } from '@/components/Money';
import { PageShell } from '@/components/PageShell';
import { DatePicker } from '@/components/DatePicker';
import { SearchSelect } from '@/components/SearchSelect';
import { EmptyState } from '@/components/EmptyState';
import { RefreshButton } from '@/components/RefreshButton';

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayIso(): string {
  return addDaysIso(todayIso(), -1);
}

// Step an ISO date by whole days using local-calendar arithmetic (not UTC), so
// crossing a DST boundary or month edge can never land on the wrong day.
function addDaysIso(iso: string, delta: number): string {
  const dt = new Date(`${iso}T00:00:00`);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Operators only ever pick cash / online / house tab; historical rows may carry
// the older esewa/khalti/card values — collapse them to "Online".
function methodLabel(m: HistoryPayment['method']): string {
  if (m === 'cash') return 'Cash';
  if (m === 'house_tab') return 'House tab';
  return 'Online';
}

type PayBucket = 'cash' | 'online' | 'house_tab';

function payBucket(m: HistoryPayment['method']): PayBucket {
  if (m === 'cash') return 'cash';
  if (m === 'house_tab') return 'house_tab';
  return 'online';
}

export function OrderHistoryPage() {
  const [date, setDate] = useState<string>(() => todayIso());
  const [tableId, setTableId] = useState<string>('');
  const tables = useServiceTables();
  const history = useOrderHistory(date, tableId || undefined);
  const me = useMe();
  const canSeeProfit = can(me.data, 'report:read');

  const tableOptions = useMemo(
    () => [
      { value: '', label: 'All tables' },
      ...(tables.data ?? []).map((t) => ({ value: t.id, label: t.name })),
    ],
    [tables.data],
  );

  const orders = useMemo(() => history.data?.orders ?? [], [history.data]);

  // Day rollup, computed from the same payload the cards render — so the
  // summary always reconciles with the list below (and respects the active
  // table filter, since the server already scoped the rows).
  const summary = useMemo(() => {
    let gross = 0;
    let discount = 0;
    let tax = 0;
    let service = 0;
    let items = 0;
    let voids = 0;
    const pay: Record<PayBucket, { amt: number; n: number }> = {
      cash: { amt: 0, n: 0 },
      online: { amt: 0, n: 0 },
      house_tab: { amt: 0, n: 0 },
    };
    for (const o of orders) {
      gross += o.total_cents;
      discount += o.discount_cents;
      tax += o.tax_cents;
      service += o.service_charge_cents;
      items += o.item_count;
      for (const it of o.items) if (it.voided_at) voids += 1;
      for (const p of o.payments) {
        const b = payBucket(p.method);
        pay[b].amt += p.amount_cents;
        pay[b].n += 1;
      }
    }
    const serves = orders.length;
    return {
      serves,
      gross,
      avg: serves ? Math.round(gross / serves) : 0,
      discount,
      tax,
      service,
      items,
      voids,
      pay,
    };
  }, [orders]);

  const atToday = date >= todayIso();

  return (
    <PageShell
      eyebrow="Operations"
      title="History"
      subtitle="closed serves, day by day"
      actions={
        <>
          <span className="meta-line">
            {summary.serves} serve{summary.serves === 1 ? '' : 's'} · {formatNPR(summary.gross)}
          </span>
          <RefreshButton onClick={() => history.refetch()} busy={history.isFetching} label="Refresh" />
        </>
      }
    >
      <div className="history-filters">
        <div className="history-day-nav">
          <button
            type="button"
            className="btn icon"
            aria-label="Previous day"
            onClick={() => setDate(addDaysIso(date, -1))}
          >
            <ChevronLeft size={16} strokeWidth={1.6} />
          </button>
          <DatePicker
            value={date}
            onChange={setDate}
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
            onClick={() => setDate(addDaysIso(date, 1))}
          >
            <ChevronRight size={16} strokeWidth={1.6} />
          </button>
        </div>
        <div className="history-table-filter">
          <SearchSelect
            options={tableOptions}
            value={tableId}
            onChange={setTableId}
            placeholder="All tables"
          />
        </div>
      </div>

      {orders.length > 0 && (
        <div className="history-summary">
          <div className="hs-stats">
            <HsStat label="Serves" value={String(summary.serves)} />
            <HsStat label="Gross sales" value={formatNPR(summary.gross)} accent />
            <HsStat label="Avg ticket" value={formatNPR(summary.avg)} />
          </div>
          <div className="hs-pay">
            <HsPay label="Cash" sub="drawer" amt={summary.pay.cash.amt} n={summary.pay.cash.n} />
            <HsPay label="Online" amt={summary.pay.online.amt} n={summary.pay.online.n} />
            {summary.pay.house_tab.n > 0 && (
              <HsPay label="House tab" amt={summary.pay.house_tab.amt} n={summary.pay.house_tab.n} />
            )}
          </div>
          <div className="hs-meta">
            <span>
              {summary.items} item{summary.items === 1 ? '' : 's'} sold
            </span>
            {summary.discount > 0 && <span>· Discounts {formatNPR(summary.discount)}</span>}
            {summary.tax > 0 && <span>· VAT {formatNPR(summary.tax)}</span>}
            {summary.service > 0 && <span>· Service {formatNPR(summary.service)}</span>}
            {summary.voids > 0 && (
              <span className="hs-void">
                · {summary.voids} voided item{summary.voids === 1 ? '' : 's'}
              </span>
            )}
            {canSeeProfit && (
              <Link className="hs-profit-link" to={`/admin/reports/profitability?from=${date}&to=${date}`}>
                View profit for this day →
              </Link>
            )}
          </div>
        </div>
      )}

      {history.isPending && <div className="empty-state">Loading history…</div>}
      {history.isError && (
        <div className="empty-state">Couldn't load history for this day.</div>
      )}
      {history.data && orders.length === 0 && (
        <EmptyState
          icon={<Receipt size={36} strokeWidth={1.4} style={{ color: 'var(--amber-fg)' }} />}
          emoji="🧾"
          title="No serves yet"
          hint={
            tableId
              ? 'Nothing closed on this table for the selected day.'
              : 'Nothing closed on the selected day.'
          }
        />
      )}

      <div className="history-list">
        {orders.map((o) => (
          <HistoryCard key={o.id} order={o} />
        ))}
      </div>
    </PageShell>
  );
}

function HsStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="hs-stat">
      <span className="hs-stat-label">{label}</span>
      <span className={`hs-stat-value${accent ? ' accent' : ''}`}>{value}</span>
    </div>
  );
}

function HsPay({ label, sub, amt, n }: { label: string; sub?: string; amt: number; n: number }) {
  return (
    <div className="hs-pay-tile">
      <span className="hs-pay-label">
        {label}
        {sub && <span className="hs-pay-sub"> · {sub}</span>}
      </span>
      <span className="hs-pay-amt">{formatNPR(amt)}</span>
      <span className="hs-pay-n">
        {n} payment{n === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function HistoryCard({ order }: { order: HistoryOrder }) {
  const [open, setOpen] = useState(false);
  const when = order.closed_at
    ? new Date(order.closed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—';
  const tableName = order.service_table_name ?? 'Walk-in';
  const paidLabels = order.payments.map((p) => methodLabel(p.method));
  const paidSummary = Array.from(new Set(paidLabels)).join(' + ');

  return (
    <div className={`history-card${open ? ' open' : ''}`}>
      <button type="button" className="history-head" onClick={() => setOpen((v) => !v)}>
        <span className="history-chevron" aria-hidden>
          {open ? <ChevronDown size={15} strokeWidth={1.6} /> : <ChevronRight size={15} strokeWidth={1.6} />}
        </span>
        <span className="history-main">
          <strong>{tableName}</strong>
          <span className="history-sub">
            <Clock size={11} strokeWidth={1.6} style={{ verticalAlign: '-1px' }} /> {when} ·{' '}
            {order.item_count} item{order.item_count === 1 ? '' : 's'}
            {paidSummary && <> · {paidSummary}</>}
          </span>
        </span>
        <span className="history-total">{formatNPR(order.total_cents)}</span>
      </button>

      {open && (
        <div className="history-body">
          <div className="history-items">
            {order.items.map((it) => {
              const voided = !!it.voided_at;
              return (
                <div key={it.id} className={`history-item${voided ? ' voided' : ''}`}>
                  <span className="hi-qty">{it.qty}×</span>
                  <span className="hi-name">
                    {it.menu_item_name}
                    {it.notes && <span className="hi-note"> · {it.notes}</span>}
                    {voided && <span className="hi-void"> · voided</span>}
                  </span>
                  <span className="hi-amt">{formatNPR(it.line_cents)}</span>
                </div>
              );
            })}
          </div>

          <div className="history-totals">
            <Row label="Subtotal" value={order.subtotal_cents} />
            {order.discount_cents > 0 && <Row label="Discount" value={-order.discount_cents} />}
            {order.service_charge_cents > 0 && (
              <Row label="Service charge" value={order.service_charge_cents} />
            )}
            {order.tax_cents > 0 && <Row label="VAT" value={order.tax_cents} />}
            <Row label="Total" value={order.total_cents} bold />
          </div>

          {order.payments.length > 0 && (
            <div className="history-payments">
              {order.payments.map((p, i) => (
                <div key={i} className="history-pay-row">
                  <span className="pill">{methodLabel(p.method)}</span>
                  {p.reference_no && <span className="hp-ref">{p.reference_no}</span>}
                  <span className="hp-amt">{formatNPR(p.amount_cents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`history-total-row${bold ? ' bold' : ''}`}>
      <span>{label}</span>
      <span className="num">{formatNPR(value)}</span>
    </div>
  );
}
