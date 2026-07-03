/** House tabs — stakeholder credit lines used as a `house_tab` payment method. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HouseTab } from '@cafe-mgmt/api-types';
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
    mutationFn: (body: { name: string; notes?: string; opening_balance_cents?: number }) =>
      api.post<HouseTab>('/v1/house-tabs', body, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.houseTabs(slug ?? '') });
    },
  });
}
