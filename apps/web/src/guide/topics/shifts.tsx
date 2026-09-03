import { Wallet } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const shifts: GuideTopic = {
  id: 'shifts',
  title: 'Cash drawer & shifts',
  icon: Wallet,
  group: 'Daily service',
  blurb: 'Open, drops, close and variance.',
  perm: 'shift:read',
  sections: [
    {
      id: 'shifts-run',
      heading: 'Running a shift',
      tour: 'close-shift',
      keywords: ['open shift', 'close shift', 'float', 'drawer', 'cash drop', 'count', 'variance', 'till'],
      body: (
        <>
          <p>
            A shift tracks the physical cash drawer. Open one with your starting{' '}
            <strong>float</strong> — the cash actually in the till, counted, not guessed.
            Cash payments are blocked until you do.
          </p>
          <p>
            During the shift, record <strong>cash drops</strong> in and out: money taken to
            the bank, change brought in, an expense paid from the till. Every one of them
            changes what the drawer should hold at close, which is the entire point.
          </p>
          <p>
            At close, count the drawer. GoServe compares your count to what it expected
            (float + cash sales + cash collected on credit − drops − cash expenses) and
            stamps the <strong>variance</strong>. Because that variance is locked in, you
            can’t delete cash entries from a closed shift — record a correction in the
            current shift instead.
          </p>
          <AnnotatedShot
            src="/guide/shift.webp"
            alt="The Shift screen"
            caption="A shift tracks the physical cash drawer."
            pins={[
              { x: 53, y: 38, label: 'Expected cash = float + cash in − cash out' },
              { x: 39, y: 66, label: 'Count the drawer at close — the gap is the variance' },
              { x: 88, y: 34, label: 'Past shifts — matched, or the variance flagged' },
            ]}
          />
          <TryIt to="/admin/shift">Open Shift</TryIt>
        </>
      ),
    },
    {
      id: 'shifts-variance',
      heading: 'Reading the variance honestly',
      keywords: ['variance', 'short', 'over', 'discrepancy', 'missing cash', 'reconcile'],
      body: (
        <>
          <p>
            Variance is not an accusation. Small gaps are ordinary — change given wrong, a
            note stuck to another. What matters is the <em>pattern</em>: a drawer that is
            short by a similar amount on the same person’s shifts is telling you something
            a single night never could.
          </p>
          <p>
            The temptation is to “fix” a short drawer by adjusting the count until it
            matches. Don’t. A variance you recorded is information; a variance you papered
            over is a number that lies to you every month afterwards, and the nightly check
            under <strong>Findings</strong> watches this for you precisely because it’s so
            easy to smooth away.
          </p>
          <Collapsible title="Nobody closed last night’s shift">
            <p>
              It happens. Close it when you notice, counting what’s actually there — the
              variance will absorb the gap and the day’s sales are unaffected, since sales
              are counted from serves, not from the drawer. Then open a fresh shift.
              Leaving shifts open for days is worse than a bad variance: nothing reconciles
              and cash expenses have nowhere sensible to land.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'shifts-email',
      heading: 'The shift summary email',
      keywords: ['email', 'summary', 'close', 'owner', 'manager', 'report'],
      body: (
        <p>
          If your plan includes it, closing a shift emails the owners and managers a
          summary — takings, payment split, the drawer count and the variance. It’s the
          cheapest possible oversight: an owner who wasn’t there still sees the night
          before opening their laptop.
        </p>
      ),
    },
  ],
};
