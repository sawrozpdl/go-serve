/** Reports dashboard (M8). Advanced analytics (hourly/heatmap/mix/velocity)
 * are a tracked follow-up. */
import { useQuery } from '@tanstack/react-query';
import type {
  ReportsDashboard,
  DashboardRange,
  MoversResp,
  MoversQuery,
  FanoutResponse,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';
import { mergedId, useOverview } from './business';

export function useReportsDashboard(range: DashboardRange = 'today') {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.reportsDashboard(slug ?? '', range),
    queryFn: () => api.get<ReportsDashboard>(`/v1/reports/dashboard?range=${range}`, { tenantSlug: slug }),
    enabled: !!slug,
    refetchInterval: 60_000,
  });
}

/** Top movers — the full item leaderboard behind the dashboard's Top-5 preview
 * (revenue/qty with search). Shares the /v1/reports/movers endpoint web uses. */
export function useMovers(range: DashboardRange = '30d', filters?: MoversQuery) {
  const slug = useTenantStore((s) => s.active?.slug);
  const qs = new URLSearchParams({ range });
  if (filters?.q) qs.set('q', filters.q);
  if (filters?.sort) qs.set('sort', filters.sort);
  if (filters?.order) qs.set('order', filters.order);
  if (filters?.category_id) qs.set('category_id', filters.category_id);
  if (filters?.limit != null) qs.set('limit', String(filters.limit));
  if (filters?.offset != null) qs.set('offset', String(filters.offset));
  // All-branches mode: items combined by name across branches. Category ids
  // belong to one branch, so that filter doesn't apply there.
  const all = useOverview().active;
  if (all) qs.delete('category_id');
  const key = qs.toString();
  return useQuery({
    queryKey: all ? qk.businessMovers(slug ?? '', key) : qk.reportsMovers(slug ?? '', key),
    queryFn: async (): Promise<MoversResp> => {
      if (!all) return api.get<MoversResp>(`/v1/reports/movers?${key}`, { tenantSlug: slug });
      const r = await api.get<FanoutResponse<MoversResp>>(`/v1/business/reports/movers?${key}`, { tenantSlug: slug });
      return {
        ...r.totals,
        rows: r.totals.rows.map((m) => ({ ...m, menu_item_id: mergedId(m.name, m.category_name ?? '') })),
        branches: r.branches,
      };
    },
    enabled: !!slug,
    refetchInterval: 60_000,
  });
}
