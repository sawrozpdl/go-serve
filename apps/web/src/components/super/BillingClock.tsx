/* The always-visible answer to "what is this workspace's clock doing?"
 *
 * Pinned under the café-detail header on every tab, because the question that
 * used to require opening the Billing tab and reading three separate fields —
 * when does this expire, and is it locked — is the question an admin asks on
 * every single visit.
 */

import { Lock } from 'lucide-react';

import type { AdminTenant } from '@/lib/api';
import { billingView } from '@/lib/superBilling';
import { toneForDate } from '@/lib/dates';

import { DateStamp } from './DateStamp';

export function BillingClock({ tenant }: { tenant: AdminTenant }) {
  const v = billingView(tenant);
  const seats = tenant.active_members + tenant.pending_invites;

  return (
    <div className={`billing-clock billing-clock--${v.phase}`}>
      <span className="billing-clock__plan">{tenant.plan_name}</span>

      <span className={`pill ${v.pill}`}>
        {v.writeLocked && <Lock size={11} strokeWidth={2} />} {v.label}
      </span>

      {v.governingDate ? (
        <DateStamp
          at={v.governingDate}
          label={v.dateLabel}
          // A lapsed date on a flag-only past-due tenant is real, but writes
          // still work — don't scream the same red as a hard lock.
          tone={v.phase === 'past_due' ? 'warn' : toneForDate(v.governingDate)}
        />
      ) : (
        <DateStamp at={null} label="Expires" fallback="no clock running" />
      )}

      <span className="billing-clock__seats">
        <span className="datestamp__label">Seats</span>
        <span className="datestamp__date">
          {seats} / {tenant.member_limit ?? '∞'}
        </span>
        {tenant.pending_invites > 0 && (
          <span className="datestamp__rel">
            {tenant.pending_invites} pending {tenant.pending_invites === 1 ? 'invite' : 'invites'}
          </span>
        )}
      </span>
    </div>
  );
}
