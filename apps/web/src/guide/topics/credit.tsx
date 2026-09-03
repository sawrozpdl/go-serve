import { Bookmark } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const credit: GuideTopic = {
  id: 'credit',
  title: 'Credit accounts',
  icon: Bookmark,
  group: 'Daily service',
  blurb: 'Regulars who pay later — and how that money comes back.',
  feature: 'house_tabs',
  perm: 'house_tab:read',
  sections: [
    {
      id: 'credit-what',
      heading: 'What a credit account is',
      tour: 'credit-settle',
      keywords: ['house tab', 'credit', 'khata', 'udhaaro', 'account', 'regular', 'pay later', 'owes'],
      body: (
        <>
          <p>
            A <strong>credit account</strong> is a running ledger for someone who eats now
            and pays later — a regular, a neighbouring shop, a staff member, an owner.
            You’ll know it as a khata.
          </p>
          <p>
            Settling a serve to credit records the <em>sale</em> immediately and adds the
            amount to that account’s balance. The food left the kitchen, so it is revenue.
            The cash simply isn’t in your hand yet, and the reports say so: your Sales
            include it, while <strong>“on credit (not in hand)”</strong> shows how much of
            it you’re still waiting for.
          </p>
          <TryIt to="/admin/house-tabs">Open Credit</TryIt>
        </>
      ),
    },
    {
      id: 'credit-collecting',
      heading: 'Collecting what you’re owed',
      keywords: ['settlement', 'collect', 'payment', 'clear balance', 'bank', 'cash', 'reference'],
      body: (
        <>
          <p>
            Open the account and <strong>Record settlement</strong>. Choose where the money
            actually landed — <strong>Cash</strong> (into the drawer),{' '}
            <strong>Online</strong> (eSewa/Khalti, with a reference if you want one), or{' '}
            <strong>Bank</strong> — and the amount. It defaults to the full balance, but
            part payments are normal.
          </p>
          <p>
            Choosing the right destination matters more than it looks: it’s what makes your
            café balance correct, and a cash settlement is counted in the shift’s expected
            drawer.
          </p>
          <Collapsible title="Why collections don’t show up as sales">
            <p>
              The sale was already counted on the day the food went out. Counting it again
              when the cash arrives would report the same meal twice. So a settlement is
              reported as <strong>credit collected</strong> — money moving into a bucket,
              never new revenue. If today’s takings look low on a day you collected a big
              old balance, this is why.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'credit-hygiene',
      heading: 'Keeping it under control',
      keywords: ['opening balance', 'aging', 'old debt', 'phone', 'reverse', 'stakeholder'],
      body: (
        <>
          <p>
            When you create an account you can enter an <strong>opening balance owed</strong>{' '}
            — what this customer already owed you before you started using the software. It
            becomes the starting balance without inventing a sale.
          </p>
          <p>
            Add a phone number. It’s the difference between chasing a balance and staring
            at a name you can’t place six weeks later.
          </p>
          <p>
            Balances that sit untouched for a long time are raised for you under{' '}
            <strong>Findings</strong> — a khata quietly ageing past the point of collection
            is one of the most common ways a café loses money without noticing.
          </p>
          <p>
            A settlement recorded in error can be reversed, with a reason. Like every other
            correction here it leaves a trace rather than disappearing.
          </p>
        </>
      ),
    },
  ],
};
