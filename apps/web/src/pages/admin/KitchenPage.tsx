import { useEffect, useState } from 'react';
import { CheckCircle2, Send, Clock, ChefHat } from 'lucide-react';

import { useKitchenTickets, useUpdateKitchenTicket, type KitchenTicket } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { toast } from '@/lib/toast';

export function KitchenPage() {
  const tickets = useKitchenTickets();
  const update = useUpdateKitchenTicket();

  // Keep "now" ticking so the elapsed-time labels stay current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const inProgress = (tickets.data ?? []).filter((t) => t.kitchen_status === 'in_progress');
  const ready = (tickets.data ?? []).filter((t) => t.kitchen_status === 'ready');

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">kitchen display</span>
          <h1>Kitchen</h1>
        </div>
        <div className="actions">
          <span className="meta-line">
            {inProgress.length} in progress · {ready.length} ready
          </span>
        </div>
      </div>

      <div className="kds-cols">
        <KdsColumn
          title="in progress"
          tickets={inProgress}
          now={now}
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
          title="ready"
          tickets={ready}
          now={now}
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
          icon={<ChefHat size={40} strokeWidth={1.4} style={{ color: 'var(--lime-500)' }} />}
          emoji="✨"
          title="kitchen's all clear"
          hint={<>nothing in the queue. orders sent from the floor land here.</>}
        />
      )}
    </>
  );
}

function KdsColumn({
  title,
  tickets,
  now,
  actionLabel,
  actionIcon,
  onAction,
  accent,
}: {
  title: string;
  tickets: KitchenTicket[];
  now: number;
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
        {tickets.length === 0 && <div className="kds-empty">no tickets.</div>}
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
            <button type="button" className="btn primary" onClick={() => onAction(t)}>
              {actionIcon} {actionLabel}
            </button>
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
