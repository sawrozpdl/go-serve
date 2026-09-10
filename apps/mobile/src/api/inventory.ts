/**
 * Inventory (M7) — stock items, create/update/delete, stock adjustments, and
 * movement history. Menu-item links (auto-deduct on sale) live in api/menu.ts
 * (useMenuItemLinks / usePutMenuItemLinks); pack-rules are still a follow-up.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventoryItem, PackRule, StockMovement, StockReason } from '@cafe-mgmt/api-types';
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

/**
 * An item's stock ledger, newest first.
 *
 * Capped at one server page (the endpoint's own max is 200). A phone showing
 * a year of tea purchases is not the tool for that job — the dashboard pages
 * through the full ledger — but the last hundred movements are what answer
 * "why does this say minus three?", which is the whole reason to open it.
 * `total` comes back alongside so the sheet can say what it is not showing.
 */
export function useInventoryMovements(id: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.inventoryMovements(slug ?? '', id ?? ''),
    queryFn: () =>
      api
        .get<{ movements: StockMovement[]; total?: number }>(
          `/v1/inventory/${id}/movements?limit=100`,
          { tenantSlug: slug },
        )
        .then((r) => ({ movements: r.movements ?? [], total: r.total ?? r.movements?.length ?? 0 })),
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

// --- pack rules -----------------------------------------------------------
// How stock is BOUGHT versus how it is SOLD: a carton of 200 bottles is one
// purchase and two hundred sales. Managed from inside the Inventory screen,
// the same place web keeps them.

export function usePackRules(id: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.packRules(slug ?? '', id ?? ''),
    queryFn: () =>
      api
        .get<{ pack_rules: PackRule[] }>(`/v1/inventory/${id}/pack-rules`, { tenantSlug: slug })
        .then((r) => r.pack_rules ?? []),
    enabled: !!slug && !!id,
  });
}

export function useCreatePackRule(itemId: string) {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      container_unit: string;
      container_qty: number;
      sale_unit: string;
      sale_qty_per_container: number;
    }) => api.post<PackRule>(`/v1/inventory/${itemId}/pack-rules`, body, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.packRules(slug ?? '', itemId) }),
  });
}

export function useDeletePackRule(itemId: string) {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      api.del(`/v1/inventory/${itemId}/pack-rules/${ruleId}`, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.packRules(slug ?? '', itemId) }),
  });
}
