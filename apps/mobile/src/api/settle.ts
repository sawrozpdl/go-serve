/**
 * Settlement hooks — payments, adjustments (discounts), and close. Mirrors the
 * web contract exactly (payments recorded individually, then close with an
 * empty body once balance === 0). Money ops are online-only (the caller guards
 * on connectivity); nothing here is queued offline.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Payment,
  PaymentMethod,
  OrderAdjustment,
  AdjustmentType,
  SettleQuote,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

export function useOrderPayments(orderId: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.orderPayments(slug ?? '', orderId ?? ''),
    queryFn: () =>
      api
        .get<{ payments: Payment[] }>(`/v1/orders/${orderId}/payments`, { tenantSlug: slug })
        .then((r) => r.payments),
    enabled: !!slug && !!orderId,
  });
}

/** Invalidate the money-shaped keys after a payment change. */
function invalidateMoney(qc: ReturnType<typeof useQueryClient>, slug: string, orderId: string) {
  void qc.invalidateQueries({ queryKey: qk.orderPayments(slug, orderId) });
  void qc.invalidateQueries({ queryKey: qk.orderQuote(slug, orderId) });
  void qc.invalidateQueries({ queryKey: qk.currentShift(slug) });
}

export type RecordPaymentVars = {
  orderId: string;
  method: PaymentMethod;
  amount_cents: number;
  reference_no?: string;
  house_tab_id?: string;
};

export function useRecordPayment() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: RecordPaymentVars) =>
      api.post<Payment>(`/v1/orders/${orderId}/payments`, body, { tenantSlug: slug }),
    onSuccess: (_d, vars) => {
      invalidateMoney(qc, slug ?? '', vars.orderId);
      if (vars.method === 'house_tab') void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') });
    },
  });
}

export function useDeletePayment() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; paymentId: string }) =>
      api.del(`/v1/orders/${vars.orderId}/payments/${vars.paymentId}`, { tenantSlug: slug }),
    onSuccess: (_d, vars) => invalidateMoney(qc, slug ?? '', vars.orderId),
  });
}

export function useReclassifyPayment() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; paymentId: string; method: 'cash' | 'online' }) =>
      api.post<Payment>(
        `/v1/orders/${vars.orderId}/payments/${vars.paymentId}/reclassify`,
        { method: vars.method },
        { tenantSlug: slug },
      ),
    onSuccess: (_d, vars) => invalidateMoney(qc, slug ?? '', vars.orderId),
  });
}

export function useOrderAdjustments(orderId: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.orderAdjustments(slug ?? '', orderId ?? ''),
    queryFn: () =>
      api
        .get<{ adjustments: OrderAdjustment[] }>(`/v1/orders/${orderId}/adjustments`, {
          tenantSlug: slug,
        })
        .then((r) => r.adjustments),
    enabled: !!slug && !!orderId,
  });
}

export function useApplyAdjustment() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; type: AdjustmentType; amount_cents: number; reason: string }) =>
      api.post<OrderAdjustment>(
        `/v1/orders/${vars.orderId}/adjustments`,
        { type: vars.type, amount_cents: vars.amount_cents, reason: vars.reason },
        { tenantSlug: slug },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.orderAdjustments(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orderQuote(slug ?? '', vars.orderId) });
    },
  });
}

export function useRemoveAdjustment() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { orderId: string; adjId: string }) =>
      api.del(`/v1/orders/${vars.orderId}/adjustments/${vars.adjId}`, { tenantSlug: slug }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.orderAdjustments(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orderQuote(slug ?? '', vars.orderId) });
    },
  });
}

export function useCloseOrder() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      api.post<SettleQuote>(`/v1/orders/${orderId}/close`, {}, { tenantSlug: slug }),
    onSuccess: (_d, orderId) => {
      void qc.invalidateQueries({ queryKey: qk.order(slug ?? '', orderId) });
      void qc.invalidateQueries({ queryKey: qk.orders(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.tables(slug ?? '') });
    },
  });
}
