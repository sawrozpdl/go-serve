/**
 * Order-taking hooks. Reads + mutations mirror the web contract exactly
 * (endpoints, payloads, optimistic patterns). Client-generated UUIDs on
 * add-items make the writes idempotent so the M5 offline replay is a drop-in.
 * Money ops (settle/payments/discounts) live in M3 and stay online-only.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { addOnsUnitCents, formatQty } from '@cafe-mgmt/api-types';
import type {
  AddOnChoice,
  Order,
  OrderItemAddOn,
  OrderItemRow,
  OrderStatus,
  KitchenStatus,
  AddOrderItemsVars,
  SettleQuote,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { recomputeOrderDerived } from './orderDerive';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';
import { isOffline } from '../stores/connectivity';
import { enqueueOp } from '../offline/queue';

export type SendResult = {
  sent: number;
  to_kitchen: number;
  marked_ready: number;
  auto_served: number;
};

/** Re-exported from ./orderDerive, which stays free of any ./client import so
 *  the demo backend can share the one implementation. */
export { recomputeOrderDerived } from './orderDerive';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

// Line ids whose add request is in flight RIGHT NOW (online path). Edits on
// them are skipped until the insert lands — a PATCH against an id the server
// hasn't accepted yet 404s, and the optimistic row would be rolled back.
// (Offline-queued lines are deliberately NOT in this set: edits on them queue
// behind the add, which is safe because replay is FIFO per order.)
const inFlightAddIds = new Set<string>();

/** True while a line's insert hasn't been confirmed by the server AND we're
 *  online. Mirrors web's `isUnconfirmedItemId` (apps/web/src/lib/api.ts) so the
 *  two clients skip the same lines when stacking and editing. */
export function isUnconfirmedItemId(id: string): boolean {
  return inFlightAddIds.has(id) && !isOffline();
}

/** Apply `fn` to the cached order and re-derive; returns the previous snapshot
 * for rollback. */
function patchOrder(qc: QueryClient, key: readonly unknown[], fn: (o: Order) => Order): Order | undefined {
  const prev = qc.getQueryData<Order>(key);
  if (prev) qc.setQueryData(key, recomputeOrderDerived(fn(prev)));
  return prev;
}

export function useOrders(status: OrderStatus = 'open') {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.orders(slug ?? '', status),
    queryFn: () =>
      api
        .get<{ orders: Order[] }>(`/v1/orders?status=${status}`, { tenantSlug: slug })
        .then((r) => r.orders),
    enabled: !!slug,
  });
}

export function useOrder(orderId: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.order(slug ?? '', orderId ?? ''),
    queryFn: () => api.get<Order>(`/v1/orders/${orderId}`, { tenantSlug: slug }),
    enabled: !!slug && !!orderId,
  });
}

export function useOpenOrder() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      service_table_id?: string | null;
      table_label?: string;
      notes?: string;
      /** Opens the order as a staff meal — free food, never a sale. */
      staff_id?: string;
    }) =>
      api.post<Order>('/v1/orders', body, { tenantSlug: slug }),
    onSuccess: (order) => {
      qc.setQueryData(qk.order(slug ?? '', order.id), order);
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.tables(slug ?? '') });
    },
  });
}

