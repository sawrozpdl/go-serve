/** Service tables (floor layout) + the sweep-clean action. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceTable } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';
import { isOffline } from '../stores/connectivity';
import { toast } from '../lib/toast';

export function useServiceTables() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.tables(slug ?? ''),
    queryFn: () =>
      api.get<{ tables: ServiceTable[] }>('/v1/tables', { tenantSlug: slug }).then((r) => r.tables),
    enabled: !!slug,
  });
}

/**
 * Mark a table clean (dirty → free) after a tab closes.
 *
 * Optimistic: the tile used to sit on "dirty" until the invalidate round-tripped,
 * which on a slow till reads as a dead button. The flip is deliberately NOT done
 * while offline — sweeping has no offline queue (unlike order edits), so showing
 * the table free would be a lie the server never hears about.
 */
export function useSweepTable() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tableId: string) =>
      api.patch(`/v1/tables/${tableId}`, { status: 'free' }, { tenantSlug: slug }),
    onMutate: async (tableId) => {
      if (isOffline()) return undefined;
      const key = qk.tables(slug ?? '');
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ServiceTable[]>(key);
      if (prev) {
        qc.setQueryData<ServiceTable[]>(
          key,
          prev.map((t) => (t.id === tableId ? { ...t, status: 'free' } : t)),
        );
      }
      return { prev, key };
    },
    onError: (err, _tableId, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast.error('Could not mark clean', (err as { message?: string }).message ?? 'Please try again.');
    },
    onSettled: () => {
      if (isOffline()) return;
      void qc.invalidateQueries({ queryKey: qk.tables(slug ?? '') });
    },
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
