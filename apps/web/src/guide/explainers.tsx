// Single source of truth for "how is this number calculated?" copy.
//
// Each entry powers BOTH the small InfoHint tooltip next to a widget (`short`)
// and the matching section in the GoServe Training guide (`how`). Keep them in
// sync here so a metric is never explained two different ways.
//
// Accuracy notes are grounded in the actual backend SQL:
//   - analytics.go / reports.go / profitability.go / history.go / finance.go
//   - Sales-side metrics bucket on orders.closed_at in the tenant timezone,
//     status='closed'; item-level ones also drop voided lines.
//   - Expense-side metrics bucket on expenses.paid_at, deleted_at IS NULL.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type Explainer = {
  id: string;
  /** Short heading, reused as the guide section title. */
  label: string;
  /** Anchor for deep links: /admin/guide#<anchor>. */
  anchor: string;
  /** Concise tooltip text — one or two plain sentences, leads with the basis. */
  short: ReactNode;
  /** Fuller explanation rendered in the "Your numbers explained" guide topic. */
  how: ReactNode;
};

function mk(id: string, label: string, short: ReactNode, how: ReactNode): Explainer {
  return { id, label, anchor: `metric-${id}`, short, how };
}

export const EXPLAINERS: Explainer[] = [
  mk(
    'sales',
    'Sales',
    <>Total of every <strong>closed serve</strong> in the selected period, counted when the serve is settled (its close time). Includes serves put on credit, even though that cash isn’t in hand yet.</>,
    <>
      <p>
        <strong>Sales</strong> sums the grand total of every serve that was{' '}
        <strong>closed (settled)</strong> within the selected period. A serve is
        placed in the period by its <em>close</em> time, in your cafe’s timezone —
        not when the table was first opened.
      </p>
      <p>
        It is a <em>gross</em> figure: discounts are already subtracted, and tax +
        service charge are already included, exactly as on the receipt. Serves paid
        onto <strong>credit</strong> are counted at full value here; the part
        that’s still owed is shown separately as “on credit (not in hand)”.
      </p>
    </>,
  ),
  mk(
    'orders',
    'Orders / serves',
    <>Count of serves <strong>closed</strong> in the selected period (by close time).</>,
    <>
      <p>
        The number of serves <strong>closed</strong> in the period. A “serve” is one
        settled order — one table’s bill, or one walk-in. Open (unsettled) serves
        don’t count until they’re closed.
      </p>
    </>,
  ),
  mk(
    'avg-ticket',
    'Average ticket',
    <>Sales ÷ number of serves in the period.</>,
    <>
      <p>
        <strong>Average ticket</strong> = Sales ÷ serves. It’s the typical bill size
        for the period. A few large tables (or a quiet day) move it noticeably, so
        read it alongside the serve count.
      </p>
    </>,
  ),
  mk(
    'net',
    'Net (sales − expenses)',
    <>Sales for the period minus <strong>all</strong> expenses recorded in it (by their paid date), including salary. This is the cash bottom line — the per-item cost on menu items is a separate lens used on the Profitability page.</>,
    <>
      <p>
        <strong>Net</strong> = Sales − every expense recorded in the period. Expenses
        land in the period by their <strong>paid date</strong>, so a bulk purchase
        dated the 3rd counts in that month even if you sell the stock later.
      </p>
      <p>
        This is a <em>cash</em> bottom line: money in minus money out. It does{' '}
        <em>not</em> subtract the per-unit cost you set on menu items — that figure
        drives the category gross-margin view on the Profitability page, and counting
        both would double-count the same stock.
      </p>
    </>,
  ),
  mk(
    'cafe-balance',
    'Cafe balance',
    <>All cafe money on hand <strong>right now</strong> — drawer + online channels + bank + cash held by owners. It’s live and does not change with the selected period.</>,
    <>
      <p>
        <strong>Cafe balance</strong> is a live snapshot of all money the cafe holds
        right now, regardless of the dashboard date range:
      </p>
      <ul>
        <li><strong>Drawer</strong> — the live till during an open shift (opening float + cash taken − cash dropped), or the last closing count when no shift is open.</li>
        <li><strong>Bank</strong> — bank payments + owner investments + owner cash deposited, minus bank-paid expenses, transfers out and owner payouts.</li>
        <li><strong>Online</strong> — eSewa, Khalti, card and other digital channels, rolled into one bucket.</li>
        <li><strong>Cash with owners</strong> — cafe cash an owner has taken but not yet reconciled.</li>
      </ul>
      <p>Opening investments are excluded so the starting bank balance isn’t counted twice.</p>
      <p>
        Moving cash between these buckets (an owner taking from the till, a bank
        deposit) never changes the total — only earning or spending does. See it
        play out in the <Link to="/admin/money-flow">money-flow simulator</Link>.
      </p>
    </>,
  ),
  mk(
    'daily-sales',
    'Daily sales & average',
    <>Each bar is one day’s closed-serve total (by close time). The dashed line is the average across the days shown.</>,
    <>
      <p>
        Each bar is the total of serves <strong>closed</strong> on that calendar day
        (your timezone). The dashed line and “avg/day” caption are the simple mean
        across the days currently shown — switch to the list view to read every day’s
        exact figure, or click a day to open its full history.
      </p>
      <p>
        Short ranges pad out to a 14-day trailing window so the chart always has
        bars; a month or custom range shows exactly the days you picked.
      </p>
    </>,
  ),
  mk(
    'top-sellers',
    'Top sellers',
    <>Best-selling menu items by <strong>revenue</strong> from closed serves in the period (voided lines excluded).</>,
    <>
      <p>
        Menu items ranked by revenue (qty × price) from <strong>closed</strong> serves
        in the period. Voided lines are excluded, so a comp’d item doesn’t inflate the
        list.
      </p>
    </>,
  ),
  mk(
    'top-movers',
    'Top movers (vs prior period)',
    <>Same as top sellers, but each item shows the % change in revenue versus the <strong>immediately preceding period of equal length</strong> (e.g. this 7 days vs the 7 before).</>,
    <>
      <p>
        Top/slow movers add a trend arrow: the % change in revenue against the period
        of the <strong>same length immediately before</strong> the one you’re viewing
        — last 7 days vs the 7 days before that, this month vs last month, and so on.
      </p>
    </>,
  ),
  mk(
    'peak-hours',
    'Peak hours (heatmap)',
    <>Counts serves by the <strong>hour they were closed</strong> (settled), in your cafe’s timezone — not when the table was seated. A table opened at 10am and paid at 1pm lands in the 1pm cell.</>,
    <>
      <p>
        The heatmap buckets serves into day-of-week × hour cells using the{' '}
        <strong>close (settle) time</strong> of each serve, in your cafe’s timezone.
      </p>
      <p>
        That’s the key thing to know: it reflects <em>when tables finish and pay</em>,
        not when they were seated. A long lunch that opens at 10am and settles at 1pm
        shows up under 1pm. It’s a demand-by-checkout view — great for staffing the
        till and kitchen wind-down, less so for seating rush.
      </p>
    </>,
  ),
  mk(
    'category-mix',
    'Category mix',
    <>Share of revenue by menu category from closed serves in the period (voided lines excluded).</>,
    <>
      <p>
        How revenue splits across menu categories for <strong>closed</strong> serves in
        the period. Share % is each category’s revenue ÷ total revenue. Voided lines are
        excluded; items with no category don’t appear.
      </p>
    </>,
  ),
  mk(
    'table-mix',
    'Table mix',
    <>Serves and revenue per table from closed serves in the period. Every table is listed (even unused ones) so you can spot dead capacity.</>,
    <>
      <p>
        Serve count and revenue per service table, from <strong>closed</strong> serves in
        the period. This works at the <em>order</em> level, so voided lines don’t reduce a
        table’s total. Every table is shown — including ones that never turned — so empty
        rows highlight under-used capacity.
      </p>
    </>,
  ),
  mk(
    'velocity',
    'Velocity (items / order)',
    <>Per-day serve count, revenue, average ticket and items-per-order from closed serves (voided lines excluded from item counts).</>,
    <>
      <p>
        A daily throughput view: serves, revenue, average ticket and <strong>items per
        order</strong> for each day in the range, from <strong>closed</strong> serves.
        Voided lines don’t count toward items-per-order. Empty days are shown as zero so
        the trend line is honest.
      </p>
    </>,
  ),
  mk(
    'profit-gross',
    'Gross margin (by category)',
    <>Per category: revenue − (<strong>per-unit cost</strong> set on menu items + expenses you’ve <strong>allocated</strong> to that category). Only attributed costs count, so it differs from Net profit.</>,
    <>
      <p>
        <strong>Gross margin</strong> is a per-category pricing lens:
      </p>
      <p>
        revenue − ( <strong>direct cost</strong> + <strong>allocated cost</strong> ).
      </p>
      <ul>
        <li><strong>Direct cost</strong> = the “cost per unit” on each menu item, captured at the moment of sale (later price changes don’t rewrite old serves).</li>
        <li><strong>Allocated cost</strong> = the slice of an expense you tagged to that category (an expense can be split across several).</li>
      </ul>
      <p>
        It deliberately counts only costs you’ve <em>attributed</em> to a category, so a
        category showing 100% margin usually just means no cost is set yet — not free
        money. For the true bottom line, see Net profit.
      </p>
    </>,
  ),
  mk(
    'profit-net',
    'Net profit (cash)',
    <>Sales − <strong>all</strong> expenses in the period (salary, rent, supplies — everything), by paid date. The real cash bottom line.</>,
    <>
      <p>
        <strong>Net profit</strong> = Sales − every expense recorded in the period (by
        paid date). Salary, rent and any untagged overhead all count here, which is why
        it’s the figure that answers “did we actually make money?”.
      </p>
      <p>
        It does not subtract the per-unit direct cost again — that stock is already in the
        expenses total when you bought it, so counting it twice would understate profit.
        Net profit and category gross margin are two different lenses and won’t match.
      </p>
    </>,
  ),
  mk(
    'payment-split',
    'Cash / online / credit split',
    <>Splits a day’s takings by how each serve was paid: cash (to the drawer), online (eSewa/Khalti/card/etc.), and credit (owed, not in hand).</>,
    <>
      <p>
        On the History page, takings are split by payment method: <strong>cash</strong>
        (lands in the drawer), <strong>online</strong> (eSewa, Khalti, card and other
        digital channels rolled together), and <strong>credit</strong> (charged to a
        credit account — recorded as sales but not yet collected).
      </p>
    </>,
  ),
  mk(
    'owner-cash',
    'Cash with owners',
    <>Cafe cash an owner has taken from the drawer but not yet reconciled. Still cafe money — cleared by depositing to the bank, spending it on the cafe, or returning it to the till.</>,
    <>
      <p>
        When an owner takes cash from the till it doesn’t vanish — it moves to{' '}
        <strong>Cash with owners</strong>, a holding bucket that’s still part of the cafe
        balance. Each holding is cleared by one of: depositing it to the bank, recording a
        cafe expense paid from it, or returning it to the drawer.
      </p>
    </>,
  ),
  mk(
    'voids',
    'Voided items',
    <>Count of line items voided in the period (by void time). Voids don’t change a closed serve’s total — they’re tracked for oversight and logged in Activity.</>,
    <>
      <p>
        The number of line items voided in the period, counted when the void happened.
        Voiding an item on an already-closed serve doesn’t change that serve’s total; voids
        are tracked here (and in the Activity log) purely for oversight.
      </p>
    </>,
  ),
  mk(
    'discounts',
    'Discounts applied',
    <>Total discount value on closed serves in the period. It’s already subtracted from Sales — shown here for visibility.</>,
    <>
      <p>
        The total value of discounts applied to <strong>closed</strong> serves in the
        period. This is already deducted from the Sales figure; it’s surfaced separately so
        you can see how much was given away.
      </p>
    </>,
  ),
];

export const explainerById: Record<string, Explainer> = Object.fromEntries(
  EXPLAINERS.map((e) => [e.id, e]),
);
