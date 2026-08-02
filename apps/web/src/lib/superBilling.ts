/* Console-side view of a workspace's billing position.
 *
 * This mirrors the backend's billing.ComputeState (apps/api/internal/billing/
 * state.go) — including its ordering, where a CURRENT paid-through date beats a
 * stale trial date so a paying customer is never shown as trial-locked.
 *
 * It used to exist twice: `subStatus` in SuperTenantDetailPage and
 * `levelOf`/`expiryOf`/`isPastDue` in SuperTenantsPage, which could disagree
 * about the same tenant. One copy now, and the tenants list and the detail page
 * read the same answer.
 *
 * NOTE this is display-only. The server is the authority — it recomputes state
 * inside every request transaction. Nothing here gates anything.
 */

import type { AdminTenant } from '@cafe-mgmt/api-types';

/** Grace window after a trial ends before writes auto-lock. Mirrors
 *  billing.GraceDays; keep the two in step. */
export const GRACE_DAYS = 7;

/** The window the console treats as "needs attention soon". Also the window the
 *  backend's trials_expiring_soon KPI counts. */
export const SOON_DAYS = 14;

/** Phase labels, matching the backend's billing.Phase* constants. */
export type BillingPhase = 'active' | 'paid' | 'trial' | 'grace' | 'expired' | 'past_due' | 'locked' | 'suspended';

export type BillingView = {
  phase: BillingPhase;
  /** Short label for a pill. */
  label: string;
  /** Pill class: '' renders as the neutral/bad pill. */
  pill: '' | 'ok' | 'warn';
  /** The date that governs this phase, if any. */
  governingDate: string | null;
  /** What that date means, for a caption. */
  dateLabel: string;
  /** True when writes are (or will shortly be) blocked. */
  writeLocked: boolean;
};

/** A tenant carries at most one gate — a trial date OR a paid-through date. */
type BillingRow = Pick<AdminTenant, 'status' | 'billing_state' | 'trial_ends_at' | 'paid_through_at'>;

export function billingView(t: BillingRow, now = Date.now()): BillingView {
  if (t.status !== 'active') {
    return {
      phase: 'suspended', label: t.status, pill: '',
      governingDate: null, dateLabel: '', writeLocked: true,
    };
  }
  if (t.billing_state === 'write_locked') {
    return {
      phase: 'locked', label: 'Locked (manual)', pill: '',
      governingDate: null, dateLabel: '', writeLocked: true,
    };
  }

  // Live paid coverage beats everything but a manual lock — matches
  // ComputeState's paidCurrent-first ordering, which exists so a leftover
  // trial_ends_at can never lock a paying customer out.
  if (t.paid_through_at && new Date(t.paid_through_at).getTime() > now) {
    return {
      phase: 'paid', label: 'Active (paid)', pill: 'ok',
      governingDate: t.paid_through_at, dateLabel: 'Paid through', writeLocked: false,
    };
  }

  if (t.trial_ends_at) {
    const end = new Date(t.trial_ends_at).getTime();
    if (end > now) {
      return {
        phase: 'trial', label: 'Trialing', pill: 'ok',
        governingDate: t.trial_ends_at, dateLabel: 'Trial ends', writeLocked: false,
      };
    }
    if (now < end + GRACE_DAYS * 86_400_000) {
      return {
        phase: 'grace', label: 'Trial ended (grace)', pill: 'warn',
        governingDate: t.trial_ends_at, dateLabel: 'Trial ended', writeLocked: false,
      };
    }
    return {
      phase: 'expired', label: 'Trial expired (locked)', pill: '',
      governingDate: t.trial_ends_at, dateLabel: 'Trial ended', writeLocked: true,
    };
  }

  if (t.paid_through_at) {
    // Lapsed paid coverage. Flag only — the backend never auto-locks this.
    return {
      phase: 'past_due', label: 'Past due', pill: 'warn',
      governingDate: t.paid_through_at, dateLabel: 'Lapsed', writeLocked: false,
    };
  }

  return {
    phase: 'active', label: 'Comped (perpetual)', pill: 'ok',
    governingDate: null, dateLabel: '', writeLocked: false,
  };
}

/** Row urgency — drives list tinting and the default sort. */
export type Urgency = 'critical' | 'warn' | 'ok';
export const URGENCY_RANK: Record<Urgency, number> = { critical: 0, warn: 1, ok: 2 };

export function urgencyOf(t: BillingRow, now = Date.now()): Urgency {
  const v = billingView(t, now);
  if (v.writeLocked) return 'critical';
  if (!v.governingDate) return 'ok';
  // Measured against the SAME `now` billingView used — reaching for the real
  // clock here (via daysUntil) would let the two disagree, and would make this
  // untestable at a fixed instant.
  const d = Math.round((new Date(v.governingDate).getTime() - now) / 86_400_000);
  if (d < 0) return 'critical'; // lapsed trial or past due
  if (d <= SOON_DAYS) return 'warn';
  return 'ok';
}

/** Sort key for the expiry column — no date sorts last, ascending. */
export function expiryTime(t: BillingRow): number {
  const at = billingView(t).governingDate;
  return at ? new Date(at).getTime() : Number.POSITIVE_INFINITY;
}
