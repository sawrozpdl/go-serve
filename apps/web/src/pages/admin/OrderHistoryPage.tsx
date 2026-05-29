import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Receipt } from 'lucide-react';

import {
  useServiceTables,
  useOrderHistory,
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

// Operators only ever pick cash / online / house tab; historical rows may carry
// the older esewa/khalti/card values — collapse them to "Online".
function methodLabel(m: HistoryPayment['method']): string {
  if (m === 'cash') return 'Cash';
  if (m === 'house_tab') return 'House tab';
  return 'Online';
}

export function OrderHistoryPage() {
  const [date, setDate] = useState<string>(() => todayIso());
  const [tableId, setTableId] = useState<string>('');
  const tables = useServiceTables();
  const history = useOrderHistory(date, tableId || undefined);

  const tableOptions = useMemo(
    () => [
      { value: '', label: 'All tables' },
      ...(tables.data ?? []).map((t) => ({ value: t.id, label: t.name })),
    ],
    [tables.data],
  );

  const orders = history.data?.orders ?? [];
  const dayTotal = orders.reduce((sum, o) => sum + o.total_cents, 0);

  return (
    <PageShell
      eyebrow="Operations"
      title="History"
      subtitle="closed serves, day by day"
      actions={
        <>
          <span className="meta-line">
            {orders.length} serve{orders.length === 1 ? '' : 's'} · {formatNPR(dayTotal)}
          </span>
          <RefreshButton onClick={() => history.refetch()} busy={history.isFetching} label="Refresh" />
        </>
      }
    >
      <div className="history-filters">
        <DatePicker
          value={date}
          onChange={setDate}
          max={todayIso()}
          presets={[
            { label: 'Today', value: todayIso() },
            { label: 'Yesterday', value: yesterdayIso() },
          ]}
        />
        <div className="history-table-filter">
          <SearchSelect
            options={tableOptions}
            value={tableId}
            onChange={setTableId}
            placeholder="All tables"
          />
        </div>
      </div>

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

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
