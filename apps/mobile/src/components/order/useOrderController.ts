/**
 * useOrderController — all order-taking state, data and handlers for the tab
 * detail screen, lifted out of the route so the phone (sheet) and tablet
 * (split-view) compositions share one brain. The logic here is moved verbatim
 * from the old floor/[orderId].tsx: the ensureRef promise-dedupe, the
 * stackItems add/remove symmetry, the KOT print sequencing on send, and the
 * offline nudges all behave exactly as before.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { haptics } from '@/lib/haptics';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { resolveTableLabel, type Order, type MenuItem, type OrderItemRow } from '@cafe-mgmt/api-types';
import { useMenuCategories, useMenuItems } from '@/api/menu';
import { useTenantSettings } from '@/api/tenant';
import {
  useOrder,
  useOrders,
  useOpenOrder,
  useAddOrderItems,
  useUpdateOrderItem,
  useVoidOrderItem,
  useSendOrderToKitchen,
  useRenameOrder,
  useCancelOrder,
  useMoveOrder,
  recomputeOrderDerived,
} from '@/api/orders';
import { useServiceTables } from '@/api/tables';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useOutlets } from '@/api/outlets';
import { useOfflineQueue, queuedLineIds } from '@/offline/queue';
import { isOffline, useConnectivity } from '@/stores/connectivity';
import { useDraftCart } from '@/stores/draftCart';
import {
  shouldPrintKot,
  selectCookBoundPending,
  printKitchenDocket,
  groupDocketsByOutlet,
} from '@/printing/kot';
import { toast } from '@/lib/toast';

export function useOrderController() {
  const params = useLocalSearchParams<{ orderId: string; tableId?: string; tableName?: string }>();
  const isDraft = params.orderId === 'new';

  const [createdId, setCreatedId] = useState<string | null>(null);
  const orderId = isDraft ? createdId : params.orderId;

  const me = useMe();
  const settings = useTenantSettings();
  const menuItems = useMenuItems();
  const categories = useMenuCategories();
  const outlets = useOutlets();
  const orderQ = useOrder(orderId ?? undefined);

  const openOrder = useOpenOrder();
  const addItems = useAddOrderItems();
  const updateItem = useUpdateOrderItem();
  const voidItem = useVoidOrderItem();
  const send = useSendOrderToKitchen();
  const rename = useRenameOrder();
  const cancel = useCancelOrder();
  const move = useMoveOrder();
  const router = useRouter();
  const tables = useServiceTables();
  const openOrders = useOrders('open');

  const prefs = settings.data?.preferences;
  // Whether any outlet has a network printer — gates the reprint affordance.
  const hasOutletPrinter = (outlets.data ?? []).some((o) => !!o.printer_ip?.trim());
  const stackItems = prefs?.stackItems ?? true;

  const canAdd = can(me.data, 'order:add_items') || can(me.data, 'order:create');
  const canSend = can(me.data, 'order:send_kitchen');
  const canVoid = can(me.data, 'order:void_item');
  const canSettle = can(me.data, 'order:settle');
  const canCancel = can(me.data, 'order:cancel');
  const canMove = can(me.data, 'order:create');
  const offline = useConnectivity((s) => s.mode === 'offline');

  // Open orders keyed by table — lets the move sheet flag a target table that
  // already has a tab running as a merge instead of a plain transfer.
  const openByTable = new Map<string, Order>();
  for (const o of openOrders.data ?? []) {
    if (o.service_table_id) openByTable.set(o.service_table_id, o);
  }

  const [confirmSend, setConfirmSend] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  // A sent line the user is voiding — holds the reason sheet's target.
  const [voidTarget, setVoidTarget] = useState<{ id: string; name: string } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  // Client-side draft cart: while no real order exists yet (orderId null), the
  // order lives here on the device — nothing is created on the server until the
  // first send. Table identity comes from the store (seeded by startDraft at the
  // floor entry points) so it survives the menu → ticket hop between the two
  // separate controller instances.
  const draftItems = useDraftCart((s) => s.items);
  const draftTableId = useDraftCart((s) => s.tableId);
  const draftTableName = useDraftCart((s) => s.tableName);
  const setDraftItems = useDraftCart((s) => s.setItems);
  const clearDraft = useDraftCart((s) => s.clear);

  const draft: Order = useMemo(
    () =>
      recomputeOrderDerived({
        id: '',
        service_table_id: draftTableId ?? params.tableId ?? null,
        service_table_name: draftTableName ?? params.tableName ?? null,
        table_label: '',
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
        items: draftItems,
        items_pending: 0,
        items_in_progress: 0,
        items_ready: 0,
        items_served: 0,
        items_total: 0,
        paid_cents: 0,
      }),
    [draftItems, draftTableId, draftTableName, params.tableId, params.tableName],
  );
  const order = orderId ? (orderQ.data ?? draft) : draft;
  const items = (order.items ?? []).filter((i) => !i.voided_at);
  const pending = items.filter((i) => i.kitchen_status === 'pending');
  const sent = items.filter((i) => i.kitchen_status === 'in_progress' || i.kitchen_status === 'ready');
  const tableLabel = resolveTableLabel(order);
  const pendingCount = pending.reduce((n, i) => n + i.qty, 0);

  // Live pending qty per menu item — powers the count badges in the menu grid.
  // (Plain compute; React Compiler memoizes it — a manual useMemo here can't be
  // preserved because `pending` is a fresh array each render.)
  const pendingQtyByItem = new Map<string, number>();
  for (const it of pending) pendingQtyByItem.set(it.menu_item_id, (pendingQtyByItem.get(it.menu_item_id) ?? 0) + it.qty);

  // Line ids with an unsynced offline op → show a "not synced yet" hint.
  const queuedIds = queuedLineIds(useOfflineQueue((s) => s.ops));

  const ensureRef = useRef<Promise<string> | null>(null);
  const ensureOrderId = useCallback(async (): Promise<string> => {
    if (orderId) return orderId;
    if (ensureRef.current) return ensureRef.current;
    ensureRef.current = openOrder
      .mutateAsync({ service_table_id: draftTableId ?? params.tableId ?? null })
      .then((o) => {
        setCreatedId(o.id);
        return o.id;
      })
      .finally(() => {
        ensureRef.current = null;
      });
    return ensureRef.current;
  }, [orderId, openOrder, draftTableId, params.tableId]);

  const addMenuItem = useCallback(
    async (mi: MenuItem) => {
      haptics.selection();
      const stackWith = (list: OrderItemRow[]) =>
        stackItems
          ? list.find(
              (i) => i.menu_item_id === mi.id && i.kitchen_status === 'pending' && !i.voided_at && !i.notes,
            )
          : undefined;

      // Draft (no real order yet): mutate the on-device cart. Nothing hits the
      // server until the first send, so this works offline too.
      if (!orderId) {
        setDraftItems((items) => {
          const stack = stackWith(items);
          if (stack) {
            return items.map((i) =>
              i.id === stack.id ? { ...i, qty: i.qty + 1, line_cents: i.unit_price_cents * (i.qty + 1) } : i,
            );
          }
          const line: OrderItemRow = {
            id: Crypto.randomUUID(),
            order_id: '',
            menu_item_id: mi.id,
            menu_item_name: mi.name,
            qty: 1,
            unit_price_cents: mi.price_cents,
            line_cents: mi.price_cents,
            modifiers: null,
            notes: '',
            kitchen_status: 'pending',
            created_at: new Date().toISOString(),
          };
          return [...items, line];
        });
        return;
      }

      // Existing order: add straight to the server (queued when offline).
      const stack = stackWith(order.items ?? []);
      if (stack) {
        updateItem.mutate({ orderId, itemId: stack.id, patch: { qty: stack.qty + 1 } });
      } else {
        addItems.mutate({
          orderId,
          items: [{ id: Crypto.randomUUID(), menu_item_id: mi.id, qty: 1 }],
          optimistic: { menu_item_name: mi.name, unit_price_cents: mi.price_cents },
        });
      }
    },
    [orderId, stackItems, order.items, setDraftItems, updateItem, addItems],
  );

  // Remove one of a just-added item straight from the menu grid — symmetric
  // with add: decrement the stackable (note-free) pending line, voiding it at 1.
  // Falls back to the most recent pending line so − always does something when a
  // count is shown. Only pending lines are touchable (sent items can't unsend).
  const removeMenuItem = useCallback(
    (mi: MenuItem) => {
      const lines = (order.items ?? []).filter(
        (i) => i.menu_item_id === mi.id && i.kitchen_status === 'pending' && !i.voided_at,
      );
      if (lines.length === 0) return;
      const line = lines.find((i) => !i.notes) ?? lines[lines.length - 1];
      haptics.selection();
      // Draft: a pending line has never been sent, so removing it just drops it
      // from the on-device cart (no void row to keep).
      if (!orderId) {
        setDraftItems((items) =>
          line.qty <= 1
            ? items.filter((i) => i.id !== line.id)
            : items.map((i) => (i.id === line.id ? { ...i, qty: i.qty - 1, line_cents: i.unit_price_cents * (i.qty - 1) } : i)),
        );
        return;
      }
      if (line.qty <= 1) voidItem.mutate({ orderId, itemId: line.id });
      else updateItem.mutate({ orderId, itemId: line.id, patch: { qty: line.qty - 1 } });
    },
    [orderId, order.items, setDraftItems, voidItem, updateItem],
  );

  // Group cook-bound lines by outlet and print each subset to that outlet's
  // printer (station header = outlet name). Each outlet is printed
  // independently so one wedged printer doesn't abort the others.
  const printOutletDockets = useCallback(
    async (lines: OrderItemRow[], reprint: boolean): Promise<boolean> => {
      const groups = groupDocketsByOutlet(
        lines,
        menuItems.data ?? [],
        categories.data ?? [],
        outlets.data ?? [],
      );
      let printedAny = false;
      let anyFailed = false;
      for (const g of groups) {
        if (!g.target || g.items.length === 0) continue;
        try {
          await printKitchenDocket({
            items: g.items,
            tableLabel,
            printer: g.target,
            reprint,
            station: g.outlet?.name?.toUpperCase(),
          });
          printedAny = true;
        } catch {
          anyFailed = true;
        }
      }
      if (anyFailed) {
        toast.error(reprint ? 'Some reprints failed' : 'Sent, but some printing failed');
      }
      return printedAny;
    },
    [menuItems.data, categories.data, outlets.data, tableLabel],
  );

  const doSend = useCallback(async () => {
    // Compute the KOT docket from the current order (the draft cart's lines are
    // all pending, so this works before creation too).
    const docket = selectCookBoundPending(order, menuItems.data ?? [], categories.data ?? [], prefs);
    setConfirmSend(false);

    // Draft: this send is what actually OPENS the tab — create the order, push
    // the whole on-device cart, then fire it. Needs a connection (POST /orders
    // has no offline path), so nudge instead of failing offline.
    if (!orderId) {
      if (draftItems.length === 0) return;
      if (isOffline()) {
        toast.error('Reconnect to send', 'Starting a tab needs a connection');
        return;
      }
      try {
        const id = await ensureOrderId();
        await addItems.mutateAsync({
          orderId: id,
          items: draftItems.map((i) => ({
            id: i.id,
            menu_item_id: i.menu_item_id,
            qty: i.qty,
            notes: i.notes || undefined,
            modifiers: i.modifiers ?? undefined,
          })),
        });
        const res = await send.mutateAsync(id);
        haptics.notifySuccess();
        toast.success(`${res.sent} item${res.sent === 1 ? '' : 's'} sent to kitchen`);
        if (shouldPrintKot(prefs) && docket.length > 0) {
          await printOutletDockets(docket, false);
        }
        clearDraft();
      } catch (e) {
        toast.error('Could not send', (e as Error).message);
      }
      return;
    }

    try {
      const res = await send.mutateAsync(orderId);
      haptics.notifySuccess();
      toast.success(`${res.sent} item${res.sent === 1 ? '' : 's'} sent to kitchen`);
      if (shouldPrintKot(prefs) && docket.length > 0) {
        await printOutletDockets(docket, false);
      }
    } catch (e) {
      toast.error('Could not send', (e as Error).message);
    }
  }, [orderId, order, draftItems, ensureOrderId, addItems, clearDraft, menuItems.data, categories.data, prefs, send, printOutletDockets]);

  const doReprint = useCallback(async () => {
    if (sent.length === 0) return;
    const printed = await printOutletDockets(sent, true);
    if (printed) toast.success('Reprinted kitchen ticket');
  }, [sent, printOutletDockets]);

  const renameOrder = useCallback(
    (label: string) => {
      if (orderId) rename.mutate({ orderId, table_label: label });
      setRenameOpen(false);
    },
    [orderId, rename],
  );

  // Move this tab to another table, detach it to take-away (targetId null),
  // or merge it into a table's already-open tab (server decides merge vs
  // plain transfer — see MoveTableSheet for the confirm-before-merge step).
  // No offline queue path exists for this endpoint, so it's blocked outright.
  const doMove = useCallback(
    async (targetId: string | null) => {
      if (!orderId) return;
      if (isOffline()) {
        toast.error('Reconnect to move this tab', 'Moving tabs needs a connection');
        return;
      }
      try {
        const res = await move.mutateAsync({ orderId, service_table_id: targetId });
        toast.success(res.merged ? 'Tabs merged' : targetId ? 'Tab moved' : 'Moved to take-away');
        setMoveOpen(false);
        if (res.merged && res.order_id !== orderId) {
          router.replace({ pathname: '/floor/[orderId]', params: { orderId: res.order_id } });
        }
      } catch (e) {
        toast.error('Could not move tab', (e as Error).message);
      }
    },
    [orderId, move, router],
  );

  const setQty = useCallback(
    (itemId: string, qty: number) => {
      if (!orderId) {
        setDraftItems((items) =>
          qty <= 0
            ? items.filter((i) => i.id !== itemId)
            : items.map((i) => (i.id === itemId ? { ...i, qty, line_cents: i.unit_price_cents * qty } : i)),
        );
        return;
      }
      if (qty <= 0) voidItem.mutate({ orderId, itemId });
      else updateItem.mutate({ orderId, itemId, patch: { qty } });
    },
    [orderId, setDraftItems, voidItem, updateItem],
  );

  // Whether a line's item opts into ½-plate quantities — drives the ticket
  // stepper's step size. Whole plates for anything not explicitly enabled.
  const allowHalfFor = useCallback(
    (menuItemId: string) => (menuItems.data ?? []).find((m) => m.id === menuItemId)?.allow_half ?? false,
    [menuItems.data],
  );

  const setNote = useCallback(
    (itemId: string, notes: string) => {
      if (!orderId) {
        setDraftItems((items) => items.map((i) => (i.id === itemId ? { ...i, notes } : i)));
        return;
      }
      updateItem.mutate({ orderId, itemId, patch: { notes } });
    },
    [orderId, setDraftItems, updateItem],
  );

  const voidLine = useCallback(
    (itemId: string, reason?: string) => {
      if (!orderId) {
        // Draft line was never sent — just drop it from the cart.
        setDraftItems((items) => items.filter((i) => i.id !== itemId));
        return;
      }
      voidItem.mutate({ orderId, itemId, reason });
    },
    [orderId, setDraftItems, voidItem],
  );

  // Discard the whole tab (frees the table). Returns whether it succeeded so the
  // caller can navigate away only on success. Nothing persisted (no orderId) is
  // a no-op success — the caller just leaves.
  const cancelOrder = useCallback(async (): Promise<boolean> => {
    // Draft: nothing was ever persisted — discard the on-device cart and leave.
    if (!orderId) {
      clearDraft();
      return true;
    }
    try {
      await cancel.mutateAsync(orderId);
      toast.success('Tab cancelled');
      return true;
    } catch (e) {
      toast.error('Could not cancel tab', (e as Error).message);
      return false;
    }
  }, [orderId, clearDraft, cancel]);

  return {
    // identity + status
    orderId,
    isDraft,
    order,
    tableLabel,
    isLoading: !!orderId && orderQ.isLoading,
    items,
    pending,
    sent,
    pendingCount,
    pendingQtyByItem,
    queuedIds,
    // capability flags
    canAdd,
    canSend,
    canVoid,
    canSettle,
    canCancel,
    canMove,
    offline,
    // move/merge data
    tables,
    openByTable,
    // handlers
    addMenuItem,
    removeMenuItem,
    doSend,
    doReprint,
    renameOrder,
    doMove,
    setQty,
    allowHalfFor,
    setNote,
    voidLine,
    cancelOrder,
    // mutation liveness
    sendPending: send.isPending,
    cancelPending: cancel.isPending,
    movePending: move.isPending,
    canReprint: hasOutletPrinter,
    // sheet state
    confirmSend,
    setConfirmSend,
    renameOpen,
    setRenameOpen,
    moveOpen,
    setMoveOpen,
    settleOpen,
    setSettleOpen,
    cancelOpen,
    setCancelOpen,
    voidTarget,
    setVoidTarget,
  };
}

export type OrderController = ReturnType<typeof useOrderController>;
