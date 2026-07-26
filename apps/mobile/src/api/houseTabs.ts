/** House tabs — stakeholder credit lines used as a `house_tab` payment method. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HouseTab, HouseTabDetail, HouseTabSettlement, PaymentMethod } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useHouseTabs() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.houseTabs(slug ?? ''),
    queryFn: () =>
      api
        .get<{ house_tabs: HouseTab[] }>('/v1/house-tabs', { tenantSlug: slug })
        .then((r) => r.house_tabs),
    enabled: !!slug,
  });
}

export function useCreateHouseTab() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      contact_phone?: string;
      notes?: string;
      opening_balance_cents?: number;
    }) => api.post<HouseTab>('/v1/house-tabs', body, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') });
    },
  });
}

export function useHouseTab(id: string | undefined) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.houseTab(slug ?? '', id ?? ''),
    queryFn: () => api.get<HouseTabDetail>(`/v1/house-tabs/${id}`, { tenantSlug: slug }),
    enabled: !!slug && !!id,
  });
}

export function useUpdateHouseTab() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: { name?: string; contact_phone?: string; notes?: string; is_active?: boolean } }) =>
      api.patch<HouseTab>(`/v1/house-tabs/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.houseTab(slug ?? '', vars.id) });
    },
  });
}

export function useDeleteHouseTab() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/house-tabs/${id}`, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') }),
  });
}

export function useCreateHouseTabSettlement() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      amount_cents: number;
      payment_method: PaymentMethod;
      reference_no?: string;
      notes?: string;
    }) =>
      api.post<HouseTabSettlement>(
        `/v1/house-tabs/${vars.id}/settlements`,
        {
          amount_cents: vars.amount_cents,
          payment_method: vars.payment_method,
          reference_no: vars.reference_no,
          notes: vars.notes,
        },
        { tenantSlug: slug },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.houseTab(slug ?? '', vars.id) });
    },
  });
}

/**
 * Reverse a mis-entered collection.
 *
 * The row stays in the ledger (the audit trail has to show what was entered and
 * what undid it) but stops counting: the customer owes the money again and the
 * account it credited gives it back. A reason is mandatory server-side — it is
 * recorded on the row and in the activity log.
 */
export function useReverseHouseTabSettlement() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; settlementId: string; reason: string }) =>
      api.post<void>(
        `/v1/house-tabs/${vars.id}/settlements/${vars.settlementId}/reverse`,
        { reason: vars.reason },
        { tenantSlug: slug },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.houseTab(slug ?? '', vars.id) });
      // Money moved back out of an account, so the drawer and the day's figures
      // are stale too.
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
      void qc.invalidateQueries({ queryKey: ['reports-dashboard', slug ?? ''] });
      void qc.invalidateQueries({ queryKey: ['order-history', slug ?? ''] });
    },
  });
}
