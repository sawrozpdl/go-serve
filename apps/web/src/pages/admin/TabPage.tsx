import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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
  CloudOff,
  Printer,
  Pencil,
} from 'lucide-react';

import { SettleModal } from './SettleModal';
import { VoidModal } from './VoidModal';
import { DiscountModal } from './DiscountModal';
import { MoveTableModal } from './MoveTableModal';

import {
  useOrder,
  useMenuCategories,
  useMenuItems,
  useOutlets,
  usePopularMenuItems,
  useOpenOrder,
  useAddOrderItems,
  useUpdateOrderItem,
  useSendOrderToKitchen,
  useCancelOrder,
  useRenameOrder,
  useOrderAdjustments,
  useSettleQuote,
  useTenantSettings,
  useVoidOrderItem,
  deriveTabState,
  resolveTableLabel,
  isUnconfirmedItemId,
  resolveKitchenBehavior,
  resolveOutlet,
  formatQty,
  type OrderItemRow,
  type MenuItem,
  type Order,
} from '@/lib/api';
import { useConnectivity } from '@/lib/connectivity';
import { usePosScale } from '@/lib/uiScale';
import { printKitchenDocket, getDeviceRole, deviceHandlesOutlet, receiptWidthOf } from '@/lib/printing';
import { useQueuedOpsForOrder, queuedLineIds } from '@/lib/offline-queue';
import { useTenant } from '@/lib/tenant';
import { useIsMobile } from '@/lib/useIsMobile';
import { formatNPR } from '@/components/Money';
import { EmptyState } from '@/components/EmptyState';
import { RefreshButton } from '@/components/RefreshButton';
import { useConfirm } from '@/components/ConfirmDialog';
import { IconGlyph } from '@/components/IconPicker';
import { toast } from '@/lib/toast';
import { usePermissions } from '@/lib/permissions';

