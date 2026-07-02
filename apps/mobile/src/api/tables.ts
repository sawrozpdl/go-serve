/** Service tables (floor layout) + the sweep-clean action. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceTable } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useServiceTables() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.tables(slug ?? ''),
    queryFn: () =>
      api.get<{ tables: ServiceTable[] }>('/v1/tables', { tenantSlug: slug }).then((r) => r.tables),
    enabled: !!slug,
  });
}

/** Mark a table clean (dirty → free) after a tab closes. */
export function useSweepTable() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tableId: string) =>
      api.patch(`/v1/tables/${tableId}`, { status: 'free' }, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.tables(slug ?? '') }),
  });
}

// ── Management (M7) ─────────────────────────────────────────────────────────

function useInvalidateTables() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: qk.tables(slug ?? '') });
}

export function useCreateServiceTable() {
  const slug = useTenantStore((s) => s.active?.slug);
  const invalidate = useInvalidateTables();
  return useMutation({
    mutationFn: (body: Partial<ServiceTable>) => api.post<ServiceTable>('/v1/tables', body, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useUpdateServiceTable() {
  const slug = useTenantStore((s) => s.active?.slug);
  const invalidate = useInvalidateTables();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<ServiceTable> }) =>
      api.patch<ServiceTable>(`/v1/tables/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useDeleteServiceTable() {
  const slug = useTenantStore((s) => s.active?.slug);
  const invalidate = useInvalidateTables();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/tables/${id}`, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}
