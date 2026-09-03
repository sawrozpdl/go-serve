import { Smartphone } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import type { GuideTopic } from '../types';

export const mobile: GuideTopic = {
  id: 'mobile-app',
  title: 'The phone app',
  icon: Smartphone,
  group: 'Start here',
  blurb: 'Go Serve on Android — the same café, in your hand.',
  sections: [
    {
      id: 'mobile-what',
      heading: 'What the app is for',
      keywords: ['android', 'phone', 'tablet', 'app', 'go serve', 'play store', 'install', 'mobile'],
      body: (
        <>
          <p>
            <strong>Go Serve</strong> is the Android app for the same café you see here.
            It isn’t a cut-down viewer — a waiter can run a whole service on it: take the
            order, send to the kitchen, settle the bill, print the docket.
          </p>
          <p>
            It’s built for the people on their feet. The owner’s work — reports, expenses,
            settings — is easier in a browser on a bigger screen, and the app carries the
            common parts of it under <strong>More</strong>.
          </p>
        </>
      ),
    },
    {
      id: 'mobile-layout',
      heading: 'Finding your way around',
      keywords: ['tabs', 'floor', 'kitchen', 'history', 'more', 'navigation'],
      body: (
        <>
          <p>Four tabs along the bottom:</p>
          <ul>
            <li><strong>Floor</strong> — tables and walk-ins, and every open tab.</li>
            <li><strong>Kitchen</strong> — the same ticket board as the web display.</li>
            <li><strong>History</strong> — serves you’ve already closed.</li>
            <li><strong>More</strong> — everything else.</li>
          </ul>
          <p>
            <strong>More</strong> is grouped the way the sidebar here is:{' '}
            <em>Catalog</em> (Menu, Tables, Stations, Inventory), <em>Finance</em>{' '}
            (Dashboard, Cash drawer, Expenses, Credit), <em>People</em> (Team),{' '}
            <em>Setup</em> (Settings, Printing), plus <em>Sync</em> when there’s anything
            waiting, and <em>Help</em> for feedback and contact. Rows you don’t have
            permission for simply aren’t there.
          </p>
        </>
      ),
    },
    {
      id: 'mobile-signin',
      heading: 'Signing in',
      keywords: ['login', 'google', 'sign in', 'workspace', 'demo', 'guest'],
      body: (
        <>
          <p>
            Sign in with the same account you use here. If you belong to more than one
            café, you’ll pick the workspace after signing in; with only one, it takes you
            straight in.
          </p>
          <p>
            The app also has a <strong>guest demo</strong> mode with invented data, for
            trying it out before an account exists. Nothing in demo mode touches a real
            café.
          </p>
          <Collapsible title="“Access needed” after signing in">
            <p>
              That screen means the account signed in successfully but isn’t a member of
              any café yet — an owner needs to invite that email address under{' '}
              <strong>People → Members</strong>. It is not a password problem, and signing
              in again won’t change it.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'mobile-offline-printing',
      heading: 'Offline and printing',
      keywords: ['offline', 'printer', 'bluetooth', 'network printer', 'sync', 'esc/pos'],
      body: (
        <>
          <p>
            The app keeps working when the wifi drops — see <strong>Working offline</strong>{' '}
            for what is and isn’t safe to do. Anything queued syncs when the connection is
            back, and anything that needs a human eye lands in{' '}
            <strong>More → Sync review</strong>.
          </p>
          <p>
            Printing is the app’s advantage over the browser: it talks to a network
            (ESC/POS) printer directly, so a docket prints with no dialog and no laptop in
            the middle. Set the printer’s address on each station under{' '}
            <strong>Stations</strong>, then choose what this particular device prints under{' '}
            <strong>More → Printing</strong>.
          </p>
        </>
      ),
    },
    {
      id: 'mobile-updates',
      heading: 'Updates',
      keywords: ['update', 'version', 'ota', 'upgrade'],
      body: (
        <p>
          <strong>More → About &amp; updates</strong> shows the version you’re running and
          checks for a new one. Most updates arrive on their own the next time the app
          starts with a connection; occasionally a bigger one comes through the Play Store
          like any other app.
        </p>
      ),
    },
  ],
};
