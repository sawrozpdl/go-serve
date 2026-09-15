import { LayoutGrid } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const floor: GuideTopic = {
  id: 'floor',
  title: 'Taking orders (Floor)',
  icon: LayoutGrid,
  group: 'Daily service',
  blurb: 'Tables, walk-ins, items, add-ons, splitting and discounts.',
  sections: [
    {
      id: 'floor-basics',
      heading: 'Tables & walk-ins',
      keywords: ['table', 'walk-in', 'takeaway', 'delivery', 'tab', 'open', 'serve', 'unknown'],
      body: (
        <>
          <p>
            The Floor shows every table at a glance. Tap a free table to start a serve;
            tap a running one to open its tab. For food leaving the building, use the{' '}
            <strong>Takeaway</strong> tile.
          </p>
          <p>
            A takeaway opens straight away without asking for a name, so the queue never
            waits on typing. Tap the name at the top of the tab to give it one —
            “Suresh”, “blue jacket”, “phone order” — and it shows up that way on the
            floor, on the docket and in History.
          </p>
          <p>
            Every serve is <strong>dine-in</strong>, <strong>takeaway</strong> or{' '}
            <strong>delivery</strong>, and the chips at the top of a tab switch between
            them at any point — a table that decides to take it with them keeps its
            table. Anything that isn’t dine-in prints in bold on the kitchen docket, so
            the cook knows to box it without reading the rest of the ticket.
          </p>
          <AnnotatedShot
            src="/guide/floor.webp"
            alt="The Floor screen"
            caption="The floor map — tap a tile to open or resume a serve."
            pins={[
              { x: 27, y: 24, label: 'A running serve — the open total, item count and what’s cooking' },
              { x: 42, y: 24, label: 'A free table — tap to start a serve' },
              { x: 27, y: 66, label: 'Takeaway — a serve with no table' },
            ]}
          />
          <TryIt to="/admin/floor">Open the Floor</TryIt>
        </>
      ),
    },
    {
      id: 'floor-items',
      heading: 'Adding items, add-ons and notes',
      keywords: ['add item', 'quantity', 'add-on', 'modifier', 'extra', 'note', 'half plate', 'send', 'kitchen'],
      body: (
        <>
          <p>
            On a tab, add menu items and adjust quantities. Two things worth knowing:
          </p>
          <ul>
            <li>
              <strong>Adding is not sending.</strong> Items sit on the tab until you{' '}
              <strong>Send</strong> them; only then does the kitchen see them. You can keep
              adding to a tab after a send — the new items go as a second ticket.
            </li>
            <li>
              <strong>Items with add-ons open a picker.</strong> Choosing “extra cheese”
              folds its price into that line, so the bill shows one honest amount rather
              than a base price with surprises underneath.
            </li>
          </ul>
          <p>
            Items set up for <strong>half plates</strong> can be ordered in ½ steps (½, 1½,
            3½…) with the price scaling to match — useful for momo and other shareable
            plates. Notes go on a line for anything the kitchen needs to know; items with{' '}
            <em>quick notes</em> configured offer them as one-tap chips.
          </p>
        </>
      ),
    },
    {
      id: 'floor-changes',
      heading: 'Discounts, moving, and taking things off',
      keywords: ['discount', 'void', 'move table', 'merge', 'transfer', 'cancel', 'remove item', 'reward'],
      body: (
        <>
          <p>
            <strong>Discounts</strong> are a flat amount or a percentage with a reason, and
            they always need an explicit <em>Apply</em> — so a half-typed number is never
            applied by accident. Your café’s usual mode and reason can be pre-filled under
            Settings → Workflow.
          </p>
          <p>
            <strong>Move or merge</strong> shifts a whole tab to another table, or joins two
            tabs — for guests who change table, or two tables that turn out to be one party.
          </p>
          <Collapsible title="Removing an item, before and after it’s sent">
            <p>
              Before it’s sent, removing an item is just editing the tab — nothing happened
              yet. Once it’s <em>sent</em>, taking it off is a <strong>void</strong>: it
              asks for a reason and is recorded, because by then food may have been made.
            </p>
            <p>
              On an already-closed serve the total doesn’t change. Voids there are tracked
              for oversight, not to rewrite history — and a café whose void rate climbs
              will see it raised under <strong>Findings</strong>.
            </p>
          </Collapsible>
          <Collapsible title="A guest has a reward code">
            <p>
              If you run a QR rewards campaign, the guest shows a code they won on their
              phone. Enter it at settle and it applies as a discount on this bill. Codes
              are short-lived on purpose — see <strong>QR rewards</strong>.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
