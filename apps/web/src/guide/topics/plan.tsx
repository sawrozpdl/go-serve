import { Gauge } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const plan: GuideTopic = {
  id: 'plan',
  title: 'Your plan',
  icon: Gauge,
  group: 'Your café setup',
  blurb: 'Trial, seats, and what each plan includes.',
  sections: [
    {
      id: 'plan-status',
      heading: 'Where your café stands',
      keywords: ['plan', 'subscription', 'trial', 'billing', 'seats', 'expired', 'read-only', 'grace', 'locked'],
      body: (
        <>
          <p>
            <strong>Settings → Plan &amp; usage</strong> shows your plan, its status, how
            many seats you’re using, and exactly which premium features are included. A new
            café starts on a trial; when it ends there’s a short grace period, and after
            that the café goes <strong>read-only</strong> — you can still see and export
            everything, but nothing new can be recorded.
          </p>
          <p>
            Read-only is a pause, not a deletion. Nothing is thrown away, and paying picks
            up exactly where you stopped.
          </p>
          <TryIt to="/admin/settings">Open Plan &amp; usage</TryIt>
        </>
      ),
    },
    {
      id: 'plan-seats',
      heading: 'Seats',
      keywords: ['seat', 'member limit', 'invite', 'how many users', 'full'],
      body: (
        <p>
          A seat is a member who can log in. <strong>Pending invites count</strong> — an
          invitation you sent and forgot occupies a seat exactly as a person does, which is
          usually the answer when a café is “full” with fewer people than it expects. Staff
          records with no login don’t use a seat.
        </p>
      ),
    },
    {
      id: 'plan-features',
      heading: 'Premium features',
      keywords: ['feature', 'premium', 'upgrade', 'inventory', 'profitability', 'audit', 'stations', 'not available'],
      body: (
        <>
          <p>
            Some parts of the app are switched on per plan — inventory, profitability,
            owner finance, credit accounts, staff records and scheduling, custom roles,
            multiple stations, thermal printing, audit logs, QR rewards. The Plan page lists
            every one with a tick or a cross, so there’s never a guess about whether
            something is missing or simply not yours yet.
          </p>
          <p>
            A feature you don’t have isn’t hidden from this guide — the topic still explains
            it, with a note at the top saying it isn’t on your plan. Upgrades are handled by
            a person: the Plan page has the contact button.
          </p>
          <Collapsible title="A feature is on my plan but I can’t see it">
            <p>
              Two different gates have to both pass. The <em>plan</em> has to include the
              feature, and <em>your role</em> has to hold the permission. An owner sees the
              screen; a waiter on the same plan may not. Check People → Roles before
              assuming it’s a billing problem.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
