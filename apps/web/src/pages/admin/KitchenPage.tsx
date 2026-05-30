import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Send, Clock, ChefHat, Volume2, VolumeX } from 'lucide-react';

import { useKitchenTickets, useUpdateKitchenTicket, type KitchenTicket } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { RefreshButton } from '@/components/RefreshButton';
import { toast } from '@/lib/toast';
import { isSoundEnabled, setSoundEnabled, playBoop, unlockAudio } from '@/lib/notify';
import { usePermissions } from '@/lib/permissions';

export function KitchenPage() {
  const tickets = useKitchenTickets();
  const update = useUpdateKitchenTicket();
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

  const inProgress = (tickets.data ?? []).filter((t) => t.kitchen_status === 'in_progress');
  const ready = (tickets.data ?? []).filter((t) => t.kitchen_status === 'ready');

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">Kitchen display</span>
          <h1>Kitchen</h1>
        </div>
        <div className="actions">
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
        </div>
      </div>

      <div className="kds-cols">
        <KdsColumn
          title="In Progress"
          tickets={inProgress}
          now={now}
          canAct={canAct}
          actionLabel="Mark ready"
          actionIcon={<CheckCircle2 size={14} strokeWidth={1.5} />}
          onAction={(t) =>
            update.mutate(
              { itemId: t.item_id, kitchen_status: 'ready' },
              {
                onSuccess: () =>
                  toast.success(`${t.menu_item_name} ready`, t.service_table_name ?? 'take-away'),
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
          actionLabel="Mark served"
          actionIcon={<Send size={14} strokeWidth={1.5} />}
          onAction={(t) =>
            update.mutate(
              { itemId: t.item_id, kitchen_status: 'served' },
              {
                onSuccess: () =>
                  toast.success('Served', `${t.qty}× ${t.menu_item_name}`),
                onError: (e) => toast.error('Could not mark served', e.message),
              },
            )
          }
          accent="ok"
        />
      </div>

      {tickets.data?.length === 0 && (
        <EmptyState
          icon={<ChefHat size={40} strokeWidth={1.4} style={{ color: 'var(--lime-fg)' }} />}
          emoji="✨"
          title="Kitchen's all clear"
          hint={<>Nothing in the queue. Orders sent from the floor land here.</>}
        />
      )}
    </>
  );
}

function KdsColumn({
  title,
  tickets,
  now,
  canAct,
  actionLabel,
  actionIcon,
  onAction,
  accent,
}: {
  title: string;
  tickets: KitchenTicket[];
  now: number;
  /** Member holds kitchen:update — may advance a ticket's status. */
  canAct: boolean;
  actionLabel: string;
  actionIcon: React.ReactNode;
  onAction: (t: KitchenTicket) => void;
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
              <span className="kds-table">{t.service_table_name ?? 'Take-away'}</span>
              <span className="kds-time">
                <Clock size={12} strokeWidth={1.5} /> {elapsed(now, t.sent_to_kitchen_at, t.ready_at)}
              </span>
            </div>
            <div className="kds-item">
              <strong>
                {t.qty}× {t.menu_item_name}
              </strong>
              {t.notes && <div className="kds-note">{t.notes}</div>}
            </div>
            {canAct && (
              <button type="button" className="btn primary" onClick={() => onAction(t)}>
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