export function useAddOrderItems() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: AddOrderItemsVars) => {
      // Offline: capture for replay; the optimistic cache row (added in
      // onMutate) IS the state until the queue drains. Client line ids make
      // the eventual POST idempotent.
      if (isOffline()) {
        const it = vars.items[0];
        enqueueOp({
          tenantSlug: slug ?? '',
          orderId: vars.orderId,
          kind: 'add_items',
          payload: { items: vars.items },
          label: it ? `${formatQty(it.qty)}× ${vars.optimistic?.menu_item_name ?? 'item'}` : 'Add items',
        });
        return Promise.resolve({ items: [] as OrderItemRow[] });
      }
      return api.post<{ items: OrderItemRow[] }>(
        `/v1/orders/${vars.orderId}/items`,
        { items: vars.items },
        { tenantSlug: slug },
      );
    },
    onMutate: async (vars) => {
      const key = qk.order(slug ?? '', vars.orderId);
      // Only the online path races: an offline add is queued, and later edits
      // replay behind it in FIFO order.
      if (!isOffline()) for (const it of vars.items) inFlightAddIds.add(it.id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Order>(key);
      if (prev && vars.optimistic && vars.items[0]) {
        const it = vars.items[0];
        const line: OrderItemRow = {
          id: it.id,
          order_id: vars.orderId,
          menu_item_id: it.menu_item_id,
          menu_item_name: vars.optimistic.menu_item_name,
          qty: it.qty,
          unit_price_cents: vars.optimistic.unit_price_cents,
          // The unit price is FOLDED (base + add-ons), so the base has to be
          // carried separately or a later add-on edit would re-fold onto the
          // already-folded number.
          base_price_cents: vars.optimistic.base_price_cents,
          line_cents: vars.optimistic.unit_price_cents * it.qty,
          // Priced rows straight from the picker: without them the "+ Extra
          // cheese" sub-lines only appeared after the refetch, so the ticket
          // showed a price with no visible reason for it.
          add_ons: vars.optimisticAddOns ?? [],
          modifiers: it.modifiers ?? null,
          notes: it.notes ?? '',
          kitchen_status: 'pending',
          created_at: new Date().toISOString(),
        };
        qc.setQueryData(key, recomputeOrderDerived({ ...prev, items: [...(prev.items ?? []), line] }));
      }
      return { prev, key };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, vars) => {
      // Released whether the insert succeeded or failed: on failure the
      // optimistic row is rolled back, so nothing is left pointing at the id.
      for (const it of vars.items) inFlightAddIds.delete(it.id);
      if (isOffline()) return; // the optimistic cache is the truth until replay
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
    },
  });
}

export function useUpdateOrderItem() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      orderId: string;
      itemId: string;
      /** `add_ons` is whole-set (PUT semantics): omit to leave them alone, send
       *  `[]` to clear. The server re-folds unit_price_cents onto the line's own
       *  base_price_cents, so only ids and qty travel. */
      patch: { qty?: number; notes?: string; modifiers?: unknown; add_ons?: AddOnChoice[] };
      /** Priced rows for the cache only — the PATCH sends ids, the server prices. */
      optimisticAddOns?: OrderItemAddOn[];
    }) => {
      if (isOffline()) {
        enqueueOp({
          tenantSlug: slug ?? '',
          orderId: vars.orderId,
          kind: 'update_item',
          payload: { itemId: vars.itemId, patch: vars.patch },
          label: 'Edit line',
        });
        return Promise.resolve(undefined);
      }
      return api.patch(`/v1/orders/${vars.orderId}/items/${vars.itemId}`, vars.patch, { tenantSlug: slug });
    },
    onMutate: async (vars) => {
      const key = qk.order(slug ?? '', vars.orderId);
      await qc.cancelQueries({ queryKey: key });
      // add_ons in the patch are bare ids; the cache wants the PRICED rows, so
      // they are spread from `optimisticAddOns` instead and the id-only form is
      // kept out of the row.
      const { add_ons: _ids, ...cachePatch } = vars.patch;
      const prev = patchOrder(qc, key, (o) => ({
        ...o,
        items: (o.items ?? []).map((i) => {
          if (i.id !== vars.itemId) return i;
          const addOns = vars.optimisticAddOns ?? i.add_ons;
          // Re-fold onto the line's OWN base, never onto the current folded
          // price — that is what the server does (orders.go UpdateOrderItem).
          const unit = vars.optimisticAddOns
            ? (i.base_price_cents ?? i.unit_price_cents) + addOnsUnitCents(vars.optimisticAddOns)
            : i.unit_price_cents;
          const qty = cachePatch.qty ?? i.qty;
          return { ...i, ...cachePatch, add_ons: addOns, unit_price_cents: unit, line_cents: unit * qty };
        }),
      }));
      return { prev, key };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, vars) => {
      if (isOffline()) return;
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', vars.orderId) });
    },
  });
}

