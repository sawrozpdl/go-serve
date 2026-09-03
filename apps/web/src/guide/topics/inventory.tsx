import { Boxes } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const inventory: GuideTopic = {
  id: 'inventory',
  title: 'Inventory & stock',
  icon: Boxes,
  group: 'Money & stock',
  blurb: 'Stock levels, auto-deduction and low-stock alerts.',
  feature: 'inventory',
  perm: 'inventory:read',
  sections: [
    {
      id: 'inventory-basics',
      heading: 'Stock tracking',
      keywords: ['inventory', 'stock', 'par', 'low stock', 'on hand', 'adjustment', 'restock', 'count'],
      body: (
        <>
          <p>
            Track retail goods and ingredients: what’s on hand, and a{' '}
            <strong>par-low</strong> threshold below which the item is flagged. The
            dashboard shows how many items are low right now, so a stock-out is something
            you find out about before the guest does.
          </p>
          <p>
            Restocks are logged as expenses, so money and stock move together rather than
            drifting apart into two stories.
          </p>
          <AnnotatedShot
            src="/guide/inventory.webp"
            alt="The Inventory screen"
            caption="Stock levels for retail items and ingredients."
            pins={[
              { x: 83, y: 8, label: 'How many items are low on stock right now' },
              { x: 52, y: 24, label: 'On-hand quantity against the par-low threshold' },
              { x: 78, y: 24, label: 'LOW once stock dips below par' },
            ]}
          />
          <TryIt to="/admin/inventory">Open Inventory</TryIt>
        </>
      ),
    },
    {
      id: 'inventory-links',
      heading: 'Linking stock to the menu',
      keywords: ['link', 'auto-deduct', 'deduct', 'per sale', 'combo', 'recipe', 'cigarette'],
      body: (
        <>
          <p>
            Link an inventory item to a menu item and selling one draws the other down
            automatically when the serve closes. One cigarette sold, one stick off the
            shelf. A menu item can pull from several stock items at once — useful for
            combos, or a set that includes a bottled drink.
          </p>
          <Collapsible title="Links track stock, not cost">
            <p>
              Auto-deduction moves quantities; it does not put money into the Profitability
              report. Cost comes from either the menu item’s <em>cost per unit</em> or from
              expenses you allocate. Doing both — a per-unit cost <em>and</em> an allocated
              purchase for the same thing — counts it twice, so pick one approach per
              category and stay with it.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'inventory-honesty',
      heading: 'Keeping the numbers real',
      keywords: ['stocktake', 'adjustment', 'waste', 'spoilage', 'shrinkage', 'count', 'report'],
      body: (
        <p>
          Recorded stock drifts from real stock — breakage, spoilage, a staff snack, a
          miscount. Count for real periodically and record an adjustment for the difference
          rather than editing the number to match. The adjustment is the useful part: it’s
          the only record you’ll ever have of how much is quietly disappearing. The{' '}
          <strong>Stocktake</strong> report template prints on-hand quantities with a
          valuation and every movement, which is the sheet to walk the shelves with.
        </p>
      ),
    },
  ],
};
