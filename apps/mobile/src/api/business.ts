/** Multi-branch (0088): the business's branches and the all-branches dashboard. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BusinessBranchesResponse,
  BusinessCreditResponse,
  DashboardRange,
  FanoutResponse,
  ReportsDashboard,
  StockTransferPayload,
  StockTransferResult,
  MenuSyncPayload,
  MenuSyncResponse,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useMe } from './auth';
import { useTenantStore } from '../stores/tenant';
import { useBranchScope } from '../stores/branchScope';
import { hasBranches } from '../lib/branches';

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

/** "All branches" is on AND available (reports readable in ≥2 branches).
 *  Mirrors web's useOverviewState. While abilities load, a remembered "on"
 *  stays on so an owner doesn't see one branch flash first. */
export function useOverview() {
  const me = useMe();
  const multi = hasBranches(me.data);
  const q = useBusinessBranches(multi);
  const all = useBranchScope((s) => s.all);
  const readable = (q.data?.branches ?? []).filter((b) => b.can?.report_read).length;
  const available = multi && readable > 1;
  return {
    business: me.data?.business,
    branches: q.data?.branches ?? me.data?.branches ?? [],
    available,
    active: multi && all && (q.isPending || available),
  };
}

/** Rows combined across branches by name have no single id; give them stable
 *  `all:` keys (web does the same) so lists key correctly. */
export function mergedId(...names: string[]): string {
  return 'all:' + names.map((n) => n.trim().toLowerCase()).join('|');
}

/** Credit accounts linked across branches by phone (read-only). With `phone`,
 *  just that customer — "do they also owe at another branch?". */
export function useBusinessCredit(phone?: string, enabled = true) {
  const slug = useTenantStore((s) => s.active?.slug);
  const qs = phone ? `?phone=${encodeURIComponent(phone)}` : '';
  return useQuery({
    queryKey: qk.businessCredit(slug ?? '', phone ?? ''),
    queryFn: () => api.get<BusinessCreditResponse>(`/v1/business/credit${qs}`, { tenantSlug: slug }),
    enabled: !!slug && enabled,
  });
}

/** Send stock to another branch; both branches' stock changes together. */
export function useCreateStockTransfer() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StockTransferPayload) =>
      api.post<StockTransferResult>('/v1/business/stock-transfers', body, { tenantSlug: slug }),
    onSuccess: () => {
      // Prefix keys: this branch's and the receiver's caches both refresh.
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['inventory-movements'] });
      void qc.invalidateQueries({ queryKey: ['stock-transfers'] });
    },
  });
}

/** Push this branch's menu to siblings, or preview it with dry_run. */
export function useSyncMenuToBranches() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MenuSyncPayload) => api.post<MenuSyncResponse>('/v1/business/menu/sync', body, { tenantSlug: slug }),
    onSuccess: (res) => {
      if (res.dry_run) return;
      void qc.invalidateQueries({ queryKey: ['menu-categories'] });
      void qc.invalidateQueries({ queryKey: ['menu-items'] });
      void qc.invalidateQueries({ queryKey: ['menu-popular'] });
      void qc.invalidateQueries({ queryKey: ['modifier-groups'] });
    },
  });
}
