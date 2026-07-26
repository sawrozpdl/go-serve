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
  /** Anchor for deep links: /admin/learn/numbers#<anchor>. */
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
        play out in the <Link to="/admin/learn/money-flow">money-flow simulator</Link>.
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
    'credit-collected',
    'Credit collected',
    <>Money taken in to pay down a credit account. It belongs to serves closed on <strong>earlier</strong> days, so it is never added to Sales — but it does raise your drawer, online and bank balances.</>,
    <>
      <p>
        A credit serve is counted <strong>once</strong>, as sales, on the day it is
        closed — at that moment the money is owed to you rather than in hand. When the
        guest later clears their balance, that payment is{' '}
        <strong>credit collected</strong>: it moves the money from “owed” to “in hand”.
      </p>
      <p>
        It is <em>not</em> new sales, and it is never added to the Sales figure for the
        day it arrives — doing so would count the same serve twice. It <em>is</em> real
        money, so it raises the cash drawer, online or bank balance, and it forms part of
        a shift’s expected cash when paid in cash.
      </p>
      <p>
        This is why the drawer can legitimately hold more than the day’s cash sales: the
        difference is credit collected, shown as its own line on the Dashboard, History
        and Shift pages.
      </p>
    </>,
  ),
  // -----------------------------------------------------------------------
  // Shift / drawer. This whole domain had no explainer at all, while the
  // glossary defined "variance" in terms of an undefined "expected cash".
  // -----------------------------------------------------------------------
  mk(
    'expected-cash',
    'Expected cash',
    <>What the till should hold right now: <strong>opening float + cash in − cash out</strong>. Cash in includes cash sales AND credit collected in cash; online payments are never in it.</>,
    <>
      <p>
        <strong>Expected cash</strong> is what GoServe believes is physically in the
        drawer: the <em>opening float</em> you started with, plus everything cash that
        came in, minus everything cash that went out.
      </p>
      <p>
        Cash in is <strong>cash sales + credit collected in cash + drops in</strong>.
        Credit collected is money against serves from earlier days — it is real cash in
        the till, which is why the drawer can legitimately hold more than today’s sales.
      </p>
      <p>
        Online and bank payments are deliberately excluded: they never touched the
        drawer. They are shown separately at close so you can cross-check your QR app.
      </p>
    </>,
  ),
  mk(
    'variance',
    'Variance',
    <>Counted cash minus expected cash. Negative = short (less in the till than expected); positive = over.</>,
    <>
      <p>
        At close you count the till and enter the figure. <strong>Variance = counted −
        expected</strong>. Zero is a clean close.
      </p>
      <p>
        Small differences are normal (coin shortages, rounding). GoServe flags them in
        bands so you know when to look harder: up to Rs 50 is minor, up to Rs 500 is
        worth investigating, more than that needs a manager. Nothing blocks the close —
        the number is recorded either way, so the history stays honest.
      </p>
      <p>
        When the variance equals one payment exactly, the usual cause is that payment
        having the wrong method (cash recorded as online, or the reverse). GoServe spots
        that case and offers to fix it.
      </p>
    </>,
  ),
  mk(
    'opening-float',
    'Opening float',
    <>The cash you start a shift with. It is part of expected cash, not part of sales.</>,
    <>
      <p>
        The float is the change you keep in the till to trade with. It is money the cafe
        already had, so it never counts as sales — but it does count toward{' '}
        <strong>expected cash</strong>, because it should still be in the drawer at close.
      </p>
      <p>
        GoServe suggests the previous shift’s counted closing figure as the float, since
        that is what was left in the till. Change it if you banked cash overnight.
      </p>
    </>,
  ),
  mk(
    'cash-drops',
    'Cash in / out (drops)',
    <>Cash moving through the drawer for a reason other than a sale: banking it, paying a supplier from the till, an owner taking cash, or a recount correction.</>,
    <>
      <p>
        A <strong>drop</strong> is cash entering or leaving the till outside a sale. Each
        kind is recorded for a reason, and each one moves expected cash:
      </p>
      <p>
        <strong>Bank deposit</strong> — cash physically taken to the bank (it also lands
        in your Bank balance). <strong>Expense</strong> — the till paid a supplier.{' '}
        <strong>Transfer</strong> — cash moved into another account.{' '}
        <strong>Owner draw</strong> — an owner took cafe cash; it stays cafe money and
        shows under “With owners” until it is banked, spent or returned.{' '}
        <strong>Correction</strong> — a recount adjustment, which always needs a note.
      </p>
    </>,
  ),
  mk(
    'drawer-vs-ledger',
    'Drawer (this shift) vs the cash ledger',
    <>Two different questions: what should be in the till right now, versus every cash rupee the cafe has ever taken less everything cash has paid for.</>,
    <>
      <p>
        <strong>Drawer · this shift</strong> answers “what should I count?”. While a shift
        is open it is float + cash in − cash out; with no shift open it is the last
        counted closing figure.
      </p>
      <p>
        The <strong>Cash drawer</strong> card is a lifetime ledger: all cash sales and
        credit collected in cash, less cash expenses, transfers out and owner draws. It
        answers “how much cash has this cafe handled?”.
      </p>
      <p>
        They are not meant to match, and the difference is not an error.
      </p>
    </>,
  ),
  mk(
    'account-balance',
    'Account balance',
    <>What one account holds: sales collected into it, plus credit collected, less expenses paid from it, plus and minus transfers.</>,
    <>
      <p>
        Each account — cash drawer, Online, Bank — is a running ledger. Money in is sales
        settled into it plus credit collected into it; money out is expenses paid from it
        and transfers out (including any transfer fee).
      </p>
      <p>
        “Online” folds every digital channel together (eSewa, Khalti, card and anything
        else), because they behave identically for reconciliation.
      </p>
      <p>
        A credit CHARGE never appears here. It is a receivable — the cafe has earned it
        but does not hold it — so it only enters an account when the guest pays.
      </p>
    </>,
  ),
  mk(
    'transfer-fee',
    'Transfer fee',
    <>A bank or wallet charge for moving your own money. It leaves the source account and counts as a cost against profit.</>,
    <>
      <p>
        When you move money between accounts, any fee is charged to the account the money
        left. If cash is the source, the till gives up the amount <em>plus</em> the fee.
      </p>
      <p>
        The fee is real money gone, so it counts against net profit even though it isn’t
        an expense you recorded on the Expenses page.
      </p>
    </>,
  ),
  mk(
    'net-revenue',
    'Net revenue',
    <>What the cafe actually earned: <strong>billed sales − VAT</strong>. Net of discounts, service charge included, VAT excluded because it belongs to the government.</>,
    <>
      <p>
        <strong>Net revenue</strong> is the basis for profit. Start from what guests were
        charged (billed sales), then remove the VAT you collected on the government’s
        behalf. Discounts are already gone — money you never earned. The service charge
        stays, because that is the cafe’s income.
      </p>
      <p>
        It is deliberately different from <em>menu item sales</em> (price × quantity),
        which ignores discounts and, if your prices include VAT, still contains VAT. That
        figure is useful for seeing what sells, and misleading for anything else.
      </p>
    </>,
  ),
  mk(
    'item-sales',
    'Menu item sales',
    <>Menu price × quantity sold, before discounts — and with VAT still inside it when your prices include VAT. For comparing items, not for totals or profit.</>,
    <>
      <p>
        This is the simplest measure of what sells: each item’s price times how many went
        out. It is the right lens for rankings and category mix.
      </p>
      <p>
        It is the wrong lens for money, because it does not know about discounts and,
        under VAT-inclusive pricing, includes tax you have to hand over. Use{' '}
        <strong>net revenue</strong> when the question is about earnings.
      </p>
    </>,
  ),
  mk(
    'outstanding-loans',
    'Owner loans outstanding',
    <>Money an owner paid for cafe things out of their own pocket, that the cafe still owes them back.</>,
    <>
      <p>
        When an owner buys something for the cafe with their own money, the cafe owes them
        — recorded as a loan. It is not a cafe expense paid from a cafe account, so it
        never reduces the drawer or the bank; it is still a real cost, so it does count in
        expenses and against profit.
      </p>
      <p>
        Repaying the owner moves money out of the bank and reduces what is outstanding.
      </p>
    </>,
  ),
  mk(
    'credit-collected-day',
    'Credit collected (today)',
    <>Money taken in today against credit from earlier days. It raises your balances and is never added to today’s sales.</>,
    <>
      <p>
        A credit serve counts as sales on the day it is served. When the guest settles up
        later, that payment is <strong>credit collected</strong> — it moves money from
        “owed” to “in hand”.
      </p>
      <p>
        Adding it to sales again would count the same serve twice, so it is always its own
        line. This is why cash in the till can exceed the day’s sales.
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
