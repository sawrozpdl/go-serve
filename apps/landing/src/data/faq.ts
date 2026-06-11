/* FAQ copy — single source for both the FAQ section markup and the
 * FAQPage JSON-LD in the head, so the two can never drift. */

export type Faq = { q: string; a: string };

export const FAQS: Faq[] = [
  {
    q: 'What hardware do I need?',
    a: 'Any phone, tablet, or laptop with a browser. GoServe installs as an app (PWA) on the device you already own — no proprietary terminals, no printers required to get started.',
  },
  {
    q: 'Does it work when the internet drops?',
    a: 'Yes. GoServe is offline-first: the floor, menu, and open tabs stay usable, new orders queue on the device, and everything syncs the moment the connection returns.',
  },
  {
    q: 'How much does it cost?',
    a: 'You start on a free trial — no card required. Plans are sized by team seats, and we handle upgrades personally so you only ever pay for what your cafe actually uses.',
  },
  {
    q: 'Can staff have different permissions?',
    a: 'Yes. Role-based access control ships built in: waiters can take orders but not settle or void, managers can discount, and owners see everything — including a full audit trail of every action.',
  },
  {
    q: 'Is it only for cafes in Nepal?',
    a: 'GoServe is built Nepal-first — NPR pricing, eSewa and Khalti QR payments, 13% VAT and service charge handled out of the box — but currency and tax rates are configurable for any cafe.',
  },
  {
    q: 'How do I get started?',
    a: 'Request access and we set your workspace up personally — menu, tables, and team — usually within a day. Most cafes take their first order about five minutes after logging in.',
  },
];
