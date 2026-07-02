/**
 * useOrderController — all order-taking state, data and handlers for the tab
 * detail screen, lifted out of the route so the phone (sheet) and tablet
 * (split-view) compositions share one brain. The logic here is moved verbatim
 * from the old floor/[orderId].tsx: the ensureRef promise-dedupe, the
 * stackItems add/remove symmetry, the KOT print sequencing on send, and the
 * offline nudges all behave exactly as before.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { resolveTableLabel, type Order, type MenuItem } from '@cafe-mgmt/api-types';
import { useMenuCategories, useMenuItems } from '@/api/menu';
import { useTenantSettings } from '@/api/tenant';
import {
  useOrder,
  useOpenOrder,
  useAddOrderItems,
  useUpdateOrderItem,
  useVoidOrderItem,
  useSendOrderToKitchen,
  useRenameOrder,
} from '@/api/orders';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { usePrintConfig } from '@/printing/printerConfig';
import { useOfflineQueue, queuedLineIds } from '@/offline/queue';
import { isOffline } from '@/stores/connectivity';
import { shouldPrintKot, selectCookBoundPending, printKitchenDocket } from '@/printing/kot';
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
  const orderQ = useOrder(orderId ?? undefined);

  const openOrder = useOpenOrder();
  const addItems = useAddOrderItems();
  const updateItem = useUpdateOrderItem();
  const voidItem = useVoidOrderItem();
  const send = useSendOrderToKitchen();
  const rename = useRenameOrder();

  const prefs = settings.data?.preferences;
  const role = usePrintConfig((s) => s.role);
  const kitchenPrinter = usePrintConfig((s) => s.kitchenPrinter);
  const stackItems = prefs?.stackItems ?? true;

  const canAdd = can(me.data, 'order:add_items') || can(me.data, 'order:create');
  const canSend = can(me.data, 'order:send_kitchen');
  const canVoid = can(me.data, 'order:void_item');
  const canSettle = can(me.data, 'order:settle');

  // A brand-new tab opens the menu immediately so ordering starts with no extra
  // taps (lazy initial state — avoids a setState-in-effect cascade).
  const [menuOpen, setMenuOpen] = useState<boolean>(() => isDraft);
  const [confirmSend, setConfirmSend] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);

  const draft: Order = useMemo(
    () => ({
      id: '',
      service_table_id: params.tableId ?? null,
      service_table_name: params.tableName ?? null,
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
      items: [],
      items_pending: 0,
      items_in_progress: 0,
      items_ready: 0,
      items_served: 0,
      items_total: 0,
      paid_cents: 0,
    }),
    [params.tableId, params.tableName],
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
      .mutateAsync({ service_table_id: params.tableId ?? null })
      .then((o) => {
        setCreatedId(o.id);
        return o.id;
      })
      .finally(() => {
        ensureRef.current = null;
      });
    return ensureRef.current;
  }, [orderId, openOrder, params.tableId]);

  const addMenuItem = useCallback(
    async (mi: MenuItem) => {
      void Haptics.selectionAsync();
      // A brand-new tab can't be created offline (POST /orders has no offline
      // path); nudge instead of failing. Adding to an EXISTING order is queued.
      if (!orderId && isOffline()) {
        toast.error('Reconnect to start a new tab', 'New tabs need a connection');
        return;
      }
      // Creating the draft order (ensureOrderId) can reject; catch it so a
      // failure shows a friendly toast instead of an uncaught promise error.
      try {
        const id = await ensureOrderId();
        const stack =
          stackItems &&
          (order.items ?? []).find(
            (i) => i.menu_item_id === mi.id && i.kitchen_status === 'pending' && !i.voided_at && !i.notes,
          );
        if (stack) {
          updateItem.mutate({ orderId: id, itemId: stack.id, patch: { qty: stack.qty + 1 } });
        } else {
          addItems.mutate({
            orderId: id,
            items: [{ id: Crypto.randomUUID(), menu_item_id: mi.id, qty: 1 }],
            optimistic: { menu_item_name: mi.name, unit_price_cents: mi.price_cents },
          });
        }
      } catch (e) {
        toast.error('Could not add item', (e as Error).message);
      }
    },
    [orderId, ensureOrderId, stackItems, order.items, updateItem, addItems],
  );

  // Remove one of a just-added item straight from the menu grid — symmetric
  // with add: decrement the stackable (note-free) pending line, voiding it at 1.
  // Falls back to the most recent pending line so − always does something when a
  // count is shown. Only pending lines are touchable (sent items can't unsend).
  const removeMenuItem = useCallback(
    (mi: MenuItem) => {
      if (!orderId) return;
      const lines = (order.items ?? []).filter(
        (i) => i.menu_item_id === mi.id && i.kitchen_status === 'pending' && !i.voided_at,
      );
      if (lines.length === 0) return;
      const line = lines.find((i) => !i.notes) ?? lines[lines.length - 1];
      void Haptics.selectionAsync();
      if (line.qty <= 1) voidItem.mutate({ orderId, itemId: line.id });
      else updateItem.mutate({ orderId, itemId: line.id, patch: { qty: line.qty - 1 } });
    },
    [orderId, order.items, voidItem, updateItem],
  );

  const doSend = useCallback(async () => {
    if (!orderId) return;
    const docket = selectCookBoundPending(order, menuItems.data ?? [], categories.data ?? [], prefs);
    setConfirmSend(false);
    try {
      const res = await send.mutateAsync(orderId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(`${res.sent} item${res.sent === 1 ? '' : 's'} sent to kitchen`);
      if (shouldPrintKot(prefs, role) && kitchenPrinter && docket.length > 0) {
        try {
          await printKitchenDocket({ items: docket, tableLabel, printer: kitchenPrinter });
        } catch (e) {
          toast.error('Sent, but printing failed', (e as Error).message);
        }
      }
    } catch (e) {
      toast.error('Could not send', (e as Error).message);
    }
  }, [orderId, order, menuItems.data, categories.data, prefs, send, role, kitchenPrinter, tableLabel]);

  const doReprint = useCallback(async () => {
    if (!kitchenPrinter || sent.length === 0) return;
    try {
      await printKitchenDocket({ items: sent, tableLabel, printer: kitchenPrinter, reprint: true });
      toast.success('Reprinted kitchen ticket');
    } catch (e) {
      toast.error('Reprint failed', (e as Error).message);
    }
  }, [kitchenPrinter, sent, tableLabel]);

  const renameOrder = useCallback(
    (label: string) => {
      if (orderId) rename.mutate({ orderId, table_label: label });
      setRenameOpen(false);
    },
    [orderId, rename],
  );

  const setQty = useCallback(
    (itemId: string, qty: number) => {
      if (!orderId) return;
      if (qty <= 0) voidItem.mutate({ orderId, itemId });
      else updateItem.mutate({ orderId, itemId, patch: { qty } });
    },
    [orderId, voidItem, updateItem],
  );

  const setNote = useCallback(
    (itemId: string, notes: string) => {
      if (orderId) updateItem.mutate({ orderId, itemId, patch: { notes } });
    },
    [orderId, updateItem],
  );

  const voidLine = useCallback(
    (itemId: string) => {
      if (orderId) voidItem.mutate({ orderId, itemId });
    },
    [orderId, voidItem],
  );

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
    // handlers
    addMenuItem,
    removeMenuItem,
    doSend,
    doReprint,
    renameOrder,
    setQty,
    setNote,
    voidLine,
    // mutation liveness
    sendPending: send.isPending,
    kitchenPrinter,
    // sheet state
    menuOpen,
    setMenuOpen,
    confirmSend,
    setConfirmSend,
    renameOpen,
    setRenameOpen,
    settleOpen,
    setSettleOpen,
  };
}

export type OrderController = ReturnType<typeof useOrderController>;
