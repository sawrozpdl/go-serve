import { WifiOff } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import type { GuideTopic } from '../types';

export const offline: GuideTopic = {
  id: 'offline',
  title: 'Working offline',
  icon: WifiOff,
  group: 'Daily service',
  blurb: 'What still works when the internet drops — and what doesn’t.',
  sections: [
    {
      id: 'offline-basics',
      heading: 'What keeps working',
      keywords: ['offline', 'internet', 'wifi', 'no connection', 'down', 'power cut', 'queue'],
      body: (
        <>
          <p>
            When the connection drops, the app says so and keeps going. Taking the order
            still works: you can add items, change quantities, void a line that hasn’t been
            sent, and send to the kitchen. Those changes are held on the device and replay
            in order the moment you’re back.
          </p>
          <p>
            Order writes are built so a replay can’t double-post: if a send went through
            just as the wifi died, it won’t become two tickets when the connection returns.
          </p>
        </>
      ),
    },
    {
      id: 'offline-limits',
      heading: 'What is deliberately blocked',
      keywords: ['cannot', 'blocked', 'settle offline', 'payment offline', 'discount', 'kitchen offline'],
      body: (
        <>
          <p>
            <strong>Taking payment is not available offline.</strong> Neither are discounts
            or closing a serve. That’s a decision, not a gap: settling needs the server’s
            answer. Another device may have settled the same tab, the drawer has to be
            real, and the total has to be authoritative. A payment recorded blind is worse
            than a payment recorded a few minutes later.
          </p>
          <p>
            Kitchen ticket updates also need a connection — the board is shared between
            devices, so bumping an item offline would tell the cook something no one else
            can see.
          </p>
          <p>
            If the outage is long, the honest fallback is paper: take the order in the app,
            write the money down, enter it when you’re back.
          </p>
        </>
      ),
    },
    {
      id: 'offline-sync-review',
      heading: 'The sync review tray',
      keywords: ['sync', 'review', 'rejected', 'conflict', 'failed', 'reconnect'],
      body: (
        <>
          <p>
            Most queued changes replay silently. Occasionally the server refuses one —
            because the tab was settled on another device while you were offline, or an
            item was deleted from the menu meanwhile. Those don’t disappear. They land in
            the <strong>sync review</strong> tray for a person to decide about.
          </p>
          <Collapsible title="Why not just apply them anyway?">
            <p>
              Because both possible outcomes are wrong to guess at. Silently applying a
              line to a serve that’s already closed rewrites a settled bill; silently
              dropping it loses food that was actually made and eaten. The only correct
              answer comes from someone who was there — so the app asks rather than
              chooses.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
