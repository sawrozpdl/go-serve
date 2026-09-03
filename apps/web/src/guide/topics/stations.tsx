import { Store } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const stations: GuideTopic = {
  id: 'stations',
  title: 'Stations',
  icon: Store,
  group: 'Your café setup',
  blurb: 'A kitchen and a bar that don’t share a ticket queue.',
  feature: 'multi_outlet',
  sections: [
    {
      id: 'stations-what',
      heading: 'When you need more than one',
      keywords: ['station', 'outlet', 'bar', 'coffee counter', 'prep', 'multiple', 'routing'],
      body: (
        <>
          <p>
            A <strong>station</strong> is a place where food or drink is actually prepared —
            Kitchen, Bar, Coffee counter. If everything in your café is made in one place,
            you don’t need this: the default station handles it and you can ignore the page
            entirely.
          </p>
          <p>
            You need stations when one ticket queue is genuinely two. The cook shouldn’t
            scroll past six lattes to find the momo, and the bar shouldn’t be printing
            dockets for fried rice.
          </p>
          <TryIt to="/admin/outlets">Open Stations</TryIt>
        </>
      ),
    },
    {
      id: 'stations-routing',
      heading: 'How an item finds its station',
      keywords: ['default station', 'route', 'category station', 'item station', 'fallback'],
      body: (
        <>
          <p>
            Set a station on a whole <strong>category</strong> — all drinks to the Bar — and
            override it on individual <strong>items</strong> where the category is wrong.
            Anything with no station set goes to the one marked <strong>Default</strong>,
            which is why exactly one station always carries that star.
          </p>
          <p>
            On the Kitchen display, a filter appears across the top so each screen can show
            only its own station’s tickets.
          </p>
          <Collapsible title="Stations and kitchen behaviour are different questions">
            <p>
              They’re easy to confuse and they don’t interact. <strong>Station</strong>{' '}
              answers <em>where</em> the ticket goes. <strong>Kitchen behaviour</strong>{' '}
              answers <em>whether there’s a ticket at all</em> — an item set to “serve
              immediately” never reaches any board, no matter which station it’s assigned
              to.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'stations-printers',
      heading: 'A printer per station',
      keywords: ['printer', 'ip', 'esc/pos', 'network printer', 'port', 'paper width', '80mm', 'docket'],
      body: (
        <>
          <p>
            Each station can hold the address of its own network (ESC/POS) printer — an IP,
            a port (usually 9100) and the paper width. The phone app prints straight to it,
            so a bar docket comes out at the bar with no laptop involved.
          </p>
          <p>
            Browser printing works differently: it goes to whatever printer that computer
            has as its default. So on web you choose, per device, which stations’ slips this
            machine prints automatically — under Settings → Printing. The till prints
            receipts, the kitchen tablet prints kitchen dockets, and neither prints the
            other’s.
          </p>
        </>
      ),
    },
  ],
};
