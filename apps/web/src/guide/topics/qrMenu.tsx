import { QrCode } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const qrMenu: GuideTopic = {
  id: 'qr-menu',
  title: 'Your public menu',
  icon: QrCode,
  group: 'Grow',
  blurb: 'A QR your guests scan to read the menu on their own phone.',
  sections: [
    {
      id: 'qr-menu-what',
      heading: 'What guests see',
      keywords: ['public menu', 'qr', 'scan', 'guest', 'link', 'share', 'digital menu', 'table tent'],
      body: (
        <>
          <p>
            Your menu has a public web address. A guest who scans the QR gets a clean,
            read-only version of it on their phone — categories, items, prices, photos, and
            any add-ons nested under the item they belong to.
          </p>
          <p>
            It’s read-only in a real sense: there is no way through from that page to any
            staff screen, and it shows nothing about your costs, your takings or your
            people. It stays current on its own, because it <em>is</em> your menu rather
            than a copy of it — change a price here and the guest looking at it sees the new
            one.
          </p>
          <TryIt to="/admin/menu">Open the Menu to share it</TryIt>
        </>
      ),
    },
    {
      id: 'qr-menu-sharing',
      heading: 'Printing and sharing it',
      keywords: ['print', 'download', 'png', 'svg', 'table tent', 'poster', 'copy link', 'template'],
      body: (
        <>
          <p>
            The share button on the Menu page gives you the link to copy, the QR to download
            as an image, and a set of ready-made printable designs for table tents. Print a
            few and put them on the tables — a QR nobody can see earns nothing.
          </p>
          <p>
            The link also works pasted into a Facebook page, a Google listing, or a
            WhatsApp reply to “what do you have?”.
          </p>
        </>
      ),
    },
    {
      id: 'qr-menu-quality',
      heading: 'Making it worth scanning',
      keywords: ['photo', 'image', 'description', 'featured', 'hide item', 'sold out', 'quality'],
      body: (
        <>
          <p>
            The public menu shows what you’ve given it. Two things make the difference
            between a page guests use and one they close:
          </p>
          <ul>
            <li>
              <strong>Photos on your best items.</strong> Not all of them — the ones you want
              people to order.
            </li>
            <li>
              <strong>Descriptions where the name isn’t enough.</strong> “Sadeko” means
              nothing to a visitor.
            </li>
          </ul>
          <Collapsible title="Something you don’t sell any more">
            <p>
              Set the item inactive rather than deleting it. It leaves the public menu
              straight away, and the serves that included it keep pointing at a real item in
              your history instead of a gap.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
