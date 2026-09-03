import { CreditCard } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const settle: GuideTopic = {
  id: 'settle',
  title: 'Settling & payments',
  icon: CreditCard,
  group: 'Daily service',
  blurb: 'Cash, online, credit, split bills and fixing mistakes.',
  sections: [
    {
      id: 'settle-methods',
      heading: 'How to settle',
      keywords: ['pay', 'settle', 'cash', 'online', 'esewa', 'khalti', 'card', 'credit', 'split bill', 'close'],
      body: (
        <>
          <p>
            Settling closes a serve and records how it was paid:
          </p>
          <ul>
            <li><strong>Cash</strong> — lands in the open shift’s drawer.</li>
            <li><strong>Online</strong> — eSewa, Khalti, card and any other digital channel. They’re one bucket on purpose: what matters for the books is that it isn’t cash in the till.</li>
            <li><strong>Credit</strong> — charge a regular’s running account. It counts as a sale now; the cash arrives when the account is settled.</li>
          </ul>
          <p>
            One bill can be split across methods — record part as cash, the rest as online.
            The serve closes when the payments add up to the total exactly; an overpayment
            has to be removed and re-recorded rather than left to round away.
          </p>
          <p>
            Cash payments require an <strong>open shift</strong>. If cash is greyed out,
            nobody opened the drawer.
          </p>
          <AnnotatedShot
            src="/guide/settle.webp"
            alt="The settle dialog"
            caption="Settling closes a serve and records how it was paid."
            pins={[
              { x: 50, y: 38, label: 'The bill total and the balance still owed' },
              { x: 50, y: 51, label: 'Edit the amount to split one bill across methods' },
              { x: 38, y: 68, label: 'Cash, Online, or Credit (collect later)' },
            ]}
          />
          <TryIt to="/admin/history">See settled serves in History</TryIt>
        </>
      ),
    },
    {
      id: 'settle-mistakes',
      heading: 'Fixing a payment you got wrong',
      keywords: ['wrong method', 'mistake', 'remove payment', 'undo', 'reclassify', 'switch cash online', 'refund'],
      body: (
        <>
          <p>
            Two different mistakes, two different fixes:
          </p>
          <ul>
            <li>
              <strong>Right money, wrong method</strong> — a cash payment recorded as
              online. Use the switch arrows next to the payment to reclassify it. The
              amount doesn’t change; only which bucket it landed in.
            </li>
            <li>
              <strong>Wrong money</strong> — remove the payment with the ✕ and record it
              again. A toast offers <em>Undo</em> straight away in case you removed the
              wrong one.
            </li>
          </ul>
          <p>
            Both are recorded. Nothing is silently rewritten — a payment that vanished with
            no trace is the thing this is designed to prevent, and a café where payments
            are frequently retracted will see that raised under <strong>Findings</strong>.
          </p>
          <Collapsible title="A payment on a serve that’s already closed">
            <p>
              You can still reclassify the method from <strong>History</strong>. Changing
              the <em>amount</em> is deliberately harder: a closed serve is meant to be
              frozen, and the honest fix for money that never arrived is a correction in
              the current period, not an edit to last week’s takings.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'settle-tax',
      heading: 'VAT, service charge and discounts on the bill',
      keywords: ['vat', 'tax', 'service charge', 'inclusive', 'exclusive', 'discount', 'reward code'],
      body: (
        <>
          <p>
            How tax appears on the bill is set once, under Settings → Locale &amp; Tax:
          </p>
          <ul>
            <li><strong>No VAT</strong> — nothing is charged or shown anywhere.</li>
            <li><strong>Prices include VAT</strong> — menu prices are the final price; the bill breaks out the VAT portion so the guest can see it.</li>
            <li><strong>Add VAT on top</strong> — VAT is added to the subtotal when the serve closes.</li>
          </ul>
          <p>
            A service charge, if you use one, is applied the same way for every serve.
            Discounts come off before tax is worked out, and always need an explicit{' '}
            <em>Apply</em>. If your café runs a QR rewards campaign, a guest’s winning code
            is entered here and behaves as an ordinary discount.
          </p>
          <p>
            Turning on <strong>Combined discount + settle</strong> (Settings → Workflow)
            puts the discount controls inside this screen, so the cashier applies and
            collects in one place.
          </p>
        </>
      ),
    },
  ],
};
