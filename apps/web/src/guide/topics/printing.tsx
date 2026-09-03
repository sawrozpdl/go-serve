import { Printer } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const printing: GuideTopic = {
  id: 'printing',
  title: 'Printing',
  icon: Printer,
  group: 'Your café setup',
  blurb: 'Kitchen dockets and customer receipts on a thermal printer.',
  feature: 'thermal_printing',
  sections: [
    {
      id: 'printing-what',
      heading: 'Two slips, two moments',
      keywords: ['print', 'receipt', 'docket', 'kitchen ticket', 'thermal', 'bill', '80mm', '58mm'],
      body: (
        <>
          <p>
            Printing is off until you turn it on, and there are exactly two things that
            print:
          </p>
          <ul>
            <li>
              <strong>A kitchen docket when a tab is sent</strong> — the items to cook.
              Anything that skips the kitchen is left off it.
            </li>
            <li>
              <strong>A customer receipt when a tab is settled</strong> — itemised, with
              totals and how it was paid.
            </li>
          </ul>
          <p>
            Set the paper width (80mm for most thermal printers, 58mm for compact ones) and
            write your own header and footer for the receipt — your address, your PAN or VAT
            number, a thank-you.
          </p>
          <TryIt to="/admin/settings">Open Settings → Printing</TryIt>
        </>
      ),
    },
    {
      id: 'printing-devices',
      heading: 'Which device prints what',
      keywords: ['device', 'till', 'tablet', 'auto-print', 'per device', 'localStorage', 'role'],
      body: (
        <>
          <p>
            The choice of <em>what this particular screen prints automatically</em> is saved
            on the device, not on the account. That’s deliberate: the bar tablet should
            auto-print bar dockets while the till auto-prints receipts, and both are signed
            in as the same café.
          </p>
          <p>
            Set it under Settings → Printing on each machine. Leave everything off and that
            device never prints on its own — the manual print buttons still work.
          </p>
          <p>
            The phone app is the easier path here: it talks to a station’s network printer
            directly, using the address you set on the station, with no per-device setup at
            all.
          </p>
        </>
      ),
    },
    {
      id: 'printing-silent',
      heading: 'Getting rid of the print dialog',
      keywords: ['dialog', 'silent print', 'rawbt', 'kiosk', 'chrome', 'android', 'launcher', 'no prompt'],
      body: (
        <>
          <p>
            Browser printing normally opens a dialog, which is unusable when you’re printing
            forty dockets a night. Settings → Printing walks through removing it on both
            platforms — a desktop launcher that starts Chrome in kiosk-printing mode, and
            the <strong>RawBT</strong> print service on Android.
          </p>
          <p>
            Use <strong>Test your setup</strong> there before service rather than
            discovering it during one.
          </p>
          <Collapsible title="Nothing prints, and there’s no error">
            <p>
              Work down in this order: the master <em>Enable printing</em> switch is on; the
              particular slip (kitchen / receipt) is switched on; <em>this device</em> is set
              to auto-print that slip; and the printer is the computer’s default. A silent
              failure is nearly always the third one — the setting that lives on the device
              and doesn’t travel with the account.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