export function useVoidOrderItem() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; itemId: string; reason?: string }) => {
      if (isOffline()) {
        enqueueOp({
          tenantSlug: slug ?? '',
          orderId: vars.orderId,
          kind: 'void_item',
          payload: { itemId: vars.itemId, reason: vars.reason ?? '' },
          label: 'Remove line',
        });
        return Promise.resolve(undefined);
      }
      return api.post(
        `/v1/orders/${vars.orderId}/items/${vars.itemId}/void`,
        { reason: vars.reason ?? '' },
        { tenantSlug: slug },
      );
    },
    onMutate: async (vars) => {
      const key = qk.order(slug ?? '', vars.orderId);
      await qc.cancelQueries({ queryKey: key });
      const nowIso = new Date().toISOString();
      const prev = patchOrder(qc, key, (o) => ({
        ...o,
        items: (o.items ?? []).map((i) =>
          i.id === vars.itemId ? { ...i, voided_at: nowIso, void_reason: vars.reason ?? '' } : i,
        ),
      }));
      return { prev, key };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, vars) => {
      if (isOffline()) return;
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
    },
  });
}

export function useSendOrderToKitchen() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string): Promise<SendResult> => {
      if (isOffline()) {
        // Count the pending lines BEFORE flipping them (order matters), then
        // optimistically mark them in_progress so the tab reflects the send.
        // The real send-to-kitchen replays (idempotently) when the queue drains.
        const key = qk.order(slug ?? '', orderId);
        const cached = qc.getQueryData<Order>(key);
        const sent = (cached?.items ?? []).filter(
          (i) => !i.voided_at && i.kitchen_status === 'pending',
        ).length;
        const nowIso = new Date().toISOString();
        patchOrder(qc, key, (o) => ({
          ...o,
          items: (o.items ?? []).map((i) =>
            !i.voided_at && i.kitchen_status === 'pending'
              ? { ...i, kitchen_status: 'in_progress' as KitchenStatus, sent_to_kitchen_at: nowIso }
              : i,
          ),
        }));
        enqueueOp({
          tenantSlug: slug ?? '',
          orderId,
          kind: 'send_kitchen',
          payload: {},
          label: 'Send to kitchen',
        });
        return Promise.resolve({ sent, to_kitchen: sent, marked_ready: 0, auto_served: 0 });
      }
      return api.post<SendResult>(`/v1/orders/${orderId}/send-to-kitchen`, {}, { tenantSlug: slug });
    },
    onSettled: (_d, _e, orderId) => {
      if (isOffline()) return;
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.kitchenTickets(slug ?? '') });
    },
  });
}

/**
 * Cancel (discard) an open tab — frees the table and removes the order. The
 * server only allows it when nothing has been sent to the kitchen; online-only
 * (like settle), so no offline path. Mirrors web's POST /orders/{id}/cancel.
 */
export function useCancelOrder() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => api.post(`/v1/orders/${orderId}/cancel`, {}, { tenantSlug: slug }),
    onSettled: (_d, _e, orderId) => {
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
    },
  });
}

export function useMoveOrder() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; service_table_id: string | null }) =>
      api.post<{ order_id: string; merged: boolean }>(
        `/v1/orders/${vars.orderId}/move`,
        { service_table_id: vars.service_table_id },
        { tenantSlug: slug },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.tables(slug ?? '') });
    },
  });
}

export function useRenameOrder() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; table_label: string }) =>
      api.post(`/v1/orders/${vars.orderId}/rename`, { table_label: vars.table_label }, { tenantSlug: slug }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
    },
  });
}

/** Settle quote — read now (used by the summary bar); the settle flow is M3. */
export function useSettleQuote(orderId: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.orderQuote(slug ?? '', orderId ?? ''),
    queryFn: () => api.get<SettleQuote>(`/v1/orders/${orderId}/quote`, { tenantSlug: slug }),
    enabled: !!slug && !!orderId,
  });
}
