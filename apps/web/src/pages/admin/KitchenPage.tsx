import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Send, Clock, ChefHat, CloudOff, Volume2, VolumeX } from 'lucide-react';

import {
  useKitchenTickets,
  useUpdateKitchenTicket,
  useOutlets,
  resolveTableLabel,
  formatQty,
  type KitchenTicket,
  type Order,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { useConnectivity } from '@/lib/connectivity';
import { useOfflineQueue } from '@/lib/offline-queue';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { RefreshButton } from '@/components/RefreshButton';
import { PageShell } from '@/components/PageShell';
import { toast } from '@/lib/toast';
import { isSoundEnabled, setSoundEnabled, playBoop, unlockAudio } from '@/lib/notify';
import { usePermissions } from '@/lib/permissions';

type BoardTicket = KitchenTicket & {
  /** Sent to the kitchen while offline — queued, not yet on the server. */
  pendingSync?: boolean;
};

/* Tickets implied by queued send-to-kitchen ops. The offline send already
 * flipped the order's pending lines to in_progress in the persisted ['order']
 * cache, so a single-tablet cafe keeps a working board with no network. */
function usePendingSyncTickets(slug: string | null): BoardTicket[] {
  const qc = useQueryClient();
  const ops = useOfflineQueue((s) => s.ops);
  return useMemo(() => {
    const out: BoardTicket[] = [];
    for (const op of ops) {
      if (op.kind !== 'send_kitchen' || op.status === 'needs_review') continue;
      if (!slug || op.tenantSlug !== slug) continue;
      const order = qc.getQueryData<Order>(['order', slug, op.orderId]);
      for (const i of order?.items ?? []) {
        if (i.voided_at || i.kitchen_status !== 'in_progress') continue;
        out.push({
          item_id: i.id,
          order_id: op.orderId,
          service_table_name: order?.service_table_name ?? null,
          table_label: order?.table_label ?? '',
          menu_item_name: i.menu_item_name,
          qty: i.qty,
          modifiers: i.modifiers,
          notes: i.notes,
          kitchen_status: 'in_progress',
          sent_to_kitchen_at: i.sent_to_kitchen_at,
          ready_at: null,
          pendingSync: true,
        });
      }
    }
    return out;
  }, [ops, qc, slug]);
}

const KDS_OUTLET_KEY = 'cafe.kdsOutlet';

export function KitchenPage() {
  const { slug } = useTenant();
  const tickets = useKitchenTickets();
  const update = useUpdateKitchenTicket();
  const outlets = useOutlets();
  const { mode } = useConnectivity();
  const offline = mode === 'offline';
  const pendingSync = usePendingSyncTickets(slug);

  // Per-device outlet filter — the bar tablet remembers it shows the Bar board.
  // Only meaningful once a second outlet exists; a single-outlet cafe never
  // sees the switcher and always views everything.
  const [selectedOutlet, setSelectedOutlet] = useState<string>(
    () => localStorage.getItem(KDS_OUTLET_KEY) ?? 'all',
  );
  const activeOutlets = (outlets.data ?? []).filter((o) => o.is_active || o.is_default);
  const multiOutlet = activeOutlets.length > 1;
  const defaultOutletId = outlets.data?.find((o) => o.is_default)?.id;
  // Guard a stale saved id (outlet deleted) back to "all".
  const outletFilter =
    selectedOutlet !== 'all' && !outlets.data?.some((o) => o.id === selectedOutlet)
      ? 'all'
      : selectedOutlet;
  const pickOutlet = (id: string) => {
    setSelectedOutlet(id);
    try {
      localStorage.setItem(KDS_OUTLET_KEY, id);
    } catch {
      // storage disabled — selection just won't persist across reloads
    }
  };
  // kitchen:read lets a member watch the board; advancing a ticket needs
  // kitchen:update (so a waiter sees the queue but can't mark items ready).
  const canAct = usePermissions().can('kitchen:update');

  // Keep "now" ticking so the elapsed-time labels stay current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // Sound toggle — persisted to localStorage via the notify helper.
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled());

  // Track previously-seen ticket IDs so we only chirp on actually-new items
  // (not on every refetch). Skip the initial load so an existing queue
  // doesn't bleat at page open. Internal play() is already throttled.
  const seenIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!tickets.data) return;
    const currentIds = new Set(
      tickets.data
        .filter((t) => t.kitchen_status === 'in_progress')
        .map((t) => t.item_id),
    );
    if (seenIds.current === null) {
      seenIds.current = currentIds;
      return;
    }
    let hasNew = false;
    for (const id of currentIds) {
      if (!seenIds.current.has(id)) {
        hasNew = true;
        break;
      }
    }
    seenIds.current = currentIds;
    if (hasNew) playBoop();
  }, [tickets.data]);

  // Merge queued offline sends into the board; the server wins on conflict.
  // When replay drains the queue it invalidates ['kitchen-tickets'], so
  // pending cards are seamlessly replaced by their real tickets.
  const serverIds = new Set((tickets.data ?? []).map((t) => t.item_id));
  const merged: BoardTicket[] = [
    ...(tickets.data ?? []),
    ...pendingSync.filter((p) => !serverIds.has(p.item_id)),
  ];
  const hasBoard = tickets.data !== undefined || pendingSync.length > 0;
  // Filter by the selected outlet. Legacy/offline tickets with no stamped
  // outlet fall onto the default outlet's board (matches the server filter).
  const visible = merged.filter((t) => {
    if (outletFilter === 'all') return true;
    return (t.outlet_id ?? defaultOutletId) === outletFilter;
  });
  const inProgress = visible.filter((t) => t.kitchen_status === 'in_progress');
  const ready = visible.filter((t) => t.kitchen_status === 'ready');

  return (
    <PageShell
      eyebrow="Kitchen display"
      title="Kitchen"
      actions={
        <>
          <span className="meta-line">
            {inProgress.length} In Progress · {ready.length} Ready
          </span>
          <button
            type="button"
            className="btn icon"
            onClick={() => {
              const next = !soundOn;
              setSoundEnabled(next);
              setSoundOn(next);
              if (next) {
                unlockAudio();
                playBoop(); // immediate confirmation chirp on toggle-on
              }
            }}
            title={soundOn ? 'Sound on — new orders chime' : 'Sound off — silent updates'}
            aria-pressed={soundOn}
          >
            {soundOn ? (
              <Volume2 size={14} strokeWidth={1.5} />
            ) : (
              <VolumeX size={14} strokeWidth={1.5} />
            )}
            <span className="nav-label">{soundOn ? 'Sound' : 'Muted'}</span>
          </button>
          <RefreshButton
            onClick={() => tickets.refetch()}
            busy={tickets.isFetching}
            label="Refresh tickets"
          />
        </>
      }
    >
      {multiOutlet && (
        <div className="filter-row" style={{ marginBottom: 12 }} role="tablist" aria-label="Outlet">
          <button
            type="button"
            className={`chip${outletFilter === 'all' ? ' active' : ''}`}
            role="tab"
            aria-selected={outletFilter === 'all'}
            onClick={() => pickOutlet('all')}
          >
            All
          </button>
          {activeOutlets.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`chip${outletFilter === o.id ? ' active' : ''}`}
              role="tab"
              aria-selected={outletFilter === o.id}
              onClick={() => pickOutlet(o.id)}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
      {tickets.isPending && !offline && <LoadingState />}
      {tickets.isPending && offline && !hasBoard && (
        <EmptyState
          icon={<CloudOff size={40} strokeWidth={1.4} style={{ color: 'var(--warn-fg-tile)' }} />}
          title="You're offline"
          hint={<>The kitchen board will reload as soon as the connection returns.</>}
        />
      )}
      {tickets.isError && !hasBoard && <ErrorState onRetry={() => tickets.refetch()} />}
      {hasBoard && (
        <div className="kds-cols">
          <KdsColumn
            title="In Progress"
            tickets={inProgress}
            now={now}
            canAct={canAct}
            offline={offline}
            actionLabel="Mark ready"
            actionIcon={<CheckCircle2 size={14} strokeWidth={1.5} />}
            onAction={(t) =>
              update.mutate(
                { itemId: t.item_id, kitchen_status: 'ready' },
                {
                  onSuccess: () =>
                    toast.success(`${t.menu_item_name} ready`, resolveTableLabel(t, 'take-away')),
                  onError: (e) => toast.error('Could not mark ready', e.message),
                },
              )
            }
            accent="warn"
          />
          <KdsColumn
            title="Ready"
            tickets={ready}
            now={now}
            canAct={canAct}
            offline={offline}
            actionLabel="Mark served"
            actionIcon={<Send size={14} strokeWidth={1.5} />}
            onAction={(t) =>
              update.mutate(
                { itemId: t.item_id, kitchen_status: 'served' },
                {
                  onSuccess: () =>
                    toast.success('Served', `${formatQty(t.qty)}× ${t.menu_item_name}`),
                  onError: (e) => toast.error('Could not mark served', e.message),
                },
              )
            }
            accent="ok"
          />
        </div>
      )}

      {hasBoard && visible.length === 0 && (
        <EmptyState
          icon={<ChefHat size={40} strokeWidth={1.4} style={{ color: 'var(--lime-fg)' }} />}
          emoji="✨"
          title={outletFilter === 'all' ? "Kitchen's all clear" : 'All clear here'}
          hint={<>Nothing in the queue. Orders sent from the floor land here.</>}
        />
      )}
    </PageShell>
  );
}

function KdsColumn({
  title,
  tickets,
  now,
  canAct,
  offline,
  actionLabel,
  actionIcon,
  onAction,
  accent,
}: {
  title: string;
  tickets: BoardTicket[];
  now: number;
  /** Member holds kitchen:update — may advance a ticket's status. */
  canAct: boolean;
  /** Ticket status updates need server truth — buttons disable offline. */
  offline: boolean;
  actionLabel: string;
  actionIcon: React.ReactNode;
  onAction: (t: BoardTicket) => void;
  accent: 'warn' | 'ok';
}) {
  return (
    <div className="kds-col">
      <div className="kds-col-head">
        <span className="kds-col-title">{title}</span>
        <span className={`pill ${accent}`}>{tickets.length}</span>
      </div>
      <div className="kds-col-body">
        {tickets.length === 0 && <div className="kds-empty">No tickets.</div>}
        {tickets.map((t) => (
          <div key={t.item_id} className="kds-card">
            <div className="kds-card-head">
              <span className="kds-table">{resolveTableLabel(t, 'Take-away')}</span>
              {t.pendingSync ? (
                <span className="pill warn" title="Sent while offline — syncs when the connection returns">
                  <CloudOff size={11} strokeWidth={1.7} aria-hidden="true" /> waiting to sync
                </span>
              ) : (
                <span className="kds-time">
                  <Clock size={12} strokeWidth={1.5} /> {elapsed(now, t.sent_to_kitchen_at, t.ready_at)}
                </span>
              )}
            </div>
            <div className="kds-item">
              <strong>
                {formatQty(t.qty)}× {t.menu_item_name}
              </strong>
              {t.notes && <div className="kds-note">{t.notes}</div>}
            </div>
            {canAct && !t.pendingSync && (
              <button
                type="button"
                className="btn primary"
                disabled={offline}
                title={offline ? 'Offline — ticket updates need a connection' : undefined}
                onClick={() => onAction(t)}
              >
                {actionIcon} {actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function elapsed(now: number, sentAt?: string | null, readyAt?: string | null): string {
  const ref = readyAt ?? sentAt;
  if (!ref) return '—';
  const sec = Math.max(0, Math.floor((now - new Date(ref).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}
