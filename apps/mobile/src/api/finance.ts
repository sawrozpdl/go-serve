/**
 * Read-only cafe finance — owners, the cash they are holding, and the cafe's
 * account balances.
 *
 * These exist for ONE reason: an expense can be paid from an owner's own pocket
 * (`paid_from: 'owner'`, which creates a loan the cafe owes back) or from cafe
 * cash an owner is already holding (`paid_from: 'owner_cash'`, which draws that
 * holding down). Neither source is usable without knowing who the owners are
 * and how much each is holding, so recording those two on a phone needs these
 * three reads. There is deliberately no Owners screen on mobile and no write
 * verb here — equity, investments, loans and payouts stay on the dashboard.
 *
 * All three are `finance:read`; owners and owner-cash additionally sit behind
 * the `owner_finance` plan feature, so callers pass `enabled` rather than
 * eating a 403 on every render.
 */
import { useQuery } from '@tanstack/react-query';
import type { CafeBalance, CafeOwner, OwnerCashResponse } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

/** Active owners only — a retired owner can't advance money for a new expense. */
export function useCafeOwners(opts: { enabled?: boolean } = {}) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.cafeOwners(slug ?? ''),
    queryFn: () =>
      api
        .get<{ owners: CafeOwner[] }>('/v1/finance/owners?active=true', { tenantSlug: slug })
        .then((r) => r.owners),
    enabled: !!slug && (opts.enabled ?? true),
  });
}

/** Per-owner cafe-cash holdings. Only the `holdings` half is used here. */
export function useOwnerCash(opts: { enabled?: boolean } = {}) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.ownerCash(slug ?? ''),
    queryFn: () => api.get<OwnerCashResponse>('/v1/finance/owner-cash', { tenantSlug: slug }),
    enabled: !!slug && (opts.enabled ?? true),
  });
}

/** Drawer / bank / channel balances — the bank figure warns before an overdraw. */
export function useCafeBalance(opts: { enabled?: boolean } = {}) {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.cafeBalance(slug ?? ''),
    queryFn: () => api.get<CafeBalance>('/v1/finance/cafe-balance', { tenantSlug: slug }),
    enabled: !!slug && (opts.enabled ?? true),
  });
}
