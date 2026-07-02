/** Reports dashboard (M8). Advanced analytics (hourly/heatmap/mix/velocity)
 * are a tracked follow-up. */
import { useQuery } from '@tanstack/react-query';
import type { ReportsDashboard, DashboardRange } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useReportsDashboard(range: DashboardRange = 'today') {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.reportsDashboard(slug ?? '', range),
    queryFn: () => api.get<ReportsDashboard>(`/v1/reports/dashboard?range=${range}`, { tenantSlug: slug }),
    enabled: !!slug,
    refetchInterval: 60_000,
  });
}
