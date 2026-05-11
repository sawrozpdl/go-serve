import { useNavigate } from 'react-router-dom';
import { Users, Sparkles, LayoutGrid } from 'lucide-react';

import {
  useServiceTables,
  useOrders,
  useOpenOrder,
  useUpdateServiceTable,
  deriveTabState,
  type ServiceTable,
  type Order,
} from '@/lib/api';
import { formatNPR } from '@/components/Money';
import { EmptyState } from '@/components/EmptyState';
import { toast } from '@/lib/toast';

export function FloorPage() {
  const tables = useServiceTables();
  const orders = useOrders('open');
  const openOrder = useOpenOrder();
  const updateTable = useUpdateServiceTable();
  const nav = useNavigate();

  // Map service_table_id → open order, so each tile can show its tab.
  const openByTable = new Map<string, Order>();
  for (const o of orders.data ?? []) {
    if (o.service_table_id) openByTable.set(o.service_table_id, o);
  }

  const onClickTable = async (t: ServiceTable) => {
    const existing = openByTable.get(t.id);
    if (existing) {
      nav(`/admin/floor/${existing.id}`);
      return;
    }
    if (t.status === 'dirty') {
      // Block opening a tab on a dirty table — mark it clean first via
      // the per-tile sweep button. Mirrors what a host would do IRL.
      return;
    }
    try {
      const fresh = await openOrder.mutateAsync({ service_table_id: t.id });
      toast.success(`Tab opened — ${t.name}`, 'starting fresh');
      nav(`/admin/floor/${fresh.id}`);
    } catch (e: unknown) {
      toast.error('Could not open tab', (e as { message?: string }).message);
    }
  };

  const onSweep = async (t: ServiceTable) => {
    try {
      await updateTable.mutateAsync({ id: t.id, patch: { status: 'free' } });
      toast.success(`${t.name} cleaned`, 'ready for the next guest');
    } catch (e: unknown) {
      toast.error('Could not mark clean', (e as { message?: string }).message);
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">operations</span>
          <h1>Floor</h1>
        </div>
        <div className="actions">
          <span className="meta-line">
            {orders.data?.length ?? 0} open · {tables.data?.length ?? 0} tables
          </span>
        </div>
      </div>

      {tables.isPending && <div className="empty-state">loading…</div>}
      {tables.data?.length === 0 && (
        <EmptyState
          icon={<LayoutGrid size={40} strokeWidth={1.4} style={{ color: 'var(--amber-fg)' }} />}
          title="no tables yet"
          emoji="🪑"
          hint={
            <>
              set up your floor in <strong>admin · tables</strong> — the
              tabs you open will appear here.
            </>
          }
        />
      )}

      <div className="floor-grid">
        {(tables.data ?? []).map((t) => {
          const order = openByTable.get(t.id);
          const occupied = !!order || t.status === 'occupied';
          const isDirty = !occupied && t.status === 'dirty';
          return (
            <div
              key={t.id}
              className={`floor-tile-wrap ${isDirty ? 'dirty' : ''}`}
            >
              <button
                type="button"
                className={`floor-tile ${occupied ? 'occupied' : t.status}`}
                onClick={() => onClickTable(t)}
                disabled={openOrder.isPending || isDirty}
              >
                <div className="ft-head">
                  <span className="ft-name">{t.name}</span>
                  <span className="ft-cap">
                    <Users size={12} strokeWidth={1.5} /> {t.capacity}
                  </span>
                </div>
                <div className="ft-body">
                  {order ? (
                    <>
                      <div className="ft-amt">{formatNPR(order.live_subtotal_cents)}</div>
                      <div className="ft-meta">
                        {order.items_total} items · {timeAgo(order.opened_at)}
                      </div>
                      {(() => {
                        const s = deriveTabState(order);
                        if (!s) return null;
                        return (
                          <div className={`ft-state ft-state--${s.tone}`} title={s.hint}>
                            {s.label}
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <div className="ft-cta">{t.status === 'free' ? 'open tab' : t.status}</div>
                  )}
                </div>
                {t.area && <div className="ft-area">{t.area}</div>}
              </button>
              {isDirty && (
                <button
                  type="button"
                  className="ft-sweep"
                  onClick={() => onSweep(t)}
                  disabled={updateTable.isPending}
                  title="mark clean → free"
                >
                  <Sparkles size={12} strokeWidth={1.5} />
                  mark clean
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}
