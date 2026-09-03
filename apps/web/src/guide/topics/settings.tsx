import { Settings as SettingsIcon } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const settings: GuideTopic = {
  id: 'settings',
  title: 'Settings',
  icon: SettingsIcon,
  group: 'Your café setup',
  blurb: 'Identity, hours, workflow, tax, privacy — the nine tabs.',
  perm: 'tenant:update',
  sections: [
    {
      id: 'settings-tour',
      heading: 'What lives where',
      keywords: ['settings', 'identity', 'branding', 'hours', 'workflow', 'locale', 'tax', 'privacy', 'plan'],
      body: (
        <>
          <p>Settings is nine tabs. In the order you’ll need them:</p>
          <ul>
            <li><strong>Identity</strong> — name, phone, address, the details that appear on a receipt.</li>
            <li><strong>Branding</strong> — logo and colours.</li>
            <li><strong>Personality</strong> — a mood preset, heading typeface, till text size and the app’s tone of voice.</li>
            <li><strong>Hours</strong> — when you’re open. Drives the staff timeline and the public menu.</li>
            <li><strong>Workflow</strong> — the toggles that decide how many taps a service takes.</li>
            <li><strong>Printing</strong> — dockets and receipts. See <strong>Printing</strong>.</li>
            <li><strong>Locale &amp; Tax</strong> — timezone, currency and VAT handling.</li>
            <li><strong>Privacy &amp; Data</strong> — export or delete your own account data.</li>
            <li><strong>Plan &amp; usage</strong> — your subscription and seats. See <strong>Your plan</strong>.</li>
          </ul>
          <AnnotatedShot
            src="/guide/settings.webp"
            alt="The Settings screen"
            caption="Everything that shapes your cafe and its reports."
            pins={[
              { x: 50, y: 17, label: 'Tabs for hours, workflow, printing and more' },
              { x: 75, y: 17, label: 'Locale & tax — timezone and VAT mode' },
              { x: 47, y: 42, label: 'Identity & branding — name and logo' },
            ]}
          />
          <TryIt to="/admin/settings">Open Settings</TryIt>
        </>
      ),
    },
    {
      id: 'settings-early',
      heading: 'The two you should get right before you trade',
      keywords: ['timezone', 'vat mode', 'first', 'important', 'cannot change'],
      body: (
        <>
          <p>
            <strong>Timezone</strong> decides where the day boundary falls. Every sales
            figure buckets a serve by its close time in your café’s timezone, so getting
            this wrong shifts the entire night before midnight into the wrong day.
          </p>
          <p>
            <strong>VAT handling</strong> — none, prices include VAT, or VAT on top —
            changes how every bill is built. You can change it later, but it doesn’t rewrite
            serves that are already closed, so a mid-month switch leaves you with two kinds
            of history in one report.
          </p>
        </>
      ),
    },
    {
      id: 'settings-workflow',
      heading: 'Workflow — removing taps',
      keywords: [
        'auto-serve', 'auto-ready', 'auto-clean', 'combined settle', 'auto record payment',
        'txn reference', 'discount default', 'morning brief email',
      ],
      body: (
        <>
          <p>
            Each toggle here removes a step. Which ones suit you depends entirely on how
            your floor actually moves:
          </p>
          <ul>
            <li><strong>Auto-serve when kitchen marks ready</strong> — for cafés where the cook hands the plate over directly.</li>
            <li><strong>Auto-ready on send</strong> — the workspace default for kitchen behaviour; categories and items can override it.</li>
            <li><strong>Auto-clean tables on close</strong> — for counter-service floors with no “wipe it down” step.</li>
            <li><strong>Auto-record payment</strong> — typing the amount records it, with no extra tap.</li>
            <li><strong>Ask for txn reference on online payments</strong> — off by default, because most cashiers skip it.</li>
            <li><strong>Combined discount + settle</strong> — one screen instead of two.</li>
          </ul>
          <p>
            This tab also holds the <strong>morning brief</strong> switch. Turning the email
            off doesn’t stop the nightly check — the findings still appear under{' '}
            <strong>Findings</strong>; you just stop being emailed about them.
          </p>
          <Collapsible title="Discount defaults">
            <p>
              You can pre-fill the usual discount mode (flat or percentage) and reason. What
              you can’t turn off is the explicit <em>Apply</em> tap — a half-typed “5” on
              the way to “50” must never be applied on its own.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'settings-privacy',
      heading: 'Privacy & data',
      keywords: ['export', 'delete account', 'gdpr', 'my data', 'download'],
      body: (
        <p>
          <strong>Export your data</strong> downloads what the system holds about you as a
          person. <strong>Delete account</strong> removes your own account, and asks you to
          type a confirmation phrase because it can’t be undone. Both act on{' '}
          <em>you</em>, not on the café: deleting your account doesn’t delete the café’s
          trading history, which belongs to the business.
        </p>
      ),
    },
  ],
};
