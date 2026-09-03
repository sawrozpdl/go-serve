import { Receipt } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const expenses: GuideTopic = {
  id: 'expenses',
  title: 'Expenses',
  icon: Receipt,
  group: 'Money & stock',
  blurb: 'Sources, categories and allocating to the menu.',
  perm: 'expense:read',
  sections: [
    {
      id: 'expenses-basics',
      heading: 'Recording an expense',
      tour: 'first-expense',
      keywords: ['expense', 'spend', 'cost', 'bill', 'supplier', 'rent', 'salary', 'paid from', 'vendor'],
      body: (
        <>
          <p>
            Log every outgoing — supplies, rent, salary, gas, repairs — with what it was
            for and, crucially, <strong>how it was paid</strong>: from the drawer, from the
            bank, or from cash an owner is holding. That choice is what keeps your café
            balance true; the amount alone isn’t enough.
          </p>
          <p>
            Expenses land in a period by their <strong>paid date</strong>, not the date you
            typed them in. So entering last Tuesday’s gas bill today puts it on Tuesday,
            where it belongs.
          </p>
          <AnnotatedShot
            src="/guide/expenses.webp"
            alt="The Expenses screen"
            caption="Every outgoing — what it was for and how it was paid."
            pins={[
              { x: 91, y: 8, label: 'Log a new expense' },
              { x: 30, y: 18, label: 'Filter by category, payment source, or date' },
              { x: 63, y: 49, label: 'Paid from — drawer, bank, or owner cash' },
            ]}
          />
          <TryIt to="/admin/expenses">Open Expenses</TryIt>
        </>
      ),
    },
    {
      id: 'expenses-allocating',
      heading: 'Allocating to menu categories',
      keywords: ['allocate', 'allocation', 'category', 'margin', 'cogs', 'overhead', 'attribute'],
      body: (
        <>
          <p>
            An expense can be split across menu categories — “5kg flour → Momos”, or a milk
            delivery across Coffee and Desserts. Those allocations feed the{' '}
            <strong>category gross margin</strong> view on the Profitability report, which
            is how you find out that the thing you sell most of earns least.
          </p>
          <p>
            Allocating is optional and it does not change your bottom line. An unallocated
            expense still counts fully toward net profit; it’s just shown as overhead rather
            than attached to a category.
          </p>
          <Collapsible title="What’s worth allocating and what isn’t">
            <p>
              Allocate what varies with what you sell: ingredients, packaging, gas. Don’t
              bother with rent, wages or the wifi bill — they don’t belong to a category in
              any meaningful sense, and forcing them into one makes the margin figures worse,
              not better. The nightly check flags how much of your spending is unattributed
              so you can see whether the gap is deliberate or just untouched.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'expenses-corrections',
      heading: 'Deleting and correcting',
      keywords: ['delete expense', 'undo', 'mistake', 'owner cash', 'reverse', 'closed shift'],
      body: (
        <p>
          Deleting an expense reverses everything it caused — including the owner-cash
          movement, if it was paid from cash an owner was holding. The custody list and the
          balances update with it, so you never end up with a movement whose reason has been
          deleted out from under it. What you can’t do is delete a cash entry belonging to a{' '}
          <em>closed</em> shift: that shift’s variance is already stamped, and changing its
          inputs afterwards would make the count meaningless. Record the correction in the
          current shift instead.
        </p>
      ),
    },
  ],
};
