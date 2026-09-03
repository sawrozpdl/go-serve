import { Users } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const people: GuideTopic = {
  id: 'people',
  title: 'People, roles & staff',
  icon: Users,
  group: 'Your café setup',
  blurb: 'Who can log in, what they can do, and who works here.',
  sections: [
    {
      id: 'people-two-lists',
      heading: 'Members and staff are two different lists',
      keywords: ['member', 'staff', 'team', 'invite', 'login', 'employee', 'registry'],
      body: (
        <>
          <p>
            This trips up nearly everyone once, so it’s worth being blunt about:
          </p>
          <ul>
            <li>
              <strong>Members</strong> are accounts that can <em>log in</em>. You invite
              someone by email; they sign in with that address and see whatever their role
              allows.
            </li>
            <li>
              <strong>Staff</strong> is your record of <em>who works here</em> — schedules,
              pay, documents. A dishwasher who never touches the app belongs in Staff and
              not in Members.
            </li>
          </ul>
          <p>
            Most people are in both, and they are still separate records. Removing someone’s
            login doesn’t erase their employment history, and hiring someone doesn’t hand
            them access to your books.
          </p>
          <TryIt to="/admin/people/members">Open People</TryIt>
        </>
      ),
    },
    {
      id: 'people-roles',
      heading: 'Roles and permissions',
      keywords: ['role', 'permission', 'owner', 'manager', 'waiter', 'cashier', 'access', 'custom role'],
      body: (
        <>
          <p>
            A role is a named bundle of permissions, and it’s the only thing that decides
            what a person sees. The sidebar, the buttons, the reports — all of it is derived
            from the permissions their role holds. There are no hidden role-name special
            cases: grant a permission and the matching screen appears; revoke it and it
            disappears.
          </p>
          <p>
            Built-in roles are marked <em>system</em> and cover the usual shapes. Owner is
            locked, because a café that can lock itself out of its own books is a café with
            a support ticket. On plans that include custom roles you can build your own —
            “Cashier who can’t see profit”, “Manager who can’t delete expenses”.
          </p>
          <Collapsible title="How much access should a waiter have?">
            <p>
              Enough to do the job and no more — not out of suspicion, but because a
              sidebar with thirty entries is harder to use than one with five. Taking
              orders and settling bills is usually the whole list. Giving everyone the
              owner role “to keep things simple” is the one shortcut worth refusing: it
              also makes the Activity log useless, because every action was taken by
              somebody who could do anything.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'people-staff-records',
      heading: 'Staff records, schedules and pay',
      keywords: ['roster', 'timeline', 'schedule', 'shift plan', 'salary', 'documents', 'citizenship', 'contract'],
      body: (
        <>
          <p>
            A staff profile holds contact details, role, join date and{' '}
            <strong>private documents</strong> — a contract, a citizenship copy. Those
            documents are genuinely restricted: they’re served through a permission check
            rather than sitting on a public link, so only people whose role allows it can
            open them.
          </p>
          <p>
            On plans with scheduling, the <strong>Timeline</strong> tab plans the week. Drag
            a bar to change a shift; a coverage ribbon shows where you’re thin against your
            opening hours. It’s information, not enforcement — nothing stops someone
            clocking in off-plan.
          </p>
          <p>
            Paying someone records an <strong>expense</strong>, so wages appear in your net
            profit like every other cost. There is no separate payroll ledger that quietly
            never reaches the bottom line.
          </p>
          <AnnotatedShot
            src="/guide/staff.webp"
            alt="The Staff screen"
            caption="The people registry — roster and shift timeline."
            pins={[
              { x: 32, y: 16, label: 'Switch to the Timeline to plan shifts' },
              { x: 28, y: 34, label: 'Each person — role, status and private documents' },
            ]}
          />
          <TryIt to="/admin/people/staff">Open Staff</TryIt>
        </>
      ),
    },
    {
      id: 'people-leaving',
      heading: 'When someone leaves',
      keywords: ['remove', 'leave', 'quit', 'deactivate', 'revoke access', 'offboard'],
      body: (
        <p>
          Remove their membership so they can’t log in, and mark their staff record
          inactive. Both keep the history: their name stays on the serves they took and the
          shifts they closed. Deleting the record outright would leave months of your books
          attributed to nobody — which is exactly the state you don’t want when you’re
          trying to work out what happened.
        </p>
      ),
    },
  ],
};
