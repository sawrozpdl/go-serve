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
