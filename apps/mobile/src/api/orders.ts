/**
 * Order-taking hooks. Reads + mutations mirror the web contract exactly
 * (endpoints, payloads, optimistic patterns). Client-generated UUIDs on
 * add-items make the writes idempotent so the M5 offline replay is a drop-in.
 * Money ops (settle/payments/discounts) live in M3 and stay online-only.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Order,
  OrderItemRow,
  OrderStatus,
  KitchenStatus,
  AddOrderItemsVars,
  SettleQuote,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export type SendResult = {
  sent: number;
  to_kitchen: number;
  marked_ready: number;
  auto_served: number;
};

/** Recompute the cheap derived fields (live subtotal + per-status counts) after
 * an optimistic cache edit, so floor tiles + summaries stay consistent without a
 * round-trip. Pure + unit-tested. */
export function recomputeOrderDerived(o: Order): Order {
  const items = o.items ?? [];
  const live = items.filter((i) => !i.voided_at).reduce((s, i) => s + i.line_cents, 0);
  const count = (st: KitchenStatus) =>
    items.filter((i) => !i.voided_at && i.kitchen_status === st).length;
  return {
    ...o,
    live_subtotal_cents: live,
    items_pending: count('pending'),
    items_in_progress: count('in_progress'),
    items_ready: count('ready'),
    items_served: count('served'),
    items_total: items.filter((i) => !i.voided_at).length,
  };
}

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
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
    mutationFn: (body: { service_table_id?: string | null; table_label?: string; notes?: string }) =>
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
    mutationFn: (vars: AddOrderItemsVars) =>
      api.post<{ items: OrderItemRow[] }>(
        `/v1/orders/${vars.orderId}/items`,
        { items: vars.items },
        { tenantSlug: slug },
      ),
    onMutate: async (vars) => {
      const key = qk.order(slug ?? '', vars.orderId);
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
          line_cents: vars.optimistic.unit_price_cents * it.qty,
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
      patch: { qty?: number; notes?: string; modifiers?: unknown };
    }) => api.patch(`/v1/orders/${vars.orderId}/items/${vars.itemId}`, vars.patch, { tenantSlug: slug }),
    onMutate: async (vars) => {
      const key = qk.order(slug ?? '', vars.orderId);
      await qc.cancelQueries({ queryKey: key });
      const prev = patchOrder(qc, key, (o) => ({
        ...o,
        items: (o.items ?? []).map((i) =>
          i.id === vars.itemId
            ? {
                ...i,
                ...vars.patch,
                line_cents:
                  vars.patch.qty != null ? i.unit_price_cents * vars.patch.qty : i.line_cents,
              }
            : i,
        ),
      }));
      return { prev, key };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, vars) =>
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', vars.orderId) }),
  });
}

export function useVoidOrderItem() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; itemId: string; reason?: string }) =>
      api.post(
        `/v1/orders/${vars.orderId}/items/${vars.itemId}/void`,
        { reason: vars.reason ?? '' },
        { tenantSlug: slug },
      ),
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
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
    },
  });
}

export function useSendOrderToKitchen() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      api.post<SendResult>(`/v1/orders/${orderId}/send-to-kitchen`, {}, { tenantSlug: slug }),
    onSuccess: (_d, orderId) => {
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.kitchenTickets(slug ?? '') });
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
