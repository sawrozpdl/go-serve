import { useNavigate } from 'react-router-dom';
import { Users, Sparkles, LayoutGrid, Armchair, Plus, HelpCircle } from 'lucide-react';

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
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { RefreshButton } from '@/components/RefreshButton';
import { IconGlyph } from '@/components/IconPicker';
import { PageShell } from '@/components/PageShell';
import { toast } from '@/lib/toast';
import { usePermissions } from '@/lib/permissions';

export function FloorPage() {
  const tables = useServiceTables();
  const orders = useOrders('open');
  const openOrder = useOpenOrder();
  const updateTable = useUpdateServiceTable();
  const nav = useNavigate();
  const { can } = usePermissions();
  const canOpenTab = can('order:create'); // open a new tab on a table / walk-in
  const canSweep = can('table:update'); // mark a dirty table clean

  // Map service_table_id → open order, so each tile can show its tab.
  const openByTable = new Map<string, Order>();
  const walkins: Order[] = [];
  for (const o of orders.data ?? []) {
    if (o.service_table_id) openByTable.set(o.service_table_id, o);
    else walkins.push(o);
  }

  // Open a tab with no table — for a customer who orders before deciding
  // where to sit. It can be assigned to (or merged into) a table later from
  // the tab's Move action.
  const onUnknown = async () => {
    try {
      const fresh = await openOrder.mutateAsync({});
      toast.success('Walk-in tab opened', 'assign a table later');
      nav(`/admin/floor/${fresh.id}`);
    } catch (e: unknown) {
      toast.error('Could not open tab', (e as { message?: string }).message);
    }
  };

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
    <PageShell
      eyebrow="Operations"
      title="Floor"
      actions={
        <>
          <span className="meta-line">
            {orders.data?.length ?? 0} open · {tables.data?.length ?? 0} tables
          </span>
          <RefreshButton
            onClick={() => Promise.all([tables.refetch(), orders.refetch()])}
            busy={tables.isFetching || orders.isFetching}
            label="Refresh floor"
          />
        </>
      }
    >
      {tables.isPending && <LoadingState />}
      {tables.isError && !tables.data && <ErrorState onRetry={() => tables.refetch()} />}
      {tables.data?.length === 0 && (
        <EmptyState
          icon={<LayoutGrid size={40} strokeWidth={1.4} style={{ color: 'var(--amber-fg)' }} />}
          title="No tables yet"
          emoji="🪑"
          hint={
            <>
              Set up your floor in <strong>Admin · Tables</strong> — the
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
                // A tile with an existing order is navigable (order:read). One
                // without would open a new tab, so disable it for members who
                // lack order:create.
                disabled={openOrder.isPending || isDirty || (!order && !canOpenTab)}
              >
                <div className="ft-head">
                  <span className="ft-name">
                    <span className="ft-icon" aria-hidden>
                      <IconGlyph name={t.icon} size={16} fallback={<Armchair size={16} strokeWidth={1.5} />} />
                    </span>
                    {t.name}
                  </span>
                  <span className="ft-cap" aria-label={`Seats ${t.capacity}`} title={`Seats ${t.capacity}`}>
                    <Users size={12} strokeWidth={1.5} aria-hidden="true" /> {t.capacity}
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
                    <div className="ft-cta">
                      {t.status === 'free'
                        ? 'Open tab'
                        : t.status === 'occupied'
                        ? 'Occupied'
                        : t.status === 'reserved'
                        ? 'Reserved'
                        : 'Dirty'}
                    </div>
                  )}
                </div>
                {t.area && <div className="ft-area">{t.area}</div>}
              </button>
              {isDirty && canSweep && (
                <button
                  type="button"
                  className="ft-sweep"
                  onClick={() => onSweep(t)}
                  disabled={updateTable.isPending}
                  title="Mark clean → free"
                >
                  <Sparkles size={12} strokeWidth={1.5} />
                  Mark clean
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Walk-in / Unknown tabs — orders opened without a table. The "Unknown +"
       * tile starts one; existing walk-ins link to their tab where they can be
       * assigned to (or merged into) a table. */}
      <div className="floor-section">
        <div className="floor-section-head">Walk-in / Unknown</div>
        <div className="floor-grid">
          {walkins.map((o) => {
            const s = deriveTabState(o);
            return (
              <button
                key={o.id}
                type="button"
                className="floor-tile occupied"
                onClick={() => nav(`/admin/floor/${o.id}`)}
              >
                <div className="ft-head">
                  <span className="ft-name">
                    <span className="ft-icon" aria-hidden>
                      <HelpCircle size={16} strokeWidth={1.5} />
                    </span>
                    Walk-in
                  </span>
                </div>
                <div className="ft-body">
                  <div className="ft-amt">{formatNPR(o.live_subtotal_cents)}</div>
                  <div className="ft-meta">
                    {o.items_total} items · {timeAgo(o.opened_at)}
                  </div>
                  {s && (
                    <div className={`ft-state ft-state--${s.tone}`} title={s.hint}>
                      {s.label}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
          {canOpenTab && (
            <button
              type="button"
              className="floor-tile unknown-add"
              onClick={onUnknown}
              disabled={openOrder.isPending}
            >
              <span className="ua-plus" aria-hidden>
                <Plus size={20} strokeWidth={1.6} />
              </span>
              <span className="ua-label">Unknown +</span>
              <span className="ua-sub">tab without a table</span>
            </button>
          )}
        </div>
      </div>
    </PageShell>
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
