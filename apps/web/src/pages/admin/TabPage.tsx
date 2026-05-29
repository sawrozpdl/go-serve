import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowLeftRight,
  Plus,
  Send,
  X,
  Trash2,
  Receipt,
  Percent,
  Coffee,
  ChevronDown,
  ChevronUp,
  StickyNote,
  Flame,
} from 'lucide-react';

import { SettleModal } from './SettleModal';
import { VoidModal } from './VoidModal';
import { DiscountModal } from './DiscountModal';
import { MoveTableModal } from './MoveTableModal';

import {
  useOrder,
  useMenuCategories,
  useMenuItems,
  usePopularMenuItems,
  useAddOrderItems,
  useUpdateOrderItem,
  useSendOrderToKitchen,
  useCancelOrder,
  useOrderAdjustments,
  useSettleQuote,
  useTenantSettings,
  useVoidOrderItem,
  deriveTabState,
  isTempItemId,
  type OrderItemRow,
  type MenuItem,
  type Order,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { formatNPR } from '@/components/Money';
import { EmptyState } from '@/components/EmptyState';
import { RefreshButton } from '@/components/RefreshButton';
import { useConfirm } from '@/components/ConfirmDialog';
import { IconGlyph } from '@/components/IconPicker';
import { toast } from '@/lib/toast';

export function TabPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { slug } = useTenant();
  const qc = useQueryClient();
  const order = useOrder(orderId);
  const cats = useMenuCategories();
  const items = useMenuItems();
  const popular = usePopularMenuItems(12);
  const addItems = useAddOrderItems();
  const updateItem = useUpdateOrderItem();
  const send = useSendOrderToKitchen();
  const cancel = useCancelOrder();
  const voidItem = useVoidOrderItem();
  const confirm = useConfirm();
  const tenant = useTenantSettings();
  const adjustments = useOrderAdjustments(orderId);
  // Live total with vat + service charge — drives the bottom "amount summary"
  // strip so a cashier never has to scroll to see what to collect.
  const quote = useSettleQuote(orderId);
  const nav = useNavigate();

  // Per-menu-item promise chains. Each tap appends to its item's chain so
  // rapid taps are applied strictly in sequence — a fast triple-tap becomes a
  // single "×3" line instead of racing into duplicate rows. Reset per tab.
  const addChains = useRef<Map<string, Promise<void>>>(new Map());
  const tempSeq = useRef(0);
  useEffect(() => {
    addChains.current = new Map();
  }, [orderId]);

  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [showSettle, setShowSettle] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; name: string; alreadySent: boolean } | null>(null);
  // Mobile: tab summary is collapsed by default behind a count chip so the
  // waiter sees more of the menu on phones. Tapping the chip expands it.
  const [tabOpen, setTabOpen] = useState(false);
  // Pre-confirmation panel — shown after "Send to kitchen" tap, before the
  // request fires. Lets the cashier sanity-check what's about to be cooked.
  const [confirmingSend, setConfirmingSend] = useState(false);

  // Default to the Popular pseudo-category once it has anything to show; fall
  // back to the first real category otherwise. Empty popular row → skip to a
  // real category so the menu pane is never blank.
  useEffect(() => {
    if (activeCat) return;
    if ((popular.data?.length ?? 0) > 0) {
      setActiveCat('__popular__');
      return;
    }
    const first = cats.data?.[0];
    if (first) setActiveCat(first.id);
  }, [activeCat, cats.data, popular.data]);

  // Counts of unsent items on this tab — by category (drives the chip badge)
  // and by individual menu item (drives the card badge + selected highlight).
  // Memo lives ABOVE the early returns — React's hook order can't depend on
  // whether the order has loaded yet.
  const { pendingByCat, pendingByItem } = useMemo(() => {
    const byCat = new Map<string, number>();
    const byItem = new Map<string, number>();
    const itemById = new Map<string, MenuItem>();
    for (const i of items.data ?? []) itemById.set(i.id, i);
    for (const it of order.data?.items ?? []) {
      if (it.voided_at) continue;
      if (it.kitchen_status !== 'pending') continue;
      const mi = itemById.get(it.menu_item_id);
      if (!mi) continue;
      byCat.set(mi.category_id, (byCat.get(mi.category_id) ?? 0) + it.qty);
      byItem.set(it.menu_item_id, (byItem.get(it.menu_item_id) ?? 0) + it.qty);
    }
    return { pendingByCat: byCat, pendingByItem: byItem };
  }, [items.data, order.data?.items]);

  if (order.isPending) {
    return <div className="empty-state">Loading tab…</div>;
  }
  if (order.isError) {
    return (
      <div className="empty-state">
        Couldn't load this tab.
        <br />
        <button type="button" className="btn" onClick={() => nav('/admin/floor')}>
          Back to floor
        </button>
      </div>
    );
  }
  if (!order.data) return null;
  const o = order.data;

  const filtered: MenuItem[] =
    activeCat === '__popular__'
      ? popular.data ?? []
      : activeCat
        ? (items.data ?? []).filter((i) => i.category_id === activeCat)
        : items.data ?? [];

  // Hide unsent voids — a "voided pending" line is conceptually a draft the
  // cashier dropped before it ever reached the kitchen. The audit row still
  // exists; we just don't clutter the tab with it.
  const visibleLines = (o.items ?? []).filter(
    (i) => !(i.voided_at && (i.kitchen_status === 'pending' || !i.sent_to_kitchen_at)),
  );
  const pending = visibleLines.filter((i) => i.kitchen_status === 'pending' && !i.voided_at);
  const pendingQty = pending.reduce((sum, i) => sum + i.qty, 0);

  // One step of the add chain. Reads the *current* cached tab (kept correct by
  // the preceding awaited optimistic mutation) and either bumps a stackable
  // pending line or creates a fresh one. forceNew skips stacking entirely.
  const addOne = async (mi: MenuItem, forceNew: boolean) => {
    if (!orderId) return;
    const cached = qc.getQueryData<Order>(['order', slug, orderId]);
    const line = forceNew
      ? undefined
      : (cached?.items ?? []).find(
          (it) =>
            it.menu_item_id === mi.id &&
            it.kitchen_status === 'pending' &&
            !it.voided_at &&
            // Only stack onto lines with no notes — a noted line is a distinct
            // preparation (e.g. "less sugar"); stacking would lose that. Temp
            // (optimistic) rows are skipped — they have no server id yet.
            !it.notes &&
            !isTempItemId(it.id),
        );
    if (line) {
      await updateItem.mutateAsync({ orderId, itemId: line.id, patch: { qty: line.qty + 1 } });
      toast.success(`${mi.name} ×${line.qty + 1}`, formatNPR(mi.price_cents));
    } else {
      const tempId = `temp:${mi.id}:${(tempSeq.current += 1)}`;
      await addItems.mutateAsync({
        orderId,
        items: [{ menu_item_id: mi.id, qty: 1 }],
        optimistic: { tempId, menu_item_name: mi.name, unit_price_cents: mi.price_cents },
      });
      toast.success(`Added ${mi.name}`, formatNPR(mi.price_cents));
    }
  };

  const onAdd = (mi: MenuItem) => {
    if (!orderId) return;
    // Stackable items collapse into one line; off → always a new line. Either
    // way, taps are serialised through the per-item chain so the count is
    // correct no matter how fast the cashier taps.
    const stack = tenant.data?.preferences?.stackItems ?? true;
    const prev = addChains.current.get(mi.id) ?? Promise.resolve();
    const next = prev
      .then(() => addOne(mi, !stack))
      .catch((e: unknown) => {
        toast.error('Could not add', (e as { message?: string }).message);
      });
    addChains.current.set(mi.id, next);
  };

  const onNotes = (itemId: string, notes: string) => {
    if (!orderId) return;
    updateItem.mutate(
      { orderId, itemId, patch: { notes } },
      { onError: (e) => toast.error("Couldn't save note", e.message) },
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

  const doSend = () => {
    if (!orderId) return;
    send.mutate(orderId, {
      onSuccess: (data) => {
        setConfirmingSend(false);
        toast.success(
          `${data.sent} item${data.sent === 1 ? '' : 's'} sent to kitchen`,
          'cooks notified',
        );
      },
      onError: (e) => toast.error('Could not send', e.message),
    });
  };

  return (
    <div className={`tab-shell${tabOpen ? ' tab-open' : ''}`}>
      <div className="tab-left">
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <button type="button" className="btn" onClick={() => nav('/admin/floor')}>
              <ArrowLeft size={14} strokeWidth={1.5} /> Floor
            </button>
          </div>
          <div className="actions">
            <span className="meta-line">{o.service_table_name ?? 'Take-away'}</span>
            <RefreshButton
              onClick={() =>
                Promise.all([order.refetch(), adjustments.refetch(), quote.refetch()])
              }
              busy={order.isFetching || adjustments.isFetching || quote.isFetching}
              label="Refresh tab"
            />
          </div>
        </div>

        <div className="filter-row">
          {(popular.data?.length ?? 0) > 0 && (
            <button
              type="button"
              key="__popular__"
              className={`chip ${activeCat === '__popular__' ? 'active' : ''}`}
              onClick={() => setActiveCat('__popular__')}
              title="Frequently used items (last 30 days)"
            >
              <Flame size={12} strokeWidth={1.6} style={{ verticalAlign: '-1px', marginRight: 4 }} />
              Popular
            </button>
          )}
          {(cats.data ?? []).map((c) => {
            const n = pendingByCat.get(c.id) ?? 0;
            return (
              <button
                type="button"
                key={c.id}
                className={`chip ${activeCat === c.id ? 'active' : ''}`}
                onClick={() => setActiveCat(c.id)}
              >
                {c.icon && (
                  <IconGlyph
                    name={c.icon}
                    color={c.color || undefined}
                    size={12}
                    className="chip-icon"
                  />
                )}
                {c.name}
                {n > 0 && <span className="chip-count">{n}</span>}
              </button>
            );
          })}
        </div>

        <div className="menu-grid">
          {filtered.length === 0 && (
            <EmptyState
              compact
              icon={<Coffee size={32} strokeWidth={1.4} style={{ color: 'var(--amber-fg)' }} />}
              title="Nothing here yet"
              hint="This category has no active items. Add some in Admin · Menu."
            />
          )}
          {filtered.map((i) => {
            const n = pendingByItem.get(i.id) ?? 0;
            return (
              <button
                type="button"
                key={i.id}
                className={`menu-card ${n > 0 ? 'selected' : ''}`}
                onClick={() => onAdd(i)}
                disabled={!i.is_active}
              >
                <div className="mc-head">
                  <span className="mc-name">
                    {i.icon && (
                      <IconGlyph
                        name={i.icon}
                        size={14}
                        className="mc-icon"
                      />
                    )}
                    {i.name}
                  </span>
                  <span className="mc-price">{formatNPR(i.price_cents)}</span>
                </div>
                {i.description && <div className="mc-desc">{i.description}</div>}
                {n > 0 && <span className="mc-count">×{n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <aside className="tab-right">
        {/* Mobile-only summary header — tap to expand the line list. Shows the
         * live total (with vat + service) so the cashier sees the final number
         * without scrolling. Falls back to the subtotal until the quote loads. */}
        <button
          type="button"
          className="tab-mobile-toggle"
          onClick={() => setTabOpen((v) => !v)}
          aria-expanded={tabOpen}
          aria-controls="tab-summary-body"
        >
          <span className="tmt-title">
            <span className="tmt-eyebrow">Total</span>
            <span className="tmt-rows">
              <span className="tmt-name">{o.service_table_name ?? 'Take-away'}</span>
              <span className="tmt-meta">
                {visibleLines.length} line{visibleLines.length === 1 ? '' : 's'}
                {pendingQty > 0 && <span className="pill warn">{pendingQty} Not Sent</span>}
              </span>
            </span>
          </span>
          <span className="tmt-totals">
            <strong>
              {formatNPR(quote.data?.total_cents ?? o.live_subtotal_cents)}
            </strong>
            {tabOpen ? <ChevronUp size={14} strokeWidth={1.6} /> : <ChevronDown size={14} strokeWidth={1.6} />}
          </span>
        </button>

        <div className="tab-head">
          <div>
            <span className="eyebrow">Tab</span>
            <h2 className="tab-title">{o.service_table_name ?? 'Take-away'}</h2>
            <div className="tab-meta">
              Opened {new Date(o.opened_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {o.status.charAt(0).toUpperCase() + o.status.slice(1)}
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

        <div className="tab-items" id="tab-summary-body">
          {visibleLines.length === 0 && (
            <EmptyState
              compact
              emoji="👆"
              title="Empty tab"
              hint="Tap any menu item on the left to start."
            />
          )}
          {visibleLines.map((it) => {
            const mi = (items.data ?? []).find((m) => m.id === it.menu_item_id);
            return (
              <LineRow
                key={it.id}
                it={it}
                presets={mi?.preset_notes ?? []}
                onQty={(delta) => {
                  if (!orderId) return;
                  if (it.voided_at) return;
                  // Optimistic line awaiting its server id — ignore edits until
                  // the add settles (a follow-up tap stacks onto it anyway).
                  if (isTempItemId(it.id)) return;
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
                  if (!orderId) return;
                  if (isTempItemId(it.id)) return;
                  // Pre-kitchen lines vanish with one tap — no modal, no
                  // reason required. The backend treats a pending void as a
                  // friction-free correction (kitchen hasn't seen it yet).
                  // Anything already sent still routes through VoidModal so
                  // we capture a reason + approver for the audit trail.
                  if (it.kitchen_status === 'pending') {
                    voidItem.mutate(
                      { orderId, itemId: it.id, reason: '' },
                      { onError: (e) => toast.error("Couldn't remove", e.message) },
                    );
                    return;
                  }
                  setVoidTarget({
                    id: it.id,
                    name: it.menu_item_name,
                    alreadySent: true,
                  });
                }}
                onNotes={(notes) => onNotes(it.id, notes)}
              />
            );
          })}
        </div>

        <div className="tab-totals">
          <div className="tt-row">
            <span>Subtotal</span>
            <strong>{formatNPR(o.live_subtotal_cents)}</strong>
          </div>
          {(() => {
            const discount = (adjustments.data ?? [])
              .filter((a) => a.type === 'discount')
              .reduce((sum, a) => sum + a.amount_cents, 0);
            if (discount <= 0) {
              return (
                <div className="tt-hint">
                  VAT &amp; service charge applied at checkout
                </div>
              );
            }
            const afterDiscount = Math.max(0, o.live_subtotal_cents - discount);
            return (
              <>
                <div className="tt-row tt-row--accent">
                  <span>Discount applied</span>
                  <strong>−{formatNPR(discount)}</strong>
                </div>
                <div className="tt-row tt-row--final">
                  <span>After discount</span>
                  <strong>{formatNPR(afterDiscount)}</strong>
                </div>
                <div className="tt-hint">
                  VAT &amp; service charge applied at checkout
                </div>
              </>
            );
          })()}
        </div>

        <div className="tab-actions">
          {pending.length > 0 ? (
            <button
              type="button"
              className="btn primary"
              disabled={send.isPending}
              onClick={() => setConfirmingSend(true)}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <Send size={14} strokeWidth={1.5} />
              Send {pending.length} to kitchen
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={visibleLines.length === 0 || visibleLines.every((i) => i.voided_at)}
              onClick={() => setShowSettle(true)}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <Receipt size={14} strokeWidth={1.5} />
              Settle tab
            </button>
          )}
          {/* Only show standalone discount button when the tenant uses the
           * split flow — the combined settle modal already exposes it inline. */}
          {!tenant.data?.preferences?.combinedSettle && (
            <button
              type="button"
              className="btn"
              onClick={() => setShowDiscount(true)}
              data-tip="discount"
              title="Discount"
              disabled={visibleLines.length === 0}
            >
              <Percent size={14} strokeWidth={1.5} />
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => setShowMove(true)}
            data-tip="move / merge"
            title="Move to another table or merge"
          >
            <ArrowLeftRight size={14} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={onCancelTab}
            data-tip="cancel tab"
            title="Cancel tab"
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </aside>

      {confirmingSend && (
        <PreSendModal
          pending={pending}
          menuItems={items.data ?? []}
          onClose={() => setConfirmingSend(false)}
          onSend={doSend}
          onNotes={onNotes}
          sending={send.isPending}
        />
      )}

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
          <MoveTableModal
            open={showMove}
            orderId={orderId}
            currentTableId={o.service_table_id ?? null}
            onClose={() => setShowMove(false)}
            onMoved={(resultId, merged) => {
              setShowMove(false);
              // A merge retires this tab into another order — follow the
              // combined tab. A plain transfer/detach keeps the same id.
              if (merged && resultId !== orderId) {
                nav(`/admin/floor/${resultId}`, { replace: true });
              }
            }}
          />
        </>
      )}
    </div>
  );
}

function LineRow({
  it,
  presets,
  onQty,
  onVoid,
  onNotes,
}: {
  it: OrderItemRow;
  presets: string[];
  onQty: (delta: number) => void;
  onVoid: () => void;
  onNotes: (notes: string) => void;
}) {
  const voided = !!it.voided_at;
  const editable = !voided && it.kitchen_status === 'pending';
  // Inline note editor is heavy (chips + input). Default to collapsed so a
  // long tab list stays scannable on mobile; expand on tap. Auto-expand if
  // a note already exists so the cashier sees it.
  const [showNotes, setShowNotes] = useState(!!it.notes);
  return (
    <div className={`line ${voided ? 'voided' : ''}`}>
      <div className="line-row">
        <div className="line-name">
          <strong>{it.menu_item_name}</strong>
          {!editable && it.notes && <div className="line-note">{it.notes}</div>}
          <div className="line-status">
            <span className={`pill ${kitchenPillClass(it.kitchen_status, voided)}`}>
              {voided ? 'voided' : it.kitchen_status.replace('_', ' ')}
            </span>
            {voided && it.void_reason && <span className="void-reason">— {it.void_reason}</span>}
          </div>
        </div>
        <div className="line-qty">
          <button
            type="button"
            className="btn icon"
            onClick={() => onQty(-1)}
            disabled={!editable}
            aria-label="decrease"
          >
            −
          </button>
          <span
            style={{ minWidth: 18, textAlign: 'center', fontFamily: 'var(--font-mono)' }}
          >
            {it.qty}
          </span>
          <button
            type="button"
            className="btn icon"
            onClick={() => onQty(1)}
            disabled={!editable}
            aria-label="increase"
          >
            <Plus size={12} strokeWidth={1.5} />
          </button>
        </div>
        <div className="line-amt">{formatNPR(it.line_cents)}</div>
        {editable && (
          <button
            type="button"
            className={`btn icon line-note-toggle${showNotes || it.notes ? ' active' : ''}`}
            onClick={() => setShowNotes((v) => !v)}
            aria-label="Note"
            title="Note"
          >
            <StickyNote size={12} strokeWidth={1.6} />
          </button>
        )}
        {!voided && (
          <button type="button" className="btn icon danger" onClick={onVoid} aria-label="void">
            <X size={12} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {editable && showNotes && (
        <NoteField presets={presets} value={it.notes} onSave={onNotes} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NoteField — inline editable note for a pending line. Saves on blur (or
// preset tap) via the existing PATCH /orders/:id/items/:itemId endpoint,
// which is server-side gated to pending-only. Preset chips (configured per
// menu item) show under the input as one-tap fillers; tapping a chip both
// fills the input and triggers the save. Hidden after the line is sent —
// the waiter must void + re-add to change kitchen-bound notes.
// ---------------------------------------------------------------------------

function NoteField({
  presets,
  value,
  onSave,
}: {
  presets: string[];
  value: string;
  onSave: (notes: string) => void;
}) {
  const [text, setText] = useState(value);
  // Keep local state in sync when the server-returned notes change (e.g.
  // another device updated this line). Don't stomp the field while the user
  // is actively typing — we track focus to decide.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  const commit = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === (value ?? '').trim()) return;
    onSave(trimmed);
  };

  return (
    <div className="line-note-edit">
      <input
        className="line-note-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setText(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Add note · less sugar, no ice…"
        aria-label="Note"
      />
      {presets.length > 0 && (
        <div className="line-note-presets">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className={`mini-chip ${text === p ? 'active' : ''}`}
              onClick={() => {
                setText(p);
                commit(p);
              }}
            >
              {p}
            </button>
          ))}
        </div>
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

// ---------------------------------------------------------------------------
// Pre-send confirmation — gives the cashier a final read of what's about to
// be wired to the kitchen, useful in busy moments where lines get added in
// a hurry. Tapping outside or hitting cancel returns to the picker without
// dispatching.
// ---------------------------------------------------------------------------

function PreSendModal({
  pending,
  menuItems,
  onSend,
  onClose,
  onNotes,
  sending,
}: {
  pending: OrderItemRow[];
  menuItems: MenuItem[];
  onSend: () => void;
  onClose: () => void;
  onNotes: (itemId: string, notes: string) => void;
  sending: boolean;
}) {
  const total = pending.reduce((sum, i) => sum + i.line_cents, 0);
  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <div className="modal-head">
          <h3>confirm send.</h3>
          <div className="sub">last chance for notes — kitchen sees what you confirm</div>
        </div>
        <div className="modal-body">
          <div className="presend-list">
            {pending.map((p) => {
              const mi = menuItems.find((m) => m.id === p.menu_item_id);
              return (
                <div key={p.id} className="presend-row">
                  <div className="presend-top">
                    <strong>{p.menu_item_name}</strong>
                    <span className="presend-qty">×{p.qty}</span>
                    <span className="presend-amt">{formatNPR(p.line_cents)}</span>
                  </div>
                  <NoteField
                    presets={mi?.preset_notes ?? []}
                    value={p.notes}
                    onSave={(notes) => onNotes(p.id, notes)}
                  />
                </div>
              );
            })}
          </div>

          <div className="settle-row bold" style={{ marginTop: 12 }}>
            <span>Going to kitchen</span>
            <span className="num">{formatNPR(total)}</span>
          </div>

          <div className="modal-actions" style={{ marginTop: 18 }}>
            <button type="button" className="btn" onClick={onClose} disabled={sending}>
              Back
            </button>
            <button type="button" className="btn primary" onClick={onSend} disabled={sending}>
              <Send size={14} strokeWidth={1.5} />
              {sending ? 'Sending…' : 'Confirm send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
