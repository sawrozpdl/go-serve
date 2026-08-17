import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { request } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

// =========================================================================
// Engage (QR rewards) — the admin + POS data layer.
//
// A module of its own rather than more lines in lib/api.ts, which is already
// 4,500 lines. `request` is exported precisely so features can live outside it
// (the report builder does the same).
//
// The GUEST side of this feature does NOT use this file — it has its own
// standalone fetch layer in src/play/lib/playApi.ts, and eslint stops the two
// from meeting. See the bundle note in vite.config.ts.
// =========================================================================

export type EngageCampaign = {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'ended';
  starts_on: string | null;
  ends_on: string | null;
  active_days: number[];
  active_from: string | null;
  active_to: string | null;
  game: 'tea_runner' | 'memory_match' | 'stack';
  difficulty: 'gentle' | 'normal' | 'tricky';
  reward_ttl_seconds: number;
  grace_seconds: number;
  allow_claim_without_play: boolean;
  budget_total_cents: number | null;
  budget_daily_cents: number | null;
  budget_daily_count: number | null;
  contact_capture_enabled: boolean;
  headline: string;
  subhead: string;
  terms_text: string;
};

export type EngageTier = {
  id: string;
  min_score: number;
  label: string;
  reward_kind: 'percent' | 'flat' | 'free_item' | 'none';
  percent_bp: number | null;
  amount_cents: number | null;
  menu_item_id: string | null;
  menu_item_name?: string;
  max_discount_cents: number | null;
  estimated_value_cents: number;
  sort: number;
};

export type EngageStats = {
  funnel: { scans: number; scan_loads: number; started: number; completed: number; won: number; redeemed: number };
  rates: {
    completion: number;
    win: number;
    redemption: number;
    returning: number | null;
    returning_reason?: string;
  };
  practice_runs: number;
  flagged_runs: number;
  value_issued_cents: number;
  value_redeemed_cents: number;
  in_flight_codes: number;
  spend_lift: {
    with_reward_orders: number;
    without_reward_orders: number;
    avg_with_subtotal_cents: number;
    avg_without_subtotal_cents: number;
    avg_with_total_cents: number;
    avg_without_total_cents: number;
    basis: string;
    caveats: string[];
  };
  score_histogram: { bucket: number; count: number }[];
  from: string;
  to: string;
};

export type EngageDay = {
  day: string;
  scans: number;
  started: number;
  completed: number;
  won: number;
  redeemed: number;
  value_redeemed_cents: number;
};

export type EngageContact = {
  id: string;
  name: string;
  email: string;
  phone: string;
  consent_at: string;
  first_seen_at: string;
  last_seen_at: string;
  times_seen: number;
  consent_text_version: string;
};

export type RewardLookup = {
  code: string;
  label: string;
  reward_kind: string;
  status: string;
  expires_at: string;
  seconds_left: number;
  needs_grace_override: boolean;
  redeemable: boolean;
  blocked_reason?: string;
  applies_cents?: number;
  would_clamp?: boolean;
};

// ---------------------------------------------------------------------
// Campaign + tiers
// ---------------------------------------------------------------------

export function useEngageCampaign() {
  const { slug } = useTenant();
  return useQuery({
    queryKey: ['engage', 'campaign', slug],
    queryFn: () =>
      request<{ campaign: EngageCampaign | null; tiers: EngageTier[] }>('GET', '/v1/engage/campaign', {
        tenantSlug: slug!,
      }),
    enabled: !!slug,
  });
}

export function useSaveEngageCampaign() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: (body: Partial<EngageCampaign>) =>
      request<{ campaign: EngageCampaign; tiers: EngageTier[] }>('PUT', '/v1/engage/campaign', {
        tenantSlug: slug!,
        body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engage', 'campaign', slug] }),
  });
}

