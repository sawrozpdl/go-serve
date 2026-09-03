import { Rocket } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const gettingStarted: GuideTopic = {
  id: 'getting-started',
  title: 'Your first week',
  icon: Rocket,
  group: 'Start here',
  blurb: 'Set the café up once, in the order that avoids rework.',
  sections: [
    {
      id: 'start-order',
      heading: 'Set things up in this order',
      keywords: ['setup', 'onboarding', 'new café', 'first time', 'checklist', 'install'],
      body: (
        <>
          <p>
            There’s no wizard — you set the café up screen by screen. The order below
            matters, because each step depends on the one above it.
          </p>
          <ol className="guide-steps">
            <li>
              <strong>Settings → Identity, Locale &amp; Tax.</strong> Name, phone, address,
              then <strong>timezone</strong> and <strong>VAT handling</strong>. Do these
              first: every report buckets by your timezone, and VAT mode changes how bills
              are built. Changing them later doesn’t rewrite serves you’ve already closed.
            </li>
            <li>
              <strong>Settings → Hours.</strong> Your opening hours drive the staff timeline
              and the public menu.
            </li>
            <li>
              <strong>Menu.</strong> Categories first, then items. Put a{' '}
              <em>cost per unit</em> on anything you can — it’s what makes the Profitability
              report worth reading. If you have a printed menu, use{' '}
              <strong>Import menu</strong> and skip the typing.
            </li>
            <li>
              <strong>Tables.</strong> One tile per table, with an area if you have more
              than one room. Walk-ins need no setup.
            </li>
            <li>
              <strong>People → Members and Roles.</strong> Invite your staff and give each
              one a role. A waiter should not have the owner’s role — see{' '}
              <strong>People, roles &amp; staff</strong>.
            </li>
            <li>
              <strong>Shift → Open</strong> with the cash actually in the drawer, and take
              your first serve.
            </li>
          </ol>
          <TryIt to="/admin/settings">Open Settings</TryIt>
        </>
      ),
    },
    {
      id: 'start-opening-balances',
      heading: 'Starting from a café that already exists',
      keywords: ['opening balance', 'migrate', 'existing', 'switch', 'go live', 'carry over'],
      body: (
        <>
          <p>
            If your café was already trading before you started here, a few balances need
            carrying over so the numbers aren’t nonsense on day one:
          </p>
          <ul>
            <li>
              <strong>Cash in the till</strong> — put it in as the opening{' '}
              <em>float</em> when you open your first shift.
            </li>
            <li>
              <strong>Money customers already owe you</strong> — create the credit account
              and fill in <strong>Opening balance owed</strong>. It becomes the account’s
              starting balance without pretending a sale happened today.
            </li>
            <li>
              <strong>Owner investments and loans</strong> — record them on the Owners page
              so equity and the café balance start from the truth.
            </li>
          </ul>
          <Collapsible title="What you should not backfill">
            <p>
              Don’t re-enter last month’s serves to “get history”. Sales are placed in a
              period by their close time, so backdated serves land in today and distort
              every report you’re about to rely on. Start clean; the history you build from
              here is the history you can trust.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'start-day-one',
      heading: 'What a first real day looks like',
      keywords: ['first day', 'training', 'staff', 'practice'],
      body: (
        <>
          <p>
            Run one service with the owner watching. The things that go wrong on day one
            are always the same three:
          </p>
          <ul>
            <li>
              <strong>Nobody opened the shift</strong>, so cash payments are blocked. Open
              it before the first guest.
            </li>
            <li>
              <strong>Items were added but never sent</strong>, so the kitchen never saw
              them. Adding is not sending.
            </li>
            <li>
              <strong>Serves were left open at the end of the night.</strong> An open serve
              is not a sale — it will not appear in today’s takings.
            </li>
          </ul>
          <p>
            Let staff practise in the <strong>Money flow</strong> sandbox rather than on
            the real till: the numbers there are invented and nothing is saved.
          </p>
          <TryIt to="/admin/learn/money-flow">Open the sandbox</TryIt>
        </>
      ),
    },
  ],
};
