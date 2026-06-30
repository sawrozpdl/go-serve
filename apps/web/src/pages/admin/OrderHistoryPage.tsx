import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronLeft, Clock, Receipt, ArrowLeftRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  useServiceTables,
  useOrderHistory,
  useReclassifyPayment,
  useMe,
  can,
  resolveTableLabel,
  type HistoryOrder,
  type HistoryPayment,
} from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { formatNPR } from '@/components/Money';
import { PageShell } from '@/components/PageShell';
import { InfoHint } from '@/components/InfoHint';
import { DatePicker } from '@/components/DatePicker';
import { SearchSelect } from '@/components/SearchSelect';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { RefreshButton } from '@/components/RefreshButton';
import { todayIso, yesterdayIso, addDaysIso } from '@/lib/dates';

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function OrderHistoryPage() {
  // Deep-linkable day: the Dashboard "Daily sales" chart links here with
  // ?date=YYYY-MM-DD. Seed initial state from it (falling back to today), and
  // keep following the param if it changes (e.g. arriving from another bar).
  const [searchParams] = useSearchParams();
  const dateParam = searchParams.get('date');
  const [date, setDate] = useState<string>(() =>
    dateParam && ISO_DATE.test(dateParam) ? dateParam : todayIso(),
  );
  useEffect(() => {
    if (dateParam && ISO_DATE.test(dateParam)) setDate(dateParam);
  }, [dateParam]);
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
      className="page-shell--fill"
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
            <HsStat label="Serves" value={String(summary.serves)} topic="orders" />
            <HsStat
              label="Gross sales"
              value={formatNPR(summary.gross)}
              accent
              topic="sales"
              sub={
                summary.pay.house_tab.amt > 0
                  ? `${formatNPR(summary.pay.house_tab.amt)} on tab · ${formatNPR(
                      summary.gross - summary.pay.house_tab.amt,
                    )} collected`
                  : undefined
              }
            />
            <HsStat label="Avg ticket" value={formatNPR(summary.avg)} topic="avg-ticket" />
          </div>
          <div className="hs-pay">
            <HsPay label="Cash" sub="drawer" amt={summary.pay.cash.amt} n={summary.pay.cash.n} topic="payment-split" />
            <HsPay label="Online" amt={summary.pay.online.amt} n={summary.pay.online.n} />
            {summary.pay.house_tab.n > 0 && (
              <HsPay
                label="House tab"
                sub="not in hand"
                amt={summary.pay.house_tab.amt}
                n={summary.pay.house_tab.n}
              />
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

      {history.isPending && <LoadingState label="Loading history…" />}
      {history.isError && !history.data && (
        <ErrorState title="Couldn't load history for this day" onRetry={() => history.refetch()} />
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

function HsStat({
  label,
  value,
  accent,
  sub,
  topic,
}: {
  label: string;
  value: string;
  accent?: boolean;
  sub?: string;
  topic?: string;
}) {
  return (
    <div className="hs-stat">
      <span className="hs-stat-label">
        {label}
        {topic && <InfoHint topic={topic} size={12} />}
      </span>
      <span className={`hs-stat-value${accent ? ' accent' : ''}`}>{value}</span>
      {sub && <span className="hs-stat-sub">{sub}</span>}
    </div>
  );
}

function HsPay({
  label,
  sub,
  amt,
  n,
  topic,
}: {
  label: string;
  sub?: string;
  amt: number;
  n: number;
  topic?: string;
}) {
  return (
    <div className="hs-pay-tile">
      <span className="hs-pay-label">
        {label}
        {sub && <span className="hs-pay-sub"> · {sub}</span>}
        {topic && <InfoHint topic={topic} size={12} />}
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
  const { can: canDo } = usePermissions();
  const reclassify = useReclassifyPayment();
  const [confirmSwapId, setConfirmSwapId] = useState<string | null>(null);
  const canReclassify = canDo('payment:reclassify');
  const when = order.closed_at
    ? new Date(order.closed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—';
  const tableName = resolveTableLabel(order, 'Walk-in');
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
              {order.payments.map((p, i) => {
                const swapTo = p.method === 'cash' ? 'online' : 'cash';
                const showSwap = canReclassify && p.reclassifiable;
                return (
                  <div key={p.id || i}>
                    <div className="history-pay-row">
                      <span className="pill">{methodLabel(p.method)}</span>
                      {p.reference_no && <span className="hp-ref">{p.reference_no}</span>}
                      <span className="hp-amt">{formatNPR(p.amount_cents)}</span>
                      {showSwap && (
                        <button
                          type="button"
                          className="btn icon"
                          onClick={() => setConfirmSwapId(confirmSwapId === p.id ? null : p.id)}
                          aria-label={`change method to ${swapTo}`}
                          title="Wrong method? Switch cash/online"
                        >
                          <ArrowLeftRight size={12} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                    {showSwap && confirmSwapId === p.id && (
                      <div className="swap-confirm">
                        <span>
                          Make this {formatNPR(p.amount_cents)} payment{' '}
                          <strong>{swapTo === 'cash' ? 'Cash' : 'Online'}</strong>?
                        </span>
                        <button
                          type="button"
                          className="btn primary"
                          disabled={reclassify.isPending}
                          onClick={async () => {
                            try {
                              await reclassify.mutateAsync({
                                orderId: order.id,
                                paymentId: p.id,
                                method: swapTo,
                              });
                              setConfirmSwapId(null);
                              toast.success(
                                'Payment reclassified',
                                `${formatNPR(p.amount_cents)} is now ${swapTo}`,
                              );
                            } catch (e: unknown) {
                              toast.error(
                                "Couldn't reclassify",
                                (e as { message?: string }).message ?? 'Failed',
                              );
                            }
                          }}
                        >
                          {reclassify.isPending ? 'Switching…' : 'Confirm'}
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirmSwapId(null)}>
                          Keep
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
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