export function useSetEngageStatus() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: (status: EngageCampaign['status']) =>
      request<{ campaign: EngageCampaign }>('POST', '/v1/engage/campaign/status', {
        tenantSlug: slug!,
        body: { status },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engage'] }),
  });
}

/** Whole-list replace: the editor is one form with a Save button, so a per-row
 *  PATCH would only invite the two sides to drift. */
export function useSaveEngageTiers() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: (tiers: Partial<EngageTier>[]) =>
      request<{ tiers: EngageTier[] }>('PUT', '/v1/engage/tiers', {
        tenantSlug: slug!,
        body: { tiers },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engage', 'campaign', slug] }),
  });
}

export function useInvalidateEngageCodes() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: () =>
      request<{ voided: number }>('POST', '/v1/engage/codes/invalidate', { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engage'] }),
  });
}

// ---------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------

export function useEngageStats(range: string, from?: string, to?: string) {
  const { slug } = useTenant();
  const qs = new URLSearchParams({ range, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return useQuery({
    queryKey: ['engage', 'stats', slug, range, from, to],
    queryFn: () => request<EngageStats>('GET', `/v1/engage/stats?${qs}`, { tenantSlug: slug! }),
    enabled: !!slug,
  });
}

export function useEngageTimeseries(range: string, from?: string, to?: string) {
  const { slug } = useTenant();
  const qs = new URLSearchParams({ range, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return useQuery({
    queryKey: ['engage', 'timeseries', slug, range, from, to],
    queryFn: () =>
      request<{ days: EngageDay[] }>('GET', `/v1/engage/timeseries?${qs}`, { tenantSlug: slug! }),
    enabled: !!slug,
  });
}

// ---------------------------------------------------------------------
// Contacts (PII — its own permissions server-side)
// ---------------------------------------------------------------------

export function useEngageContacts(q: string) {
  const { slug } = useTenant();
  return useQuery({
    queryKey: ['engage', 'contacts', slug, q],
    queryFn: () =>
      request<{ contacts: EngageContact[] }>(
        'GET',
        `/v1/engage/contacts?q=${encodeURIComponent(q)}`,
        { tenantSlug: slug! },
      ),
    enabled: !!slug,
  });
}

export function useDeleteEngageContact() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: (id: string) =>
      request<void>('DELETE', `/v1/engage/contacts/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engage', 'contacts'] }),
  });
}

export function useDeleteAllEngageContacts() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: () =>
      request<{ deleted: number }>(
        'DELETE',
        `/v1/engage/contacts?confirm=${encodeURIComponent(slug ?? '')}`,
        { tenantSlug: slug! },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engage', 'contacts'] }),
  });
}

// ---------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------

/** Dry run: what would happen if this code were applied to this tab. Writes
 *  nothing, so the cashier sees the real amount before committing. */
export function lookupRewardCode(code: string, orderId: string, tenantSlug: string) {
  return request<RewardLookup>(
    'GET',
    `/v1/engage/codes/${encodeURIComponent(code)}?order_id=${encodeURIComponent(orderId)}`,
    { tenantSlug },
  );
}

export type RedeemResult = {
  code: string;
  label: string;
  amount_cents: number;
  intended_amount_cents: number;
  was_clamped: boolean;
  was_grace_override: boolean;
};

export function useRedeemRewardCode() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  return useMutation({
    mutationFn: ({ code, orderId }: { code: string; orderId: string }) =>
      request<RedeemResult>('POST', `/v1/engage/codes/${encodeURIComponent(code)}/redeem`, {
        tenantSlug: slug!,
        body: { order_id: orderId },
      }),
    onSuccess: () => {
      // The reward lands as an ordinary order_adjustments discount, so the
      // existing quote/adjustment queries render it with no new UI.
      qc.invalidateQueries({ queryKey: ['order-adjustments'] });
      qc.invalidateQueries({ queryKey: ['order-quote'] });
      qc.invalidateQueries({ queryKey: ['engage'] });
    },
  });
}
