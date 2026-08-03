/* The single ranked queue of cafés that need a human.
 *
 * Billing urgency and usage health are deliberately separate ideas everywhere
 * else in the console — "trial expiring" and "stopped closing shifts" are
 * different problems for different people. But the Overview page has to answer
 * one question: what do I do first? So this is the ONE place they're merged,
 * and each row carries the reason it surfaced rather than a blended score.
 */

import type { AdminTenant, TenantUsage } from '@cafe-mgmt/api-types';

import { billingView, urgencyOf } from './superBilling';
import { daysUntil } from './dates';

/** Why a café is in the queue. Ordered worst-first — the array index IS the
 *  severity, so adding a reason means putting it in the right place. */
export const ATTENTION_REASONS = [
  'locked',      // writes blocked: they literally cannot trade
  'dormant',     // no orders at all for a fortnight
  'past_due',    // paid subscription lapsed
  'lapsed',      // trial ended, inside the grace window
  'at_risk',     // usage signals gone bad
  'expiring',    // trial ends soon
  'unassigned',  // nobody owns the relationship
  'watch',       // usage slipping
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const REASON_LABEL: Record<AttentionReason, string> = {
  locked: 'Locked',
  dormant: 'Dormant',
  past_due: 'Past due',
  lapsed: 'Trial lapsed',
  at_risk: 'At risk',
  expiring: 'Trial ending',
  unassigned: 'No manager',
  watch: 'Slipping',
};

export type AttentionItem = {
  tenant: AdminTenant;
  /** Worst-first. The first entry drives the row's rank and colour. */
  reasons: AttentionReason[];
  /** A sentence naming what's actually wrong, for the row's second line. */
  detail: string;
  /** Which tab to open — sending someone to Overview when the problem is
   *  billing just costs them another click. */
  tab: 'billing' | 'usage' | 'relationship';
};

const SEVERITY = new Map(ATTENTION_REASONS.map((r, i) => [r, i]));

/** How loud a reason should look. Only the top three genuinely block a café. */
export function reasonTone(r: AttentionReason): 'critical' | 'warn' {
  return SEVERITY.get(r)! <= SEVERITY.get('lapsed')! ? 'critical' : 'warn';
}

/** Build the queue. `usageById` may be empty while the rollup is still loading —
 *  billing reasons alone are still worth showing. */
export function buildAttentionQueue(
  tenants: AdminTenant[],
  usageById: Map<string, TenantUsage>,
  now = Date.now(),
): AttentionItem[] {
  const out: AttentionItem[] = [];

  for (const t of tenants) {
    const bill = billingView(t, now);
    const usage = usageById.get(t.tenant_id);
    const reasons: AttentionReason[] = [];
    const details: string[] = [];

    if (bill.writeLocked) {
      reasons.push('locked');
      details.push(bill.phase === 'expired' ? 'trial expired past grace' : 'writes locked');
    } else if (bill.phase === 'past_due') {
      reasons.push('past_due');
      details.push(`payment lapsed ${Math.abs(daysUntil(bill.governingDate!))} days ago`);
    } else if (bill.phase === 'grace') {
      reasons.push('lapsed');
      details.push('trial ended, in the grace window');
    } else if (bill.phase === 'trial' && urgencyOf(t, now) === 'warn') {
      reasons.push('expiring');
      details.push(`trial ends in ${daysUntil(bill.governingDate!)} days`);
    }

    if (usage) {
      if (usage.status === 'dormant') {
        reasons.push('dormant');
        details.push('no orders in a fortnight');
      } else if (usage.status === 'at_risk') {
        reasons.push('at_risk');
        // The server already wrote a sentence with the numbers in it; use it
        // rather than inventing a vaguer one.
        details.push(usage.signals.find((s) => s.grade === 'bad')?.detail ?? 'usage signals are bad');
      } else if (usage.status === 'watch') {
        reasons.push('watch');
        details.push(usage.signals.find((s) => s.grade === 'warn')?.detail ?? 'usage is slipping');
      }
    }

    // Only worth flagging on a café that's otherwise already in the queue, or
    // one that's actually trading — an unassigned dormant test tenant is noise.
    if (!t.relationship_manager_id && (reasons.length > 0 || (usage?.orders_7d ?? 0) > 0)) {
      reasons.push('unassigned');
      details.push('nobody owns this relationship');
    }

    if (reasons.length === 0) continue;

    reasons.sort((a, b) => SEVERITY.get(a)! - SEVERITY.get(b)!);
    // Non-empty by construction — the `continue` above guarantees it.
    const worst = reasons[0]!;
    out.push({
      tenant: t,
      reasons,
      detail: details.join(' · '),
      tab: tabFor(worst),
    });
  }

  // Worst first; ties broken by how many things are wrong.
  return out.sort((a, b) => {
    const s = SEVERITY.get(a.reasons[0]!)! - SEVERITY.get(b.reasons[0]!)!;
    return s !== 0 ? s : b.reasons.length - a.reasons.length;
  });
}

function tabFor(r: AttentionReason): AttentionItem['tab'] {
  switch (r) {
    case 'dormant':
    case 'at_risk':
    case 'watch':
      return 'usage';
    case 'unassigned':
      return 'relationship';
    default:
      return 'billing';
  }
}