export function TabPage() {
  const { orderId } = useParams<{ orderId: string }>();
  // Draft mode: route is /floor/new, no order exists yet. The order row is
  // created lazily on the first item add (see ensureOrderId). The target table
  // (if any) rides in via router state from the floor tile that was tapped.
  const isDraft = !orderId;
  const location = useLocation();
  const draftTable = (location.state as { tableId?: string; tableName?: string } | null) ?? null;

  const { slug } = useTenant();
  const qc = useQueryClient();
  const { factor: posScale } = usePosScale();
  const order = useOrder(orderId);
  const cats = useMenuCategories();
  const items = useMenuItems();
  const outlets = useOutlets();
  const popular = usePopularMenuItems(12);
  const openOrder = useOpenOrder();
  const addItems = useAddOrderItems();
  const updateItem = useUpdateOrderItem();
  const send = useSendOrderToKitchen();
  const cancel = useCancelOrder();
  const rename = useRenameOrder();
  const voidItem = useVoidOrderItem();
  const confirm = useConfirm();
  const tenant = useTenantSettings();
  const adjustments = useOrderAdjustments(orderId);
  // Live total with vat + service charge — drives the bottom "amount summary"
  // strip so a cashier never has to scroll to see what to collect.
  const quote = useSettleQuote(orderId);
  const nav = useNavigate();
  // On phones the split layout stacks into one column, so the tab name is shown
  // in a single, prominent, editable spot in the topbar instead of repeating in
  // the summary bar and tab head. Match the 900px layout breakpoint.
  const isMobile = useIsMobile('(max-width: 900px)');

  // Permission-derived capability flags for this tab. Each control below is
  // shown only when the active member actually holds the matching grant, so a
  // waiter (add + send) never sees settle/void/discount/cancel, etc.
  const { can } = usePermissions();
  const canAddItems = can('order:add_items');
  const canEditItems = can('order:update_item');
  const canVoidItems = can('order:void_item');
  const canSendKitchen = can('order:send_kitchen');
  const canSettle = can('order:settle');
  const canDiscount = can('adjustment:apply');
  const canMoveTab = can('order:create');
  const canCancelTab = can('order:cancel');

  // Per-menu-item promise chains. Each tap appends to its item's chain so
  // rapid taps are applied strictly in sequence — a fast triple-tap becomes a
  // single "×3" line instead of racing into duplicate rows. Reset per tab.
  const addChains = useRef<Map<string, Promise<void>>>(new Map());
  // Draft-tab order creation, shared across menu items. The per-item addChains
  // only serialise taps of the SAME item, so two different items tapped at once
  // could each try to create the order — this single in-flight promise ensures
  // exactly one POST /orders and every first-add awaits the same id.
  const ensureRef = useRef<Promise<string> | null>(null);
  useEffect(() => {
    addChains.current = new Map();
    ensureRef.current = null;
    setDraftLabel('');
  }, [orderId]);

  // Name typed for an as-yet-unpersisted walk-in tab. Held locally until the
  // first item add creates the order (carried through in ensureOrderId); once
  // persisted, renames go straight to the server via useRenameOrder.
  const [draftLabel, setDraftLabel] = useState('');

  // Offline state: adds/edits/voids/sends queue locally; money movement
  // (settle, discount, move, cancel) is blocked — it needs server truth.
  const { mode: connMode } = useConnectivity();
  const offline = connMode === 'offline';
  const queuedOps = useQueuedOpsForOrder(orderId);
  const syncPendingIds = useMemo(() => queuedLineIds(queuedOps), [queuedOps]);

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

  // Menu items that skip the cooking step (effective kitchen behaviour 'ready'
  // or 'serve', resolved item → category → tenant default). They never belong
  // on a cook docket, so we strip them from any ticket we print.
  const noCookItemIds = useMemo(() => {
    const catById = new Map((cats.data ?? []).map((c) => [c.id, c]));
    const prefs = tenant.data?.preferences;
    const s = new Set<string>();
    for (const i of items.data ?? []) {
      if (resolveKitchenBehavior(i, catById.get(i.category_id), prefs) !== 'cook') s.add(i.id);
    }
    return s;
  }, [items.data, cats.data, tenant.data?.preferences]);

  // A real (persisted) tab loads its order; a draft has none yet, so it skips
  // the load states and renders against a synthetic empty order below.
  if (!isDraft && order.isPending) {
    return <div className="empty-state">Loading tab…</div>;
  }
  if (!isDraft && order.isError) {
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
  // Synthetic empty order for the draft — nothing is persisted until the first
  // item add, so the right pane shows the empty-tab state and the menu works.
  const draftOrder: Order = {
    id: '',
    service_table_id: draftTable?.tableId ?? null,
    service_table_name: draftTable?.tableName ?? null,
    table_label: draftLabel,
    status: 'open',
    opened_by_user_id: '',
    opened_at: new Date().toISOString(),
    notes: '',
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    service_charge_cents: 0,
    total_cents: 0,
    live_subtotal_cents: 0,
    items: [],
    items_pending: 0,
    items_in_progress: 0,
    items_ready: 0,
    items_served: 0,
    items_total: 0,
    paid_cents: 0,
  };
  const o: Order = isDraft ? draftOrder : order.data!;
  if (!o) return null;
  // The tab's home table, surfaced into every order-action modal (and onto the
  // printed docket/receipt) so the cashier always knows which tab they're acting
  // on. A real table's name wins; a named walk-in shows its label; an unnamed one
  // reads "Walk-in" (kept consistent with the Floor/History labels).
  const tableLabel = resolveTableLabel(o, 'Walk-in');
  // A walk-in / "Unknown +" tab (no real table) can be named/renamed in place.
  // On a real table the registry name is authoritative, so no editor is shown.
  const canRenameTab = !o.service_table_id && canMoveTab;
  const onRenameTab = (name: string) => {
    if (isDraft || !orderId) {
      // Not persisted yet — stash the name; ensureOrderId sends it on create.
      setDraftLabel(name);
      return;
    }
    rename
      .mutateAsync({ orderId, table_label: name })
      .catch((e: unknown) => toast.error('Could not rename tab', (e as { message?: string }).message));
  };

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

  // Resolve the order id to add to, creating the order on first use for a
  // draft tab. The single shared in-flight promise (ensureRef) guarantees one
  // POST /orders even if several items are tapped before it lands; once created
  // we replace the /floor/new URL with the real id so reloads work and the rest
  // of the page (load, settle, modals) keys on a concrete order.
  const ensureOrderId = async (): Promise<string> => {
    if (orderId) return orderId;
    if (!ensureRef.current) {
      ensureRef.current = openOrder
        .mutateAsync({ service_table_id: draftTable?.tableId, table_label: draftLabel || undefined })
        .then((created) => {
          // Seed the detail cache so the newly-enabled useOrder(created.id)
          // reads it straight away instead of flashing "Loading tab…" on a
          // refetch. The optimistic add that follows patches this same entry.
          qc.setQueryData(['order', slug, created.id], created);
          nav(`/admin/floor/${created.id}`, { replace: true, state: null });
          return created.id;
        });
    }
    return ensureRef.current;
  };

  // One step of the add chain. Reads the *current* cached tab (kept correct by
  // the preceding awaited optimistic mutation) and either bumps a stackable
  // pending line or creates a fresh one. forceNew skips stacking entirely.
  const addOne = async (mi: MenuItem, forceNew: boolean) => {
    const id = await ensureOrderId();
    const cached = qc.getQueryData<Order>(['order', slug, id]);
    const line = forceNew
      ? undefined
      : (cached?.items ?? []).find(
          (it) =>
            it.menu_item_id === mi.id &&
            it.kitchen_status === 'pending' &&
            !it.voided_at &&
            // Only stack onto lines with no notes — a noted line is a distinct
            // preparation (e.g. "less sugar"); stacking would lose that. Lines
            // whose insert is still in flight (online) are skipped — a PATCH
            // against them would race the insert.
            !it.notes &&
            !isUnconfirmedItemId(it.id),
        );
    if (line) {
      await updateItem.mutateAsync({
        orderId: id,
        itemId: line.id,
        patch: { qty: line.qty + 1 },
        offlineLabel: `${mi.name} ×${line.qty + 1}`,
      });
      toast.success(`${mi.name} ×${line.qty + 1}`, formatNPR(mi.price_cents));
    } else {
      // The line id is born on the client: the server inserts it as-is (with
      // conflict-ignore), so offline replays and double-taps stay exactly-once
      // and the optimistic row never needs an id swap.
      await addItems.mutateAsync({
        orderId: id,
        items: [{ id: crypto.randomUUID(), menu_item_id: mi.id, qty: 1 }],
        optimistic: { menu_item_name: mi.name, unit_price_cents: mi.price_cents },
      });
      toast.success(`Added ${mi.name}`, formatNPR(mi.price_cents));
    }
  };

  const onAdd = (mi: MenuItem) => {
    // A draft tab can't be created while offline (POST /orders has no offline
    // path), so block the first add with a clear nudge instead of a failure.
    if (isDraft && offline) {
      toast.error('Reconnect to start a new tab', 'new tabs need a connection');
      return;
    }
    // Stackable items collapse into one line; off → always a new line. Either
    // way, taps are serialised through the per-item chain so the count is
    // correct no matter how fast the cashier taps. Stacking bumps an existing
    // line's qty (needs order:update_item); a member who can only add_items
    // gets a fresh line per tap instead of a 403.
    const stack = (tenant.data?.preferences?.stackItems ?? true) && canEditItems;
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
    // A draft has no order to cancel — backing out just returns to the floor;
    // nothing was ever persisted.
    if (!orderId) {
      nav('/admin/floor', { replace: true });
      return;
    }
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

  // Printing: a kitchen docket prints only when the workspace has it enabled
  // AND this device is configured as a kitchen-print station (localStorage
  // role) — otherwise every tablet listening to the tab would print a copy.
  const printPrefs = tenant.data?.preferences;
  const printWidth = receiptWidthOf(printPrefs?.receiptWidth);
  const kitchenPrintOn = !!printPrefs?.printingEnabled && !!printPrefs?.printKitchenTicket;
  // Cook-bound lines: drop voided + no-cook items (auto-ready / auto-serve)
  // from any ticket.
  const kitchenBound = (lines: OrderItemRow[]) =>
    lines.filter((it) => !it.voided_at && !noCookItemIds.has(it.menu_item_id));
  // Lines already in the kitchen's hands — the basis for a reprint.
  const sentToKitchen = kitchenBound(
    (o.items ?? []).filter(
      (i) => i.kitchen_status === 'in_progress' || i.kitchen_status === 'ready',
    ),
  );

  // Group cook-bound lines by their resolved prep outlet (item → category →
  // default) and print one docket per outlet, with the outlet name as the
  // station header. `respectRole` gates auto-print to the outlets this device
  // is configured for; a manual reprint prints every group to this device.
  const printDocketsByOutlet = (
    lines: OrderItemRow[],
    opts: { reprint?: boolean; respectRole?: boolean },
  ) => {
    if (lines.length === 0) return;
    const catById = new Map((cats.data ?? []).map((c) => [c.id, c]));
    const itemById = new Map((items.data ?? []).map((mi) => [mi.id, mi]));
    const role = getDeviceRole();
    const groups = new Map<string, OrderItemRow[]>();
    for (const it of lines) {
      const mi = itemById.get(it.menu_item_id);
      const outlet = resolveOutlet(mi, mi ? catById.get(mi.category_id) : undefined, outlets.data);
      const key = outlet?.id ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(it);
      else groups.set(key, [it]);
    }
    for (const [outletId, group] of groups) {
      if (opts.respectRole && !deviceHandlesOutlet(role, outletId)) continue;
      const outlet = outlets.data?.find((o) => o.id === outletId);
      printKitchenDocket({
        items: group,
        tableLabel,
        width: printWidth,
        station: outlet?.name?.toUpperCase(),
        reprint: opts.reprint,
      });
    }
  };

  const doSend = () => {
    if (!orderId) return;
    // Snapshot the cook-bound lines NOW: the success refetch flips them to
    // in_progress, so capturing after the mutation would lose the batch.
    const docket = kitchenBound(pending);
    send.mutate(orderId, {
      onSuccess: (data) => {
        setConfirmingSend(false);
        toast.success(
          `${data.sent} item${data.sent === 1 ? '' : 's'} sent to kitchen`,
          'cooks notified',
        );
        if (kitchenPrintOn && docket.length > 0) {
          printDocketsByOutlet(docket, { respectRole: true });
        }
      },
      onError: (e) => toast.error('Could not send', e.message),
    });
  };

  const reprintDocket = () => {
    if (sentToKitchen.length === 0) return;
    printDocketsByOutlet(sentToKitchen, { reprint: true });
  };

  return (
    <div
      className={`tab-shell${tabOpen ? ' tab-open' : ''}`}
      style={{ '--pos-scale': posScale } as CSSProperties}
    >
      <div className="tab-left">
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <button type="button" className="btn" onClick={() => nav('/admin/floor')}>
              <ArrowLeft size={14} strokeWidth={1.5} /> Floor
            </button>
          </div>
          <div className="actions">
            {isMobile ? (
              // Phone: the topbar is the single, prominent home for the tab name
              // — and the place to rename it. Reuses TabTitle (compact) so a
              // real table stays a plain name and a walk-in is click-to-edit.
              <TabTitle
                variant="compact"
                displayLabel={tableLabel}
                rawLabel={o.table_label ?? ''}
                editable={canRenameTab}
                onSave={onRenameTab}
              />
            ) : (
              <span className="meta-line">{tableLabel}</span>
            )}
            <RefreshButton
              onClick={() =>
                Promise.all([order.refetch(), adjustments.refetch(), quote.refetch()])
              }
              busy={order.isFetching || adjustments.isFetching || quote.isFetching}
              label="Refresh tab"
            />
          </div>
        </div>

        {/* Many categories overflow into several rows on a phone and push the
            menu grid down. Past 10 categories, switch to a two-row horizontally
            scrolling strip on phones (styling lives in the ≤720px block). */}
        <div className={`filter-row${(cats.data?.length ?? 0) > 10 ? ' filter-row--twoline' : ''}`}>
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
                    size={Math.round(15 * posScale)}
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
                disabled={!i.is_active || !canAddItems || (isDraft && offline)}
                aria-label={`Add ${i.name} — ${formatNPR(i.price_cents)}`}
              >
                <div className="mc-head">
                  <span className="mc-name">
                    {i.icon && (
                      <IconGlyph
                        name={i.icon}
                        size={Math.round(18 * posScale)}
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
              {/* Tab name lives in the topbar on mobile; the summary bar shows
                  only the total, line count, and pending state. */}
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
            {/* On mobile the name (and its editor) live in the topbar, so the
                head shows only the eyebrow, opened time, and state. */}
            {!isMobile && (
              <TabTitle
                displayLabel={tableLabel}
                rawLabel={o.table_label ?? ''}
                editable={canRenameTab}
                onSave={onRenameTab}
              />
            )}
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
                allowHalf={mi?.allow_half ?? false}
                canEdit={canEditItems}
                canVoid={canVoidItems}
                pendingSync={syncPendingIds.has(it.id)}
                onQty={(delta) => {
                  if (!orderId) return;
                  if (it.voided_at) return;
                  // Insert still in flight — ignore edits until it lands (a
                  // follow-up tap stacks onto it anyway).
                  if (isUnconfirmedItemId(it.id)) return;
                  if (it.kitchen_status !== 'pending') {
                    toast.info('Already with the kitchen', 'Void the line instead of editing it.');
                    return;
                  }
                  const next = it.qty + delta;
                  if (next <= 0) return;
                  void updateItem.mutateAsync({
                    orderId,
                    itemId: it.id,
                    patch: { qty: next },
                    offlineLabel: `${it.menu_item_name} ×${formatQty(next)}`,
                  });
                }}
                onVoid={() => {
                  if (it.voided_at) return;
                  if (!orderId) return;
                  if (isUnconfirmedItemId(it.id)) return;
                  // Pre-kitchen lines vanish with one tap — no modal, no
                  // reason required. The backend treats a pending void as a
                  // friction-free correction (kitchen hasn't seen it yet).
                  // Anything already sent still routes through VoidModal so
                  // we capture a reason + approver for the audit trail.
                  if (it.kitchen_status === 'pending') {
                    // Capture what's needed to restore the line before it's gone.
                    const restore = {
                      id: crypto.randomUUID(),
                      menu_item_id: it.menu_item_id,
                      qty: it.qty,
                      notes: it.notes || undefined,
                    };
                    voidItem.mutate(
                      { orderId, itemId: it.id, reason: '', offlineLabel: `Remove ${it.menu_item_name}` },
                      {
                        onError: (e) => toast.error("Couldn't remove", e.message),
                        onSuccess: () =>
                          // 1-tap removal gets a 1-tap recovery: re-adds the
                          // same item/qty/notes within the toast window.
                          toast.withAction(
                            'info',
                            `Removed ${formatQty(it.qty)}× ${it.menu_item_name}`,
                            {
                              label: 'Undo',
                              run: () =>
                                addItems.mutate(
                                  { orderId, items: [restore] },
                                  { onError: (e) => toast.error("Couldn't restore", e.message) },
                                ),
                            },
                          ),
                      },
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
            // Only promise checkout charges the tenant actually levies — a
            // cafe with neither VAT nor service charge shouldn't warn about
            // them. Inclusive VAT is already in the price, so it reads as a
            // statement, not a charge added at checkout.
            const vatMode = tenant.data?.vat_mode ?? 'none';
            const vatOn = vatMode !== 'none' && parseFloat(tenant.data?.vat_pct ?? '0') > 0;
            const svc = parseFloat(tenant.data?.service_charge_pct ?? '0') > 0;
            let hintText = '';
            if (vatMode === 'inclusive' && vatOn) {
              hintText = svc ? 'Prices include VAT · service charge at checkout' : 'Prices include VAT';
            } else {
              const charges = [vatOn && 'VAT', svc && 'service charge'].filter(Boolean).join(' & ');
              if (charges) hintText = `${charges} applied at checkout`;
            }
            const hint = hintText ? <div className="tt-hint">{hintText}</div> : null;
            if (discount <= 0) return hint;
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
                {hint}
              </>
            );
          })()}
        </div>

        {(queuedOps.length > 0 || offline) && (
          <div className="tab-sync-note" role="status">
            <CloudOff size={12} strokeWidth={1.7} aria-hidden="true" />
            {queuedOps.length > 0
              ? `${queuedOps.length} change${queuedOps.length === 1 ? '' : 's'} waiting to sync`
              : isDraft
                ? 'Offline — reconnect to start a new tab'
                : 'Offline — changes will queue'}
          </div>
        )}

        <div className="tab-actions">
          {/* Primary slot: prefer "Send to kitchen" when there are pending
           * items and the member can send; otherwise "Settle" when they can
           * settle. A member with neither grant sees no primary action. */}
          {pending.length > 0 && canSendKitchen ? (
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
          ) : canSettle ? (
            <button
              type="button"
              className="btn primary"
              disabled={offline || visibleLines.length === 0 || visibleLines.every((i) => i.voided_at)}
              onClick={() => setShowSettle(true)}
              style={{ flex: 1, justifyContent: 'center' }}
              title={offline ? 'Settlement needs a connection — this tab will be ready to settle when you are back online.' : undefined}
            >
              <Receipt size={14} strokeWidth={1.5} />
              Settle tab
            </button>
          ) : null}
          {/* Only show standalone discount button when the tenant uses the
           * split flow — the combined settle modal already exposes it inline. */}
          {canDiscount && !tenant.data?.preferences?.combinedSettle && (
            <button
              type="button"
              className="btn"
              onClick={() => setShowDiscount(true)}
              data-tip="discount"
              title={offline ? 'Needs a connection' : 'Discount'}
              disabled={offline || visibleLines.length === 0}
            >
              <Percent size={14} strokeWidth={1.5} />
            </button>
          )}
          {canMoveTab && (
            <button
              type="button"
              className="btn"
              onClick={() => setShowMove(true)}
              data-tip="move / merge"
              title={offline ? 'Needs a connection' : 'Move to another table or merge'}
              disabled={offline}
            >
              <ArrowLeftRight size={14} strokeWidth={1.5} />
            </button>
          )}
          {kitchenPrintOn && sentToKitchen.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={reprintDocket}
              data-tip="reprint ticket"
              title="Reprint kitchen ticket"
            >
              <Printer size={14} strokeWidth={1.5} />
            </button>
          )}
          {canCancelTab && (
            <button
              type="button"
              className="btn danger"
              onClick={onCancelTab}
              data-tip="cancel tab"
              title={offline ? 'Needs a connection' : 'Cancel tab'}
              disabled={offline}
            >
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </aside>

      {confirmingSend && (
        <PreSendModal
          pending={pending}
          menuItems={items.data ?? []}
          tableLabel={tableLabel}
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
            tableLabel={tableLabel}
            onClose={() => setShowSettle(false)}
            onClosed={() => {
              setShowSettle(false);
              nav('/admin/floor', { replace: true });
            }}
          />
          <DiscountModal
            open={showDiscount}
            orderId={orderId}
            tableLabel={tableLabel}
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

// Memoized so a qty change on one line doesn't re-render every other row of a
// long tab. The comparator keys on the data props only: the callback props are
// fresh closures each parent render, but they capture the same `it` object the
// comparator already checks — skipping the render keeps an equivalent closure.
const LineRow = memo(LineRowInner, (prev, next) =>
  prev.it === next.it &&
  prev.canEdit === next.canEdit &&
  prev.canVoid === next.canVoid &&
  prev.pendingSync === next.pendingSync &&
  prev.presets.length === next.presets.length &&
  prev.presets.every((p, i) => p === next.presets[i]),
);

function LineRowInner({
  it,
  presets,
  allowHalf,
  canEdit,
  canVoid,
  pendingSync,
  onQty,
  onVoid,
  onNotes,
}: {
  it: OrderItemRow;
  presets: string[];
  /** Item opts into ½-plate quantities — the stepper moves in 0.5 steps. */
  allowHalf: boolean;
  /** Member holds order:update_item — may change qty/notes on a pending line. */
  canEdit: boolean;
  /** Member holds order:void_item — may void a line. */
  canVoid: boolean;
  /** Line has a queued offline op that hasn't reached the server yet. */
  pendingSync: boolean;
  onQty: (delta: number) => void;
  onVoid: () => void;
  onNotes: (notes: string) => void;
}) {
  // Half-plate items nudge by 0.5; everything else by whole plates. Tapping the
  // menu card still adds a full plate — the stepper is for fine adjustment.
  const step = allowHalf ? 0.5 : 1;
  const voided = !!it.voided_at;
  // A line is editable only when it's pending AND the member can update items.
  const editable = !voided && it.kitchen_status === 'pending' && canEdit;
  // Inline note editor is heavy (chips + input). Default to collapsed so a
  // long tab list stays scannable on mobile; expand on tap. Auto-expand if
  // a note already exists so the cashier sees it.
  const [showNotes, setShowNotes] = useState(!!it.notes);
  return (
    <div className={`line ${voided ? 'voided' : ''}`}>
      <div className="line-row">
        <div className="line-name">
          <strong>
            {it.menu_item_name}
            {pendingSync && (
              <CloudOff
                size={11}
                strokeWidth={1.8}
                className="line-sync-glyph"
                aria-label="Waiting to sync"
              />
            )}
          </strong>
          {!editable && it.notes && <div className="line-note">{it.notes}</div>}
          <div className="line-status">
            <span className={`pill ${kitchenPillClass(it.kitchen_status, voided)}`}>
              {voided ? 'voided' : it.kitchen_status.replace('_', ' ')}
            </span>
            {voided && it.void_reason && <span className="void-reason">— {it.void_reason}</span>}
          </div>
        </div>
        <div className="line-qty">
          {canEdit && (
            <button
              type="button"
              className="btn icon"
              onClick={() => onQty(-step)}
              disabled={!editable}
              aria-label="decrease"
            >
              −
            </button>
          )}
          <span
            style={{ minWidth: 18, textAlign: 'center', fontFamily: 'var(--font-mono)' }}
          >
            {formatQty(it.qty)}
          </span>
          {canEdit && (
            <button
              type="button"
              className="btn icon"
              onClick={() => onQty(step)}
              disabled={!editable}
              aria-label="increase"
            >
              <Plus size={12} strokeWidth={1.5} />
            </button>
          )}
        </div>
        <div className="line-amt">{formatNPR(it.line_cents)}</div>
        {editable && (
          <button
            type="button"
            className={`btn icon line-note-toggle${showNotes || it.notes ? ' active' : ''}${it.notes ? ' has-note' : ''}`}
            onClick={() => setShowNotes((v) => !v)}
            aria-label={it.notes ? `Note: ${it.notes}` : 'Add note'}
            title={it.notes ? `Note: ${it.notes}` : 'Add note'}
          >
            <StickyNote size={12} strokeWidth={1.6} />
          </button>
        )}
        {!voided && canVoid && (
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

// TabTitle — the tab's heading. For a walk-in / "Unknown +" tab (no real
// table) it's click-to-edit: tap the name to type a label, save on Enter/blur,
// Escape to cancel. Mirrors the NoteField inline pattern. On a real table (or
// without permission) it renders as a plain, non-editable heading.
function TabTitle({
  displayLabel,
  rawLabel,
  editable,
  onSave,
  variant = 'display',
}: {
  displayLabel: string;
  rawLabel: string;
  editable: boolean;
  onSave: (name: string) => void;
  // 'display' is the large italic tab-head heading; 'compact' is the smaller
  // topbar form used on mobile (styling driven entirely by the modifier class).
  variant?: 'display' | 'compact';
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rawLabel);
  useEffect(() => {
    if (!editing) setText(rawLabel);
  }, [rawLabel, editing]);

  const headClass = variant === 'compact' ? 'tab-title tab-title--compact' : 'tab-title';

  if (!editable) {
    return (
      <h2 className={headClass}>
        <span className="ttl-text">{displayLabel}</span>
      </h2>
    );
  }

  if (!editing) {
    return (
      <h2 className={headClass}>
        <button
          type="button"
          className="tab-title-edit"
          onClick={() => {
            setText(rawLabel);
            setEditing(true);
          }}
          title="Name this tab"
        >
          <span className="ttl-text">{displayLabel}</span>
          <Pencil size={14} strokeWidth={1.6} aria-hidden />
        </button>
      </h2>
    );
  }

  const commit = () => {
    setEditing(false);
    const trimmed = text.trim();
    if (trimmed !== rawLabel.trim()) onSave(trimmed);
  };

  return (
    <h2 className={headClass}>
      <input
        className={
          variant === 'compact' ? 'tab-title-input tab-title-input--compact' : 'tab-title-input'
        }
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setText(rawLabel);
            setEditing(false);
          }
        }}
        placeholder="Name this tab — Mr. Sharma, Patio…"
        aria-label="Tab name"
        maxLength={60}
      />
    </h2>
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
  tableLabel,
  onSend,
  onClose,
  onNotes,
  sending,
}: {
  pending: OrderItemRow[];
  menuItems: MenuItem[];
  tableLabel: string;
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
          <h3>confirm send · {tableLabel}</h3>
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
                    <span className="presend-qty">×{formatQty(p.qty)}</span>
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
