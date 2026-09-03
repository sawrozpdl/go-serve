import { ChefHat } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const kitchen: GuideTopic = {
  id: 'kitchen',
  title: 'The Kitchen display',
  icon: ChefHat,
  group: 'Daily service',
  blurb: 'Tickets, the two columns, and what skips the kitchen.',
  sections: [
    {
      id: 'kitchen-tickets',
      heading: 'Tickets & the two columns',
      keywords: ['kds', 'ticket', 'bump', 'mark ready', 'mark served', 'docket', 'board', 'sound'],
      body: (
        <>
          <p>
            When you <strong>Send</strong> items, they appear as a ticket on the Kitchen
            display (and print a docket if printing is on). The board has two columns:
          </p>
          <ul>
            <li>
              <strong>In Progress</strong> — being made. <em>Mark ready</em> moves an item
              across when it’s done.
            </li>
            <li>
              <strong>Ready</strong> — waiting to go out. <em>Mark served</em> clears it
              off the board.
            </li>
          </ul>
          <p>
            Each ticket shows the table (or the walk-in’s name), how long it’s been
            waiting, any add-ons on the line, and the note the waiter typed. The speaker
            button chimes on new tickets — worth leaving on in a loud kitchen.
          </p>
          <AnnotatedShot
            src="/guide/kitchen.webp"
            alt="The Kitchen display"
            caption="Sent items become tickets; move each one along as it’s made."
            pins={[
              { x: 29, y: 30, label: 'A ticket — what a table sent, with any kitchen notes' },
              { x: 29, y: 37, label: 'Mark ready once it’s made' },
              { x: 68, y: 30, label: 'Ready — done and waiting to be served' },
            ]}
          />
          <TryIt to="/admin/kitchen">Open the Kitchen display</TryIt>
        </>
      ),
    },
    {
      id: 'kitchen-behaviour',
      heading: 'What skips the kitchen',
      keywords: [
        'kitchen behaviour', 'auto ready', 'auto-serve', 'skip', 'inherit',
        'send to kitchen', 'mark ready on send', 'serve immediately', 'cigarettes', 'bottled drink',
      ],
      body: (
        <>
          <p>
            Not everything needs cooking. A bottle of water shouldn’t sit in a queue behind
            the momo. Every category and every item has a{' '}
            <strong>Kitchen behaviour</strong> setting on the Menu page:
          </p>
          <ul>
            <li><strong>Inherit</strong> — use whatever the workspace default is. This is the normal setting.</li>
            <li><strong>Send to kitchen</strong> — the ordinary path: In Progress, then Ready.</li>
            <li><strong>Mark ready on send</strong> — skips the cooking step and lands straight in the Ready column.</li>
            <li><strong>Serve immediately</strong> — never touches the board at all. For cigarettes, packaged drinks, anything handed over across the counter.</li>
          </ul>
          <p>
            The setting is resolved from the most specific place it’s set:{' '}
            <strong>item → category → the workspace default</strong> (Settings → Workflow →{' '}
            <em>Auto-ready on send</em>). So you can make one category ready-on-send and
            still send one item in it to the cook.
          </p>
          <Collapsible title="Auto-serve when the kitchen marks ready">
            <p>
              Separately, Settings → Workflow has <strong>Auto-serve when kitchen marks
              ready</strong>. With it on, there’s no second “served” tap — the cook flipping
              an item to Ready is treated as served. It suits cafés where the cook hands the
              plate straight to the customer, and removes a step nobody was doing anyway.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'kitchen-stations',
      heading: 'More than one prep station',
      keywords: ['station', 'outlet', 'bar', 'multiple kitchens', 'filter'],
      body: (
        <p>
          If your café has separate prep points — a kitchen and a bar — each gets its own
          board. A filter appears across the top of the display so a station can show only
          its own tickets, and each station can print to its own printer. Setting that up is
          covered under <strong>Stations</strong>.
        </p>
      ),
    },
  ],
};
