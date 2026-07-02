/**
 * Inventory (M7) — stock items, create/update/delete, stock adjustments, and
 * movement history. Pack-rules + menu-item links exist server-side but are a
 * tracked follow-up on mobile.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventoryItem, StockMovement, StockReason } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

export function useInventory() {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.inventory(slug ?? ''),
    queryFn: () => api.get<{ items: InventoryItem[] }>('/v1/inventory', { tenantSlug: slug }).then((r) => r.items),
    enabled: !!slug,
  });
}

export function useInventoryMovements(id: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.inventoryMovements(slug ?? '', id ?? ''),
    queryFn: () =>
      api.get<{ movements: StockMovement[] }>(`/v1/inventory/${id}/movements`, { tenantSlug: slug }).then((r) => r.movements),
    enabled: !!slug && !!id,
  });
}

export function useCreateInventoryItem() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<InventoryItem>) => api.post<InventoryItem>('/v1/inventory', body, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.inventory(slug ?? '') }),
  });
}

export function useUpdateInventoryItem() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<InventoryItem> }) =>
      api.patch<InventoryItem>(`/v1/inventory/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.inventory(slug ?? '') }),
  });
}

export function useDeleteInventoryItem() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/inventory/${id}`, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.inventory(slug ?? '') }),
  });
}

export type AdjustVars = {
  id: string;
  delta_units: string;
  reason: StockReason;
  notes: string;
  unit_cost_cents?: number;
};

export function useAdjustInventory() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: AdjustVars) =>
      api.post<StockMovement>(`/v1/inventory/${id}/adjust`, body, { tenantSlug: slug }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.inventory(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.inventoryMovements(slug ?? '', vars.id) });
    },
  });
}
