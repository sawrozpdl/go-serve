/** Shift + cash-drawer (M8): current shift, open/close, cash drops. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Shift, CashDrop, CreateCashDropInput, ShiftPayment } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

export function useCurrentShift() {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.currentShift(slug ?? ''),
    queryFn: () => api.get<Shift | null>('/v1/shifts/current', { tenantSlug: slug }),
    enabled: !!slug,
  });
}

export function useCashDrops(shiftId: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.cashDrops(slug ?? '', shiftId ?? ''),
    queryFn: () =>
      api.get<{ cash_drops: CashDrop[] }>(`/v1/shifts/${shiftId}/cash-drops`, { tenantSlug: slug }).then((r) => r.cash_drops),
    enabled: !!slug && !!shiftId,
  });
}

export function useShiftPayments(shiftId: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.shiftPayments(slug ?? '', shiftId ?? ''),
    queryFn: () =>
      api.get<{ payments: ShiftPayment[] }>(`/v1/shifts/${shiftId}/payments`, { tenantSlug: slug }).then((r) => r.payments),
    enabled: !!slug && !!shiftId,
  });
}

export function useOpenShift() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { opening_float_cents: number; notes?: string }) =>
      api.post<Shift>('/v1/shifts/open', body, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.shifts(slug ?? '') });
    },
  });
}

export function useCloseShift() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; closing_count_cents: number; notes?: string }) =>
      api.post<Shift>(`/v1/shifts/${vars.id}/close`, { closing_count_cents: vars.closing_count_cents, notes: vars.notes }, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.shifts(slug ?? '') });
    },
  });
}

export function useCreateCashDrop(shiftId: string) {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCashDropInput) => api.post<CashDrop>(`/v1/shifts/${shiftId}/cash-drops`, body, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.cashDrops(slug ?? '', shiftId) });
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
    },
  });
}
