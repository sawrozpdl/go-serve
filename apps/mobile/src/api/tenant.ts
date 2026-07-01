/** Tenant settings + preference updates (drives branding, printing prefs, etc.). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenantSettings, TenantPreferences } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useTenantSettings() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.tenantSettings(slug ?? ''),
    queryFn: () => api.get<TenantSettings>('/v1/tenant', { tenantSlug: slug }),
    enabled: !!slug,
  });
}

/** Patch preferences, merging over the current ones so we never clobber
 * unrelated toggles. */
export function useUpdateTenantPreferences() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<TenantPreferences>) => {
      const current = qc.getQueryData<TenantSettings>(qk.tenantSettings(slug ?? ''));
      const preferences = { ...(current?.preferences ?? {}), ...patch };
      return api.patch<TenantSettings>('/v1/tenant', { preferences }, { tenantSlug: slug });
    },
    onSuccess: (data) => qc.setQueryData(qk.tenantSettings(slug ?? ''), data),
  });
}
