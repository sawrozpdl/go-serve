import { Compass } from 'lucide-react';

import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const welcome: GuideTopic = {
  id: 'welcome',
  title: 'Welcome to GoServe',
  icon: Compass,
  group: 'Start here',
  blurb: 'The big picture and how to use this guide.',
  sections: [
    {
      id: 'welcome-flow',
      heading: 'How a day flows',
      tour: 'first-serve',
      keywords: ['overview', 'basics', 'day', 'workflow', 'loop', 'start'],
      body: (
        <>
          <p>
            GoServe runs your cafe end-to-end. The core loop is simple, and everything
            else (reports, money, stock) flows from it:
          </p>
          <ol className="guide-steps">
            <li><strong>Open a shift</strong> so the cash drawer is live.</li>
            <li><strong>Take orders on the Floor</strong> — a “serve” is one table’s tab or a walk-in.</li>
            <li><strong>Send</strong> items to the Kitchen display / printer.</li>
            <li><strong>Settle</strong> when the guest pays (cash, online, or credit).</li>
            <li><strong>Close the shift</strong> and count the drawer at the end.</li>
          </ol>
          <p>
            A serve only counts toward Sales and History once it’s <strong>settled
            (closed)</strong> — that single fact explains most of how the numbers behave.
          </p>
          <TryIt to="/admin/floor">Open the Floor</TryIt>
        </>
      ),
    },
    {
      id: 'welcome-using',
      heading: 'Using this guide',
      keywords: ['help', 'search', 'walkthrough', 'tour', 'support', 'contact'],
      body: (
        <>
          <p>
            Topics are grouped on the left: <strong>Start here</strong> to get going,{' '}
            <strong>Daily service</strong> for the things you do every shift,{' '}
            <strong>Your café setup</strong> for the one-time configuration,{' '}
            <strong>Money &amp; stock</strong> for where the numbers come from,{' '}
            <strong>Grow</strong> for the guest-facing extras, and{' '}
            <strong>Reference</strong> for the glossary and FAQ. Or just search — it
            matches topic names, headings and keywords.
          </p>
          <p>
            Anywhere you see an <strong>ⓘ</strong> next to a number in the app, hover it
            for a quick explanation and a “Learn more →” link straight into{' '}
            <strong>How the numbers work</strong>, where that same figure is re-added in
            front of you using your café’s live data.
          </p>
          <p>
            The <strong>Walkthroughs</strong> tab takes over the real screens and points
            at the real controls, step by step. Nothing is saved or sent on your behalf.
          </p>
          <p>
            Still stuck? <strong>Contact us</strong> at the bottom of the sidebar reaches
            a human, and <strong>Report a bug</strong> in the account menu sends us the
            screen you’re on.
          </p>
        </>
      ),
    },
    {
      id: 'welcome-vocab',
      heading: 'Five words worth learning first',
      keywords: ['terms', 'vocabulary', 'serve', 'tab', 'settle', 'shift', 'station'],
      body: (
        <>
          <dl className="guide-glossary">
            <dt>Serve</dt>
            <dd>One order — a table’s bill, or a walk-in. The unit everything counts in.</dd>
            <dt>Tab</dt>
            <dd>A serve while it’s still open. Items go on the tab; the tab becomes a bill.</dd>
            <dt>Send</dt>
            <dd>Push what’s on the tab to the kitchen. Nothing is cooked until you send.</dd>
            <dt>Settle</dt>
            <dd>Take payment and close the serve. This is the moment it becomes Sales.</dd>
            <dt>Shift</dt>
            <dd>One session of the physical cash drawer, opened with a float and closed with a count.</dd>
          </dl>
          <p>
            The full list is in the <strong>Glossary</strong> under Reference.
          </p>
        </>
      ),
    },
  ],
};
