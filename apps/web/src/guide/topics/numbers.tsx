import { Calculator } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import type { GuideTopic } from '../types';

export const numbers: GuideTopic = {
  id: 'numbers',
  title: 'Reading your numbers',
  icon: Calculator,
  group: 'Money & stock',
  blurb: 'The few rules that explain every figure in the app.',
  sections: [
    {
      id: 'numbers-intro',
      heading: 'How to read the reports',
      tour: 'dashboard',
      keywords: ['dashboard', 'period', 'range', 'timezone', 'close time', 'paid date', 'basis'],
      body: (
        <>
          <p>
            Two ideas explain almost everything: sales-side numbers are placed in a period
            by a serve’s <strong>close (settle) time</strong> in your café’s timezone;
            expense-side numbers by their <strong>paid date</strong>.
          </p>
          <p>
            That single rule answers most “why is this number weird?” questions. A table
            seated at 11pm and settled at 12:10am counts as tomorrow. A long lunch counts
            when it paid, not when it sat down.
          </p>
          <AnnotatedShot
            src="/guide/dashboard.webp"
            alt="The Dashboard"
            caption="Headline numbers for the period you pick."
            pins={[
              { x: 46, y: 8, label: 'Pick the period — Today, 7 days, this month…' },
              { x: 27, y: 56, label: 'Cafe balance, sales, orders and net profit' },
              { x: 46, y: 70, label: 'Daily sales — serves bucketed by close time' },
            ]}
          />
        </>
      ),
    },
    {
      id: 'numbers-rules',
      heading: 'The rules behind every figure',
      keywords: ['rules', 'convention', 'rounding', 'population', 'frozen', 'closed', 'open serve'],
      body: (
        <>
          <ul>
            <li>
              <strong>Open serves are not sales.</strong> A tab that’s still running has
              earned nothing yet. If today looks quiet at 9pm, check the floor before
              checking the report.
            </li>
            <li>
              <strong>Each figure has one population.</strong> Sales counts closed serves;
              expenses count expenses. A number never quietly mixes the two.
            </li>
            <li>
              <strong>Closed means frozen.</strong> A settled serve keeps the prices and
              costs it had at the time. Changing a menu price today does not rewrite last
              month.
            </li>
            <li>
              <strong>Rounding happens once</strong>, at the end, so the parts always sum to
              the whole you’re shown.
            </li>
            <li>
              <strong>Collecting credit is not a sale.</strong> That sale was counted the
              day the food went out.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'numbers-where',
      heading: 'Every figure, worked through with your own data',
      keywords: ['calculation', 'formula', 'arithmetic', 'derivation', 'how is this calculated', 'metric'],
      body: (
        <>
          <p>
            Each individual figure — billed sales, net revenue, credit collected, expected
            cash, variance, the café balance — is broken down on{' '}
            <Link to="/admin/learn/numbers">How the numbers work</Link>, with{' '}
            <strong>your café’s live numbers</strong> in the arithmetic rather than worked
            examples. Every term is re-added on screen, and each block tells you whether it
            reconciles.
          </p>
          <p>
            Every ⓘ in the app links straight to the matching figure there, so you can
            always get from a number on a screen to the derivation behind it.
          </p>
          <Collapsible title="Why show the arithmetic at all?">
            <p>
              Because a written explanation of a formula is easy to produce and impossible
              to check. If the explanation ever drifts from what the code actually does,
              that page shows a warning instead of a tick — the discrepancy is visible
              immediately rather than found months later in an argument about a number.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'numbers-two-bottom-lines',
      heading: 'Why there are two bottom lines',
      keywords: ['net profit', 'gross margin', 'profitability', 'difference', 'does not match', 'bridge'],
      body: (
        <p>
          The Dashboard’s <strong>net</strong> and Profitability’s <strong>net profit</strong>{' '}
          answer different questions, and they’re allowed to differ. Category{' '}
          <strong>gross margin</strong> only counts costs you’ve attached to a category —
          per-unit costs and allocations. <strong>Net profit</strong> counts every expense
          in the period, including rent and wages that belong to no category. The
          calculations page puts the two side by side for the same window and accounts for
          the gap line by line.
        </p>
      ),
    },
  ],
};
