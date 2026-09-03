import { Coins } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const accounts: GuideTopic = {
  id: 'accounts',
  title: 'Café balance & money flow',
  icon: Coins,
  group: 'Money & stock',
  blurb: 'Where your money lives, and what actually moves the balance.',
  perm: 'account:read',
  sections: [
    {
      id: 'money-buckets',
      heading: 'The four cash buckets',
      keywords: ['balance', 'drawer', 'bank', 'online', 'owner cash', 'bucket', 'where is my money'],
      body: (
        <>
          <p>
            Your <strong>Café balance</strong> is just the money you hold right now, split
            across four places:
          </p>
          <ul>
            <li><strong>Drawer</strong> — cash in the till.</li>
            <li><strong>Bank</strong> — the café’s bank account.</li>
            <li><strong>Online</strong> — eSewa, Khalti, card and other digital channels.</li>
            <li>
              <strong>Cash with owners</strong> — café cash an owner has taken from the till
              but not yet reconciled. Still the café’s money — just sitting in a pocket.
            </li>
          </ul>
          <p>
            The golden rule: <strong>moving cash between these buckets never changes the
            balance</strong> — only <em>earning</em> (a sale, an investment) or{' '}
            <em>spending</em> (an expense, a payout) does. That’s why an owner taking cash
            from the till doesn’t shrink the café’s money; it just moves where it sits.
          </p>
          <p>
            A few things look like money but aren’t cash in hand, so they sit{' '}
            <em>outside</em> the balance: credit a guest still owes you, or a loan the café
            owes an owner.
          </p>
          <TryIt to="/admin/learn/money-flow">Play with the money-flow simulator</TryIt>
        </>
      ),
    },
    {
      id: 'money-transfers',
      heading: 'Transfers between accounts',
      keywords: ['transfer', 'deposit', 'bank the cash', 'withdraw', 'fee', 'charge', 'move money'],
      body: (
        <>
          <p>
            Banking the day’s takings, or withdrawing cash for change, is a{' '}
            <strong>transfer</strong>: one bucket down, another up, balance unchanged. Record
            it when it happens and the drawer keeps agreeing with the till.
          </p>
          <p>
            A transfer can carry a <strong>fee</strong> — a withdrawal charge, a payment
            gateway’s cut. The fee <em>is</em> a real reduction in your money, and it’s the
            one part of a transfer that does move the balance. Recording it is the difference
            between a café balance that reconciles and one that’s mysteriously a few hundred
            rupees short every month.
          </p>
          <TryIt to="/admin/accounts">Open Café balance</TryIt>
        </>
      ),
    },
    {
      id: 'money-reconcile',
      heading: 'When the balance looks wrong',
      keywords: ['reconcile', 'wrong', 'mismatch', 'does not add up', 'check', 'audit'],
      body: (
        <>
          <p>
            Work through the four usual causes, in this order — it’s nearly always one of
            them:
          </p>
          <ol className="guide-steps">
            <li><strong>A transfer that happened in real life but was never recorded.</strong> Cash went to the bank; the app still thinks it’s in the drawer.</li>
            <li><strong>An expense with the wrong source.</strong> Paid from the till, recorded as bank.</li>
            <li><strong>Cash an owner took that was never cleared.</strong> It’s sitting in the owner bucket, which is correct but easy to forget.</li>
            <li><strong>A transfer fee nobody recorded.</strong> Small, repeated, and invisible.</li>
          </ol>
          <Collapsible title="Credit doesn’t belong in the balance">
            <p>
              Money a customer owes you is not money you hold, so it isn’t in the café
              balance. It shows separately as “on credit (not in hand)”. When they pay, the
              balance rises — but that’s a collection, not a new sale. See{' '}
              <strong>Credit accounts</strong>.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
