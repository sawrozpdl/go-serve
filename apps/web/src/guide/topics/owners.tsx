import { Crown } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const owners: GuideTopic = {
  id: 'owners',
  title: 'Owners, equity & cash custody',
  icon: Crown,
  group: 'Money & stock',
  blurb: 'Shares, investments, loans, payouts, and cash out of the till.',
  feature: 'owner_finance',
  perm: 'finance:read',
  sections: [
    {
      id: 'owners-custody',
      heading: 'Cash with owners',
      keywords: ['owner cash', 'took cash', 'custody', 'till', 'holding', 'clear', 'deposit', 'return'],
      body: (
        <>
          <p>
            When an owner takes cash from the till, it doesn’t disappear — it moves to a
            holding bucket, <strong>Cash with owners</strong>, that’s still part of the café
            balance. Clear each holding one of three ways:
          </p>
          <ul>
            <li><strong>Deposit to bank</strong> — moves it from the owner to the bank.</li>
            <li><strong>Spend on café</strong> — records a café expense paid from that cash.</li>
            <li><strong>Return to drawer</strong> — puts it back in the till.</li>
          </ul>
          <p>
            A “spent on café” movement is just the custody side of an expense. To undo it,
            delete the linked expense — the movement and the balances update with it.
          </p>
          <AnnotatedShot
            src="/guide/owners.webp"
            alt="The Owners screen"
            caption="Owners, their equity, and cash custody."
            pins={[
              { x: 43, y: 33, label: 'Cash with owners — clear cash an owner took from the till' },
              { x: 33, y: 53, label: 'Each owner’s shares and equity stake' },
            ]}
          />
          <TryIt to="/admin/owners">Open Owners</TryIt>
        </>
      ),
    },
    {
      id: 'owners-money-in',
      heading: 'Investment, loan, or payout?',
      keywords: ['investment', 'equity', 'loan', 'payout', 'drawing', 'capital', 'shares', 'repay'],
      body: (
        <>
          <p>
            Money between an owner and the café is one of three things, and the difference
            matters more than the amount:
          </p>
          <ul>
            <li>
              <strong>Investment</strong> — capital put in, permanently. It buys equity and
              is not expected back.
            </li>
            <li>
              <strong>Loan</strong> — money lent to the café that the café owes back. It
              sits outside the balance as a debt until it’s repaid.
            </li>
            <li>
              <strong>Payout</strong> — profit taken out. It reduces the café’s money and is
              not an expense of running it.
            </li>
          </ul>
          <Collapsible title="Why a payout is not an expense">
            <p>
              An expense is a cost of trading — it belongs in profit. A payout is what the
              owners do with profit after it exists. Recording drawings as expenses makes
              the café look unprofitable while the owners are being paid, which is exactly
              backwards, and it’s the most common way a set of café books becomes
              unreadable.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'owners-equity',
      heading: 'Shares and equity',
      keywords: ['shares', 'stake', 'percentage', 'partner', 'split', 'equity'],
      body: (
        <p>
          Each owner holds a number of shares, and their stake is their share of the total.
          Equity is what they’ve put in, not what they’re owed today. If several people run
          the café together, record every investment as it happens rather than reconstructing
          it later from memory — this is the record that settles the argument nobody expects
          to have.
        </p>
      ),
    },
  ],
};
