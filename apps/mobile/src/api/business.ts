/** Multi-branch (0088): the business's branches and the all-branches dashboard. */
import { useQuery } from '@tanstack/react-query';
import type { BusinessBranchesResponse, DashboardRange, FanoutResponse, ReportsDashboard } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

/** Branches + what the user may do in each. Only call when /me has a business. */
export function useBusinessBranches(enabled = true) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.businessBranches(slug ?? ''),
    queryFn: () => api.get<BusinessBranchesResponse>('/v1/business/branches', { tenantSlug: slug }),
    enabled: !!slug && enabled,
    staleTime: 60_000,
  });
}

/** Each branch's own dashboard, plus their sum. */
export function useBusinessDashboard(range: DashboardRange, enabled = true) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.businessDashboard(slug ?? '', range),
    queryFn: () =>
      api.get<FanoutResponse<ReportsDashboard>>(`/v1/business/reports/dashboard?range=${range}`, { tenantSlug: slug }),
    enabled: !!slug && enabled,
    refetchInterval: 60_000,
  });
}
