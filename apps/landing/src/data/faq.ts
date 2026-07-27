/* FAQ copy — single source for both the FAQ section markup and the
 * FAQPage JSON-LD in the head, so the two can never drift. */

import { PLANS, effectiveYearly, formatRs, listYearly } from './plans';

export type Faq = { q: string; a: string };

/* The cheapest paid tier, at the price we actually charge. Interpolated into the
 * "how much does it cost" answer so it can't drift from the pricing table — and
 * so retiring LAUNCH puts the list price back automatically. */
const entry = PLANS.find((p) => effectiveYearly(p) != null);
const entryNow = entry ? effectiveYearly(entry) : null;
const entryWas = entry ? listYearly(entry) : null;
const priceSentence =
  entryNow == null
    ? 'Plans are tailored to your group'
    : entryWas != null
      ? `Plans start at ${formatRs(entryNow)} a year — a launch discount off the usual ${formatRs(entryWas)} — billed yearly`
      : `Plans start at ${formatRs(entryNow)} a year, billed yearly`;

export const FAQS: Faq[] = [
  {
    q: 'What hardware do I need?',
    a: 'Any phone, tablet, or laptop with a browser. GoServe installs as an app (PWA) on the device you already own — no proprietary terminals. A thermal printer is optional; you can start with just your phone.',
  },
  {
    q: 'Does it work when the internet drops?',
    a: 'Yes. GoServe is offline-first: the floor, menu, and open tabs stay usable, new orders queue on the device, and everything syncs the moment the connection returns. Built for real cafe wifi and load-shedding.',
  },
  {
    q: 'How much does it cost?',
    a: `${priceSentence}, and every one begins with a free 30-day trial — no card required. See the pricing page for what each plan includes.`,
  },
  {
    q: 'Do you support eSewa and Khalti?',
    a: 'Yes. GoServe is Nepal-first: NPR pricing, eSewa and Khalti QR payments, and 13% VAT plus service charge handled out of the box. Cash, card, bank, and credit tabs are all tracked in one place.',
  },
  {
    q: 'Can staff have different permissions?',
    a: 'Yes. Role-based access ships built in: waiters take orders but cannot settle or void, managers can discount, and owners see everything. Custom roles and a full audit trail are available on higher plans.',
  },
  {
    q: 'Is my data mine? Can I export it?',
    a: 'It’s yours. You can export your data at any time, and we never sell it or lock it away. Your cafe’s numbers belong to your cafe.',
  },
  {
    q: 'Do you help me get set up?',
    a: 'Always. A real person sets your workspace up — menu, tables, team, taxes — usually within a day, and we’re a message away after that. Most cafes take their first order about five minutes after logging in.',
  },
  {
    q: 'Can I run more than one outlet?',
    a: 'Yes, on the Enterprise plan — multiple prep stations and outlets with their own kitchen displays and printers, managed from one account. Talk to us and we’ll tailor it to your group.',
  },
  {
    q: 'Is it only for cafes in Nepal?',
    a: 'It’s built Nepal-first, but currency, tax rates, and payment methods are configurable — so it works for cafes and small restaurants anywhere.',
  },
];
