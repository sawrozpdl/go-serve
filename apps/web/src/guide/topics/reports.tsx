import { BarChart3 } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const reports: GuideTopic = {
  id: 'reports',
  title: 'Reports & PDFs',
  icon: BarChart3,
  group: 'Money & stock',
  blurb: 'Profitability, movers, and a printable pack for anyone who asks.',
  perm: 'report:read',
  sections: [
    {
      id: 'reports-profitability',
      heading: 'Profitability',
      keywords: ['profitability', 'margin', 'category', 'p&l', 'profit and loss', 'drilldown'],
      body: (
        <>
          <p>
            Profit and loss by menu category. For each one: what it sold, what it cost —
            per-unit costs plus anything you allocated — and what’s left. Drill into a
            category to see which items are carrying it and which are along for the ride.
          </p>
          <p>
            It’s only as good as your cost data. A category with no costs recorded shows a
            100% margin, which is flattering and false. The page tells you what proportion
            of sales has real costs behind it, so you know how much weight to give it.
          </p>
          <TryIt to="/admin/reports/profitability">Open Profitability</TryIt>
        </>
      ),
    },
    {
      id: 'reports-movers',
      heading: 'Movers',
      keywords: ['movers', 'top sellers', 'trend', 'up', 'down', 'compare', 'item sales'],
      body: (
        <p>
          Movers compares this period against the one before it, item by item: what’s
          climbing, what’s falling away. It answers a different question from top sellers —
          your best-selling item is rarely news, but the item that dropped 40% this month is.
          Watch out for the obvious trap: a two-week window against a two-week window is a
          comparison; a two-week window against a month is not.
        </p>
      ),
    },
    {
      id: 'reports-builder',
      heading: 'Building a PDF',
      keywords: ['pdf', 'print', 'export', 'report builder', 'template', 'accountant', 'landlord', 'monthly'],
      body: (
        <>
          <p>
            <strong>Build a PDF</strong> assembles a proper document: pick a period, pick
            the sections, see the exact pages, then save or print. Start from a template and
            change anything:
          </p>
          <ul>
            <li><strong>Daily close</strong> — the end-of-day pack: drawer reconciliation, what sold, what was paid out.</li>
            <li><strong>Monthly P&amp;L</strong> — net revenue, margin by category, every expense.</li>
            <li><strong>Owner / board pack</strong> — trading, position and equity, against the previous period.</li>
            <li><strong>Tax / VAT pack</strong> — what was billed, what VAT was collected, every expense with its vendor.</li>
            <li><strong>Stocktake</strong> — stock on hand with valuation, and every movement.</li>
            <li><strong>Payroll</strong> — who’s on the books and what they were actually paid.</li>
            <li><strong>Menu performance</strong> — which items and categories earn their place.</li>
            <li><strong>Operations review</strong> — when you’re busy, how fast you turn, where tables earn.</li>
            <li><strong>Start from scratch</strong> — pick your own sections.</li>
          </ul>
          <p>
            A layout you build can be saved and reused, so next month is one click.
          </p>
          <TryIt to="/admin/reports/builder">Build a report</TryIt>
        </>
      ),
    },
    {
      id: 'reports-trust',
      keywords: ['methodology', 'accurate', 'fresh data', 'screenshot', 'accountant', 'trust'],
      heading: 'Why the PDF is worth more than a screenshot',
      body: (
        <>
          <p>
            The document is built from freshly fetched, complete data — not scraped off
            whatever the screen happened to be showing. So a report covering a month
            includes the whole month, not the first page of a table, and you get to see and
            adjust the pages before printing.
          </p>
          <Collapsible title="Include the methodology page">
            <p>
              Several templates offer a methodology note that states the basis of each
              figure — which clock, which population, what’s counted as revenue. An
              accountant reading your numbers for the first time will ask those questions
              anyway. Answering them on page one turns a document that invites doubt into
              one that settles it.
            </p>
          </Collapsible>
        </>
      ),
    },
  ],
};
