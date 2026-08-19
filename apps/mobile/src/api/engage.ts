/**
 * Engage (QR rewards) — the till end only.
 *
 * The mobile app redeems codes; it does not configure campaigns or show
 * analytics (those are web-only in v1). The server applies the reward as an
 * ordinary order_adjustments discount, so the existing quote and adjustment
 * queries render it with no new UI — invalidating them is the whole
 * integration.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

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

export type RedeemResult = {
  code: string;
  label: string;
  amount_cents: number;
  intended_amount_cents: number;
  was_clamped: boolean;
  was_grace_override: boolean;
};

/** Dry run — writes nothing. Lets the cashier see the real amount, after
 *  clamping, before committing. */
export function useLookupRewardCode() {
  const slug = useSlug();
  return useMutation({
    mutationFn: (vars: { code: string; orderId: string }) =>
      api.get<RewardLookup>(
        `/v1/engage/codes/${encodeURIComponent(vars.code)}?order_id=${encodeURIComponent(vars.orderId)}`,
        { tenantSlug: slug },
      ),
  });
}

export function useRedeemRewardCode() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { code: string; orderId: string }) =>
      api.post<RedeemResult>(
        `/v1/engage/codes/${encodeURIComponent(vars.code)}/redeem`,
        { order_id: vars.orderId },
        { tenantSlug: slug },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.orderAdjustments(slug ?? '', vars.orderId) });
      void qc.invalidateQueries({ queryKey: qk.orderQuote(slug ?? '', vars.orderId) });
    },
  });
}

/** Turns the server's error codes into something a cashier can act on with a
 *  guest standing in front of them. */
export function humanRewardError(code: string, message: string): string {
  switch (code) {
    case 'code_not_found':
      return "That code isn't recognised — check the spelling.";
    case 'code_already_redeemed':
      return message || 'That code has already been used.';
    case 'code_expired':
      return 'That code has expired.';
    case 'code_void':
      return 'That code was cancelled.';
    case 'order_not_open':
      return 'This tab is already settled — a reward has to go on before it closes.';
    case 'order_already_has_reward':
      return 'This tab already has a reward on it.';
    case 'discount_exceeds_bill':
      return 'This tab is already fully discounted.';
    case 'reward_not_applicable':
      return message;
    default:
      return message || 'Could not apply that code.';
  }
}
