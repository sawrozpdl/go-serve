import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Send, X, Trash2, Receipt, Percent, Coffee } from 'lucide-react';

import { SettleModal } from './SettleModal';
import { VoidModal } from './VoidModal';
import { DiscountModal } from './DiscountModal';

import {
  useOrder,
  useMenuCategories,
  useMenuItems,
  useAddOrderItems,
  useUpdateOrderItem,
  useSendOrderToKitchen,
  useCancelOrder,
  deriveTabState,
  type OrderItemRow,
  type MenuItem,
} from '@/lib/api';
import { formatNPR } from '@/components/Money';
import { EmptyState } from '@/components/EmptyState';
import { useConfirm } from '@/components/ConfirmDialog';
import { toast } from '@/lib/toast';

export function TabPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const order = useOrder(orderId);
  const cats = useMenuCategories();
  const items = useMenuItems();
  const addItems = useAddOrderItems();
  const updateItem = useUpdateOrderItem();
  const send = useSendOrderToKitchen();
  const cancel = useCancelOrder();
  const confirm = useConfirm();
  const nav = useNavigate();

  const [activeCat, setActiveCat] = useState<string | 'all'>('all');
  const [showSettle, setShowSettle] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; name: string; alreadySent: boolean } | null>(null);

  if (order.isPending) {
    return <div className="empty-state">loading tab…</div>;
  }
  if (order.isError) {
    return (
      <div className="empty-state">
        couldn't load this tab.
        <br />
        <button type="button" className="btn" onClick={() => nav('/admin/floor')}>
          back to floor
        </button>
      </div>
    );
  }
  if (!order.data) return null;
  const o = order.data;

  const filtered: MenuItem[] =
    activeCat === 'all' ? items.data ?? [] : (items.data ?? []).filter((i) => i.category_id === activeCat);

  const pending = (o.items ?? []).filter((i) => i.kitchen_status === 'pending' && !i.voided_at);
  const live = o.items ?? [];

  const onAdd = (mi: MenuItem) => {
    if (!orderId) return;
    addItems.mutate(
      { orderId, items: [{ menu_item_id: mi.id, qty: 1 }] },
      {
        onSuccess: () => toast.success(`Added ${mi.name}`, formatNPR(mi.price_cents)),
        onError: (e) => toast.error('Could not add', e.message),
      },
    );
  };

  const onCancelTab = async () => {
    if (!orderId) return;
    const ok = await confirm({
      title: 'Cancel this tab?',
      message:
        'Cancels the open tab and frees the table. Only allowed when nothing has been sent to the kitchen.',
      confirmLabel: 'Cancel tab',
      cancelLabel: 'Keep tab',
      danger: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(orderId);
      toast.info('Tab cancelled');
      nav('/admin/floor', { replace: true });
    } catch (e: unknown) {
      toast.error('Cannot cancel', (e as { message?: string }).message);
    }
  };

  const onSend = () => {
    if (!orderId) return;
    send.mutate(orderId, {
      onSuccess: (data) =>
        toast.success(
          `${data.sent} item${data.sent === 1 ? '' : 's'} sent to kitchen`,
          'cooks notified',
        ),
      onError: (e) => toast.error('Could not send', e.message),
    });
  };

  return (
    <div className="tab-shell">
      <div className="tab-left">
        <div className="topbar" style={{ marginBottom: 16 }}>
          <div>
            <button type="button" className="btn" onClick={() => nav('/admin/floor')}>
              <ArrowLeft size={14} strokeWidth={1.5} /> Floor
            </button>
          </div>
          <div className="actions">
            <span className="meta-line">menu</span>
          </div>
        </div>

        <div className="filter-row">
          <button
            type="button"
            className={`chip ${activeCat === 'all' ? 'active' : ''}`}
            onClick={() => setActiveCat('all')}
          >
            All
          </button>
          {(cats.data ?? []).map((c) => (
            <button
              type="button"
              key={c.id}
              className={`chip ${activeCat === c.id ? 'active' : ''}`}
              onClick={() => setActiveCat(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div className="menu-grid">
          {filtered.length === 0 && (
            <EmptyState
              compact
              icon={<Coffee size={32} strokeWidth={1.4} style={{ color: 'var(--amber-fg)' }} />}
              title="nothing here yet"
              hint="this category has no active items. add some in admin · menu."
            />
          )}
          {filtered.map((i) => (
            <button
              type="button"
              key={i.id}
              className="menu-card"
              onClick={() => onAdd(i)}
              disabled={!i.is_active || addItems.isPending}
            >
              <div className="mc-name">{i.name}</div>
              {i.description && <div className="mc-desc">{i.description}</div>}
              <div className="mc-price">{formatNPR(i.price_cents)}</div>
            </button>
          ))}
        </div>
      </div>

      <aside className="tab-right">
        <div className="tab-head">
          <div>
            <span className="eyebrow">tab</span>
            <h2 className="tab-title">{o.service_table_name ?? 'Take-away'}</h2>
            <div className="tab-meta">
              opened {new Date(o.opened_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {o.status}
            </div>
            {(() => {
              const s = deriveTabState(o);
              if (!s) return null;
              return (
                <div className={`ft-state ft-state--${s.tone}`} title={s.hint} style={{ marginTop: 8 }}>
                  {s.label}
                </div>
              );
            })()}
          </div>
        </div>

        <div className="tab-items">
          {live.length === 0 && (
            <EmptyState
              compact
              emoji="👆"
              title="empty tab"
              hint="tap any menu item on the left to start."
            />
          )}
          {live.map((it) => (
            <LineRow
              key={it.id}
              it={it}
              onQty={(delta) => {
                if (!orderId) return;
                if (it.voided_at) return;
                if (it.kitchen_status !== 'pending') {
                  alert('Already with the kitchen — void it instead.');
                  return;
                }
                const next = it.qty + delta;
                if (next <= 0) return;
                void updateItem.mutateAsync({ orderId, itemId: it.id, patch: { qty: next } });
              }}
              onVoid={() => {
                if (it.voided_at) return;
                setVoidTarget({
                  id: it.id,
                  name: it.menu_item_name,
                  alreadySent: it.kitchen_status !== 'pending',
                });
              }}
            />
          ))}
        </div>

        <div className="tab-totals">
          <div className="tt-row">
            <span>subtotal</span>
            <strong>{formatNPR(o.live_subtotal_cents)}</strong>
          </div>
          <div className="tt-hint">
            VAT &amp; service charge applied at checkout
          </div>
        </div>

        <div className="tab-actions">
          {pending.length > 0 ? (
            <button
              type="button"
              className="btn primary"
              disabled={send.isPending}
              onClick={onSend}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <Send size={14} strokeWidth={1.5} />
              Send {pending.length} to kitchen
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={live.length === 0 || live.every((i) => i.voided_at)}
              onClick={() => setShowSettle(true)}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <Receipt size={14} strokeWidth={1.5} />
              Settle tab
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => setShowDiscount(true)}
            title="Discount"
            disabled={live.length === 0}
          >
            <Percent size={14} strokeWidth={1.5} />
          </button>
          <button type="button" className="btn danger" onClick={onCancelTab} title="Cancel tab">
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </aside>

      {orderId && (
        <>
          <SettleModal
            open={showSettle}
            orderId={orderId}
            onClose={() => setShowSettle(false)}
            onClosed={() => {
              setShowSettle(false);
              nav('/admin/floor', { replace: true });
            }}
          />
          <DiscountModal
            open={showDiscount}
            orderId={orderId}
            onClose={() => setShowDiscount(false)}
          />
          <VoidModal
            orderId={orderId}
            itemId={voidTarget?.id ?? null}
            itemName={voidTarget?.name ?? ''}
            alreadySent={voidTarget?.alreadySent ?? false}
            onClose={() => setVoidTarget(null)}
          />
        </>
      )}
    </div>
  );
}

function LineRow({
  it,
  onQty,
  onVoid,
}: {
  it: OrderItemRow;
  onQty: (delta: number) => void;
  onVoid: () => void;
}) {
  const voided = !!it.voided_at;
  return (
    <div className={`line ${voided ? 'voided' : ''}`}>
      <div className="line-name">
        <strong>{it.menu_item_name}</strong>
        {it.notes && <div className="line-note">{it.notes}</div>}
        <div className="line-status">
          <span className={`pill ${kitchenPillClass(it.kitchen_status, voided)}`}>
            {voided ? 'voided' : it.kitchen_status.replace('_', ' ')}
          </span>
          {voided && it.void_reason && <span className="void-reason">— {it.void_reason}</span>}
        </div>
      </div>
      <div className="line-qty">
        <button type="button" className="btn icon" onClick={() => onQty(-1)} disabled={voided || it.kitchen_status !== 'pending'} aria-label="decrease">
          −
        </button>
        <span style={{ minWidth: 18, textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{it.qty}</span>
        <button type="button" className="btn icon" onClick={() => onQty(1)} disabled={voided || it.kitchen_status !== 'pending'} aria-label="increase">
          <Plus size={12} strokeWidth={1.5} />
        </button>
      </div>
      <div className="line-amt">{formatNPR(it.line_cents)}</div>
      {!voided && (
        <button type="button" className="btn icon danger" onClick={onVoid} aria-label="void">
          <X size={12} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

function kitchenPillClass(s: string, voided: boolean): string {
  if (voided) return 'bad';
  if (s === 'ready' || s === 'served') return 'ok';
  if (s === 'in_progress') return 'warn';
  return '';
}
