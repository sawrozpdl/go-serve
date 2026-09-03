import { LayoutGrid } from 'lucide-react';

import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const tables: GuideTopic = {
  id: 'tables',
  title: 'Tables & floor plan',
  icon: LayoutGrid,
  group: 'Your café setup',
  blurb: 'The tiles your staff tap all day.',
  sections: [
    {
      id: 'tables-setup',
      heading: 'Setting up your tables',
      keywords: ['table', 'floor plan', 'area', 'capacity', 'seats', 'sort', 'icon', 'terrace', 'rooftop'],
      body: (
        <>
          <p>
            One tile per table. Give each a name your staff already use out loud —{' '}
            <strong>T1</strong>, <strong>Corner</strong>, <strong>Rooftop 3</strong> — not a
            number invented for the software. The whole floor screen is a memory game
            otherwise.
          </p>
          <p>
            <strong>Area</strong> groups tiles when you have more than one room or a
            terrace, <strong>capacity</strong> records how many the table seats, and{' '}
            <strong>sort</strong> lets you lay them out in walking order rather than
            alphabetically. An icon makes a tile findable at a glance on a phone.
          </p>
          <TryIt to="/admin/tables">Open Tables</TryIt>
        </>
      ),
    },
    {
      id: 'tables-lifecycle',
      heading: 'Free, running, and dirty',
      keywords: ['dirty', 'clean', 'free', 'busy', 'auto-clean', 'status', 'archive', 'delete table'],
      body: (
        <>
          <p>
            A table is <strong>free</strong> until someone opens a serve on it; then it’s
            running, and the tile shows the open total and what’s still cooking. When the
            serve closes, the table goes to <strong>dirty</strong> until someone marks it
            clean — a small nudge that makes sure a table gets wiped before the next party.
          </p>
          <p>
            For counter-service or takeaway-first cafés that step is friction with no
            payoff. Turn on <strong>Auto-clean tables on close</strong> under Settings →
            Workflow and a closed serve returns the table straight to free.
          </p>
          <p>
            A table you no longer use is better set inactive than deleted: it disappears
            from the floor while the serves that happened on it stay attached to a real
            name in your history.
          </p>
        </>
      ),
    },
  ],
};
