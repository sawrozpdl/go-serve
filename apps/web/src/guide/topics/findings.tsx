import { ShieldCheck } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const findings: GuideTopic = {
  id: 'findings',
  title: 'Findings & the morning brief',
  icon: ShieldCheck,
  group: 'Money & stock',
  blurb: 'The nightly check on your books, and what to do with what it finds.',
  perm: 'insight:read',
  sections: [
    {
      id: 'findings-what',
      heading: 'What the nightly check does',
      keywords: ['findings', 'insight', 'nightly', 'check', 'alert', 'noticed', 'overnight', 'detector'],
      body: (
        <>
          <p>
            Every night, GoServe reads your café’s books and looks for the specific things
            that quietly cost cafés money. Not a general “here are your numbers” — a short
            list of things that need a decision, worst first.
          </p>
          <p>
            It’s arithmetic, not guesswork. Each finding is a rule with a threshold, run
            against your own data, and it names the amount and the period it’s talking
            about. If nothing needs attention, it says so and stops — an empty Findings page
            is the good outcome, not a broken one.
          </p>
          <TryIt to="/admin/insights">Open Findings</TryIt>
        </>
      ),
    },
    {
      id: 'findings-what-it-looks-for',
      heading: 'What it looks for',
      keywords: [
        'void rate', 'discount', 'below cost', 'margin', 'cost coverage', 'unallocated',
        'drawer variance', 'shift discipline', 'credit aging', 'dead items', 'integrity',
      ],
      body: (
        <>
          <p>The checks run in a deliberate order — the worst kind of problem first:</p>
          <ul>
            <li>
              <strong>Books that don’t add up.</strong> Arithmetic that should reconcile and
              doesn’t — payments that don’t match a total, a drawer expense with nothing
              behind it. Everything else is unreliable while this is outstanding.
            </li>
            <li>
              <strong>Money leaving with no sale behind it.</strong> Voided sales, discounts
              given, and — more tellingly — voids or discounts concentrated on one person.
              Also payments entered and then removed.
            </li>
            <li>
              <strong>What you actually keep.</strong> Items selling below cost, and
              categories whose margin is slipping against their own past.
            </li>
            <li>
              <strong>Whether those numbers can be trusted.</strong> Sales with no cost
              recorded, and spending you haven’t attributed anywhere.
            </li>
            <li>
              <strong>Operations you can’t see from the floor.</strong> Days closed without
              reconciling the drawer, drawers that didn’t balance, credit going stale, and
              menu items nobody orders.
            </li>
          </ul>
          <p>
            You only ever see findings your role is allowed to see, and only for features
            your plan includes. A waiter with the Findings page open isn’t being shown the
            café’s margins.
          </p>
        </>
      ),
    },
    {
      id: 'findings-acting',
      heading: 'Deciding what to do',
      keywords: ['accept', 'dismiss', 'snooze', 'not useful', 'deal with', 'follow up', 'check back', 'mute'],
      body: (
        <>
          <p>There are three answers, and no fourth:</p>
          <ul>
            <li>
              <strong>“I’ll deal with this”</strong> — write a one-line note of what you’re
              going to do and when to check back. The finding moves to its own section, and
              when the date comes round you’re shown the note next to what the number is
              doing <em>now</em>. That comparison is the whole point.
            </li>
            <li>
              <strong>“Not for a week / a month”</strong> — you’ve seen it, it isn’t today’s
              problem. It comes back.
            </li>
            <li>
              <strong>“Not useful”</strong> — this doesn’t apply to your café. Dismiss the
              same kind three times and it stops being raised at all.
            </li>
          </ul>
          <Collapsible title="Why there’s no assignee, priority or due date">
            <p>
              Because nobody adopts a second task manager, and a café that runs on a paper
              notebook is not going to fill in a form. Three buttons and an optional note
              get used; a project tracker gets abandoned in a fortnight, and an abandoned
              tracker is worse than none — it makes the real problems look handled.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'findings-emails',
      heading: 'The morning brief and the Monday wrap',
      keywords: ['morning brief', 'email', 'monday wrap', 'weekly', 'digest', 'owner email', 'turn off'],
      body: (
        <>
          <p>
            The <strong>morning brief</strong> arrives before opening, and only when there’s
            something worth saying. It goes to owners and managers, in your café’s own
            timezone. A quiet night sends nothing — an email that arrives daily whatever
            happens is an email nobody reads.
          </p>
          <p>
            The <strong>Monday wrap</strong> is the weekly view: how the week went, and what
            happened to the things you said you’d deal with.
          </p>
          <p>
            Turn the brief off under Settings → Workflow if you’d rather not be emailed. The
            nightly check keeps running and the findings still appear here — you’ve only
            switched off the delivery, not the checking.
          </p>
        </>
      ),
    },
  ],
};
