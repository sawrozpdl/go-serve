import { HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Collapsible } from '@/components/Collapsible';
import type { GuideTopic } from '../types';

export const faq: GuideTopic = {
  id: 'faq',
  title: 'FAQ',
  icon: HelpCircle,
  group: 'Reference',
  blurb: 'The questions people actually ask, grouped by area.',
  sections: [
    {
      id: 'faq-numbers',
      heading: 'My numbers look wrong',
      keywords: ['wrong', 'mismatch', 'missing sales', 'zero', 'does not match', 'profit', 'peak hours'],
      body: (
        <>
          <Collapsible title="Today’s sales look too low">
            <p>
              Almost always open serves. A serve only becomes Sales when it’s{' '}
              <strong>settled</strong> — check the Floor for tabs still running. After that,
              check the date boundary: a table settled at 12:10am counts as the next day, in
              your café’s timezone.
            </p>
          </Collapsible>
          <Collapsible title="Why don’t my Profitability margins match Net profit?">
            <p>
              They’re different lenses. Category gross margin only counts costs you’ve
              attributed to a category (per-unit cost + allocations). Net profit counts{' '}
              <em>every</em> expense for the period, including rent and wages. See{' '}
              <Link to="/admin/learn/numbers#metric-profit-net">Net profit</Link>.
            </p>
          </Collapsible>
          <Collapsible title="I collected a big old debt — why didn’t sales go up?">
            <p>
              Because that sale was already counted on the day the food went out. Counting
              it again when the cash arrives would report the same meal twice. It shows as{' '}
              <strong>credit collected</strong> instead, and your café balance rises.
            </p>
          </Collapsible>
          <Collapsible title="Every item shows 100% margin">
            <p>
              No cost per unit is set on your menu items, so the report has nothing to
              subtract. Fill in <em>cost per unit</em> on the Menu page, or allocate
              purchase expenses to categories — see <strong>Your menu</strong>.
            </p>
          </Collapsible>
          <Collapsible title="Why does ‘Peak hours’ look later than our rush?">
            <p>
              It buckets serves by their <strong>close time</strong>, not when the table was
              seated — so a long lunch shows under when it paid. See{' '}
              <Link to="/admin/learn/numbers#metric-peak-hours">Peak hours</Link>.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'faq-service',
      heading: 'During service',
      keywords: ['cannot', 'blocked', 'cash', 'kitchen', 'printer', 'stuck', 'not showing'],
      body: (
        <>
          <Collapsible title="Can’t take a cash payment?">
            <p>Open a shift first — cash is blocked until the drawer is open.</p>
          </Collapsible>
          <Collapsible title="The kitchen never got the order">
            <p>
              Adding items to a tab is not the same as <strong>sending</strong> them. Open
              the tab and check for unsent lines. If it was sent and still isn’t on the
              board, check the item’s kitchen behaviour — items set to “serve immediately”
              deliberately never appear there.
            </p>
          </Collapsible>
          <Collapsible title="Nothing is printing">
            <p>
              Work down in order: the master <em>Enable printing</em> switch, the individual
              kitchen/receipt toggles, and then <em>this device’s</em> auto-print setting —
              which is saved on the device and doesn’t travel with your account. See{' '}
              <strong>Printing</strong>.
            </p>
          </Collapsible>
          <Collapsible title="We’re offline — what can we still do?">
            <p>
              Take orders and send to the kitchen. Not settle, discount or close: those need
              the server’s answer. Anything you do offline replays when you’re back, and
              anything the server refuses lands in the sync review tray. See{' '}
              <strong>Working offline</strong>.
            </p>
          </Collapsible>
          <Collapsible title="A guest wants to move table">
            <p>
              Use <strong>Move / merge tab</strong> on the tab. Moving onto a table that
              already has a tab merges the two, after asking.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'faq-money',
      heading: 'Cash and corrections',
      keywords: ['variance', 'mistake', 'delete', 'refund', 'wrong method', 'owner cash', 'drawer'],
      body: (
        <>
          <Collapsible title="The drawer is short. Should I adjust the count?">
            <p>
              No. Enter what’s actually there and let the variance record itself. A variance
              you papered over is a number that misleads you every month afterwards; a
              variance you recorded is information — and the pattern across shifts is the
              part worth reading.
            </p>
          </Collapsible>
          <Collapsible title="I recorded a payment with the wrong method">
            <p>
              Use the switch arrows next to the payment to reclassify it between cash and
              online. The amount doesn’t change. This works from History too, on a serve
              that’s already closed.
            </p>
          </Collapsible>
          <Collapsible title="I deleted an expense — why didn’t the owner-cash movement go?">
            <p>
              It does. Deleting the expense reverses its owner-cash movement automatically;
              the “Cash with owners” list and the balances refresh with it.
            </p>
          </Collapsible>
          <Collapsible title="Can I edit a serve from last week?">
            <p>
              Deliberately not. A closed serve is frozen, prices and costs and all. The
              honest fix for money that never arrived is a correction recorded in the
              current period — which is also the version an accountant can follow.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'faq-access',
      heading: 'Accounts, access and plans',
      keywords: ['login', 'invite', 'permission', 'seat', 'upgrade', 'trial', 'read-only', 'cannot see'],
      body: (
        <>
          <Collapsible title="A staff member can’t see a page I can">
            <p>
              Their role doesn’t hold the permission for it. Everything in the sidebar is
              derived from permissions — see <strong>People, roles &amp; staff</strong>.
              Check the plan too: some pages need both the permission and the plan feature.
            </p>
          </Collapsible>
          <Collapsible title="We’re out of seats but I don’t have that many people">
            <p>
              Pending invites count toward the seat limit. An invitation you sent and forgot
              occupies a seat exactly as a person does — revoke the ones nobody accepted.
            </p>
          </Collapsible>
          <Collapsible title="Our trial ended and everything is read-only">
            <p>
              Nothing is deleted. You can still see and export everything, and paying picks
              up exactly where you stopped. The contact button is on Settings → Plan &amp;
              usage.
            </p>
          </Collapsible>
          <Collapsible title="Is my data mine? Can I export it?">
            <p>
              It’s yours. Reports export as PDFs, and Settings → Privacy &amp; Data exports
              your personal data. Your café’s numbers belong to your café.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'faq-general',
      heading: 'Setup and the product',
      keywords: ['hardware', 'printer', 'esewa', 'khalti', 'vat', 'multiple outlets', 'help', 'support', 'setup'],
      body: (
        <>
          <Collapsible title="What hardware do I need?">
            <p>
              Any phone, tablet or laptop with a browser, plus the Android app if you want
              it. A thermal printer is optional — plenty of cafés start with just a phone.
            </p>
          </Collapsible>
          <Collapsible title="Do you support eSewa and Khalti?">
            <p>
              Yes. They’re recorded under <strong>Online</strong>, alongside card and any
              other digital channel, with an optional transaction reference. NPR pricing and
              VAT plus service charge are handled out of the box.
            </p>
          </Collapsible>
          <Collapsible title="Can I run more than one prep station?">
            <p>
              Yes — a Kitchen and a Bar with their own displays and printers. See{' '}
              <strong>Stations</strong>. Whether it’s on your plan is shown at Settings →
              Plan &amp; usage.
            </p>
          </Collapsible>
          <Collapsible title="Something is broken, or I can’t find an answer here">
            <p>
              <strong>Contact us</strong> at the bottom of the sidebar reaches a real
              person. <strong>Report a bug</strong> in the account menu sends us the screen
              you were on, which usually saves a round of questions.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
