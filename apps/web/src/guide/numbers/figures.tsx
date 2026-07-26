/* Every money figure in GoServe, with the arithmetic behind it.
 *
 * This module is the bridge between the money vocabulary the API enforces
 * (apps/api/internal/api/money.go) and what an operator can read on screen. It
 * takes the tenant's OWN live figures and turns each one into a displayable
 * derivation: the terms, the operators, the result, and the source columns.
 *
 * Two rules make it trustworthy rather than decorative:
 *
 *   1. Terms come from live API fields, never from re-deriving a number the
 *      backend already computed. `net_revenue` is shown as billed − VAT using
 *      the API's billed and VAT, and compared against the API's own net revenue.
 *      If the backend basis ever changes, the check below fails loudly instead
 *      of the page quietly agreeing with itself.
 *   2. buildFormula() re-adds every term and flags a mismatch. A figure whose
 *      explanation has drifted from the figure is a visible defect, not a
 *      plausible-looking table.
 *
 * Definitions are kept here (pure, data-in/data-out) so they can be tested
 * without rendering a page — see figures.test.ts.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  CafeBalance,
  CafeSummary,
  ProfitReport,
  ReportsDashboard,
  ShiftSummaryReport,
} from '@cafe-mgmt/api-types';

import { formatNPRExact } from '@/components/Money';
import type { FormulaTerm } from '@/lib/formula';
import { EXPLAINERS } from '@/guide/explainers';

/** One derived figure: what it's called, where it appears, and how it's built. */
export type Figure = {
  /** Metric-registry id. Doubles as the deep-link anchor (`metric-<id>`). */
  id: string;
  title: string;
  /** The screens this exact figure appears on. */
  seenOn: string[];
  /** The arithmetic. Omitted for figures that are a direct column read. */
  terms?: FormulaTerm[];
  /** The figure as the API reports it — the number the terms must reproduce. */
  cents?: number;
  /** Label for the result row when the card's title doesn't read as one
   *  ("Why the two bottom lines differ" is a heading, not a line item). */
  resultLabel?: string;
  /** Non-money rows (counts, percentages, timestamps) shown as a plain table. */
  rows?: { label: string; value: string; note?: string }[];
  /** Why the figure is defined this way, and what it must not be used for. */
  why: ReactNode;
  /** The columns, tables and window it comes from. */
  source: ReactNode;
};

export type FigureSection = {
  id: string;
  title: string;
  /** One line on what this group of figures answers. */
  blurb: string;
  figures: Figure[];
};

/** Live inputs. Each is optional: a member may lack the permission or the plan
 *  feature behind it, and the page renders whatever it can rather than nothing. */
export type FigureInput = {
  dash?: ReportsDashboard;
  balance?: CafeBalance;
  summary?: CafeSummary;
  prof?: ProfitReport;
  shift?: ShiftSummaryReport;
};

/** Collected (money actually taken) for the window — the payment-mix channels.
 *  Kept as a helper because two figures need it and it must agree in both. */
export function collectedCents(d: ReportsDashboard): number {
  return d.payment_mix.cash_cents + d.payment_mix.bank_cents + d.payment_mix.online_cents;
}

export function buildFigureSections(input: FigureInput): FigureSection[] {
  const { dash, balance, summary, prof, shift } = input;
  const sections: FigureSection[] = [];

  // -------------------------------------------------------------------------
  // What the guest was charged.
  // -------------------------------------------------------------------------
  if (dash) {
    const k = dash.kpis;
    const collected = collectedCents(dash);
    const figures: Figure[] = [
      {
        id: 'sales',
        title: 'Billed sales',
        seenOn: ['Dashboard', 'History', 'Reports'],
        // Deliberately NOT shown as subtotal − discount + service + VAT. That
        // identity only holds in exclusive-VAT mode: with inclusive VAT the tax
        // is extracted from the base and is already inside the subtotal, so the
        // same "formula" would double-count it. The Dashboard KPIs don't expose
        // subtotal_cents, so the parts are listed as "of which" — true in every
        // mode — and the verified arithmetic is left to the bridges below.
        rows: [
          { label: 'Billed sales (the receipt total)', value: fmtInline(k.sales_cents) },
          { label: '…of which VAT', value: fmtInline(k.tax_cents), note: 'collected for the government' },
          { label: '…of which service charge', value: fmtInline(k.service_cents), note: 'the cafe’s income' },
          { label: 'Discounts, already deducted', value: fmtInline(k.discount_cents), note: 'guests were never charged this' },
          { label: 'Serves closed', value: String(k.order_count) },
        ],
        why: (
          <>
            <p>
              This is the receipt total, added up across every serve that{' '}
              <strong>closed</strong> in the window. It is what you charged — not what
              you collected, and not what you earned.
            </p>
            <p>
              Serves put on <strong>credit</strong> are counted here in full, on the day
              they were served. The cash arrives later and is reported separately as{' '}
              <em>credit collected</em>, never as sales a second time.
            </p>
            <p>
              A serve belongs to the window in which it <strong>closed</strong>, not when
              the table opened. A table opened before midnight and settled after it counts
              on the second day, in full.
            </p>
          </>
        ),
        source: (
          <>
            <code>Σ orders.total_cents</code> where <code>status = 'closed'</code> and{' '}
            <code>closed_at</code> falls in the window. VAT is always inside{' '}
            <code>total_cents</code>, in every VAT mode — which is why it is shown as
            “of which” above rather than added on.
          </>
        ),
      },
      {
        id: 'net-revenue',
        title: 'Net revenue',
        seenOn: ['Profitability', 'Owners'],
        cents: (prof?.totals.net_revenue_cents ?? k.sales_cents - k.tax_cents),
        terms: [
          { label: 'Billed sales', cents: k.sales_cents },
          { label: 'VAT collected', cents: k.tax_cents, op: '−', note: 'owed to the government' },
        ],
        why: (
          <>
            <p>
              <strong>Net revenue is what the cafe actually earned.</strong> VAT is
              subtracted because you are only holding it for the government — it was
              never your money. Discounts are already gone (they came off before the
              total) and the service charge is still in, because that is income.
            </p>
            <p>
              This is the basis every profit figure is built on. It is deliberately{' '}
              <em>not</em> the same as “menu price × quantity”: that ignores discounts
              entirely, and in inclusive-VAT mode it counts the government’s VAT as
              yours. Both would flatter your margin.
            </p>
          </>
        ),
        source: (
          <>
            <code>Σ (orders.total_cents − orders.tax_cents)</code> over the same closed
            orders. When VAT is off, this equals billed sales exactly.
          </>
        ),
      },
      {
        id: 'payment-split',
        title: 'Collected vs on credit',
        seenOn: ['Dashboard', 'History'],
        cents: k.sales_cents,
        terms: [
          { label: 'Cash (to the drawer)', cents: dash.payment_mix.cash_cents },
          { label: 'Online (eSewa, Khalti, card…)', cents: dash.payment_mix.online_cents, op: '+' },
          { label: 'Bank', cents: dash.payment_mix.bank_cents, op: '+' },
          { label: 'On credit', cents: k.tab_cents, op: '+', note: 'billed, not yet in hand' },
        ],
        why: (
          <>
            <p>
              Every serve is paid by some combination of these, so the four always add
              back up to billed sales. If they ever don’t, the figure above will say so.
            </p>
            <p>
              <strong>Collected</strong> — cash + online + bank ={' '}
              {fmtInline(collected)} — is the part that is actually in hand. The credit
              slice is a receivable: real sales, no money yet.
            </p>
          </>
        ),
        source: (
          <>
            <code>Σ payments.amount_cents</code> grouped by <code>method</code>, for the
            same closed orders. <code>method = 'house_tab'</code> is the credit slice;
            every other method rolls into one of the three collected channels.
          </>
        ),
      },
      {
        id: 'credit-collected',
        title: 'Credit collected',
        seenOn: ['Dashboard', 'History', 'Credit'],
        rows: [
          { label: 'Credit collected in the window', value: fmtInline(k.credit_collected_cents ?? 0) },
          { label: 'Counted as sales', value: 'Never', note: 'the sale was recorded on the day it was served' },
          { label: 'Counted in the balance', value: 'Yes', note: 'the cash lands in a drawer, bank or online account' },
        ],
        why: (
          <>
            <p>
              When someone pays down a credit account, that money is{' '}
              <strong>not new sales</strong>. The sale was already counted on the day
              the food went out. Counting it again on the day the cash arrives would
              inflate your revenue by every credit serve, twice.
            </p>
            <p>
              So it gets its own figure. It increases your cash and reduces what you are
              owed; it never touches sales or profit.
            </p>
          </>
        ),
        source: (
          <>
            <code>Σ house_tab_settlements.amount_cents</code> by{' '}
            <code>recorded_at</code>, excluding reversed rows — a different table and a
            different timestamp from sales, on purpose.
          </>
        ),
      },
      {
        id: 'avg-ticket',
        title: 'Average ticket',
        seenOn: ['Dashboard'],
        rows: [
          { label: 'Billed sales', value: fmtInline(k.sales_cents) },
          { label: 'Serves closed', value: String(k.order_count) },
          { label: 'Average ticket', value: fmtInline(k.avg_ticket_cents), note: 'billed sales ÷ serves' },
        ],
        why: (
          <>
            <p>
              The typical bill size for the window. It divides billed sales by the
              number of serves that closed — so a handful of big tables, or one very
              quiet day, moves it visibly. Read it next to the serve count, never alone.
            </p>
          </>
        ),
        source: (
          <>
            Billed sales ÷ <code>COUNT(*)</code> over the same closed orders. Shown to
            the paisa, so it can sit a paisa away from dividing the two figures above by
            hand.
          </>
        ),
      },
    ];
    sections.push({
      id: 'sales',
      title: 'Sales & revenue',
      blurb: 'What you charged, what you collected, and what you actually earned.',
      figures,
    });
  }

  // -------------------------------------------------------------------------
  // Profit — and the honest gap between the two bottom lines.
  // -------------------------------------------------------------------------
  if (dash || prof) {
    const figures: Figure[] = [];

    if (dash) {
      const k = dash.kpis;
      figures.push({
        id: 'net',
        title: 'Net (Dashboard)',
        seenOn: ['Dashboard'],
        cents: k.net_cents,
        terms: [
          { label: 'Billed sales', cents: k.sales_cents, note: 'VAT included' },
          { label: 'Expenses paid in the window', cents: k.expenses_cents, op: '−' },
        ],
        why: (
          <>
            <p>
              A <strong>till-level</strong> view: everything you billed, minus everything
              you paid out. It is the fastest read on whether a day carried itself.
            </p>
            <p>
              Because it starts from billed sales, the VAT you owe the government is
              still inside it, and bank transfer fees are not deducted. For the earned
              bottom line, use <strong>net profit</strong> below — and see “why the two
              differ”.
            </p>
          </>
        ),
        source: (
          <>
            Billed sales − <code>Σ expenses.amount_cents</code> where{' '}
            <code>deleted_at IS NULL</code>, bucketed by <code>paid_at</code>. An expense
            lands in the window it was <em>paid</em>, not when the stock is used.
          </>
        ),
      });
    }

    if (prof) {
      figures.push({
        id: 'profit-net',
        title: 'Net profit (Profitability)',
        seenOn: ['Profitability', 'Owners'],
        cents: prof.net_profit_cents,
        terms: [
          { label: 'Net revenue', cents: prof.totals.net_revenue_cents, note: 'VAT excluded' },
          { label: 'Expenses paid in the window', cents: prof.total_expenses_cents, op: '−' },
          { label: 'Bank & wallet transfer fees', cents: prof.transfer_fees_cents ?? 0, op: '−', note: 'money out that never reaches the expenses table' },
        ],
        why: (
          <>
            <p>
              The <strong>earned</strong> bottom line. It starts from net revenue, so the
              government’s VAT is out, and it subtracts transfer fees, which are real
              money leaving your accounts but live in{' '}
              <code>account_transfers</code> rather than in expenses.
            </p>
            <p>
              It does <em>not</em> subtract the per-item cost you set on menu items. That
              stock was already an expense when you bought it — subtracting it again
              would count the same rupee twice. Per-item cost drives the category margin
              view instead, which is a different lens on the same period.
            </p>
          </>
        ),
        source: (
          <>
            Net revenue − expenses (<code>paid_at</code> in window,{' '}
            <code>deleted_at IS NULL</code>) − <code>Σ account_transfers.fee_cents</code>.
          </>
        ),
      });
    }

    // The bridge. Two bottom lines exist, they differ, and the difference is
    // exactly explainable — so explain it here rather than leaving an operator
    // to discover it as a discrepancy.
    //
    // Guarded on the two reports covering the SAME window. The range picker only
    // offers ranges both endpoints understand, but this block's whole claim is
    // "the gap is exactly VAT + transfer fees" — which is false the moment the
    // periods differ. Cheaper to check than to be subtly wrong.
    if (dash && prof && sameWindow(dash, prof)) {
      const gap = dash.kpis.net_cents - prof.net_profit_cents;
      figures.push({
        id: 'profit-bridge',
        title: 'Why the two bottom lines differ',
        seenOn: ['This page'],
        cents: gap,
        resultLabel: 'Difference',
        terms: [
          { label: 'Net (Dashboard)', cents: dash.kpis.net_cents },
          { label: 'Net profit (Profitability)', cents: prof.net_profit_cents, op: '−' },
        ],
        why: (
          <>
            <p>
              Both answer “did we make money?”, from different starting points — so for
              this window they differ by {fmtInline(gap)}. That gap is not an error, and
              it is not a rounding artefact. It is exactly:
            </p>
            <ul>
              <li>
                <strong>VAT collected</strong> ({fmtInline(prof.vat_cents ?? dash.kpis.tax_cents)}) — inside the
                Dashboard’s figure, excluded from net profit, and owed to the government
                either way.
              </li>
              <li>
                <strong>Transfer fees</strong> ({fmtInline(prof.transfer_fees_cents ?? 0)}) — subtracted by net
                profit, not by the Dashboard.
              </li>
            </ul>
            <p>
              If your cafe has VAT switched off and pays no transfer fees, the two are
              identical. Use <strong>net profit</strong> when you want to know what you
              earned, and <strong>Net</strong> when you want to know what moved through
              the till.
            </p>
          </>
        ),
        source: (
          <>
            Both figures are read from the API as-is; the difference above is computed on
            this page from the two of them, and broken down beside it.
          </>
        ),
      });
    }

    if (prof) {
      figures.push({
        id: 'profit-gross',
        title: 'Category gross margin',
        seenOn: ['Profitability'],
        cents: prof.totals.gross_profit_cents,
        terms: [
          { label: 'Net revenue', cents: prof.totals.net_revenue_cents },
          { label: 'Cost of goods sold', cents: prof.totals.cogs_cents, op: '−', note: 'per-item cost × qty, plus allocated stock' },
        ],
        why: (
          <>
            <p>
              A <strong>per-category</strong> lens: of the revenue this category brought
              in, how much survived the cost of what went into it. It answers “which
              parts of the menu carry us”, not “did we make money this month”.
            </p>
            <p>
              Each order’s discount, service charge and VAT is spread across its
              categories in proportion to line value, using largest-remainder rounding.
              That is what makes the category rows add up to the period’s net revenue{' '}
              <em>exactly</em> — no stray paisa in the total row.
            </p>
            <p>
              Rent, salary and other overhead are not in here. They aren’t attributable
              to a category, so they only appear in net profit.
            </p>
          </>
        ),
        source: (
          <>
            Per category: allocated net revenue −{' '}
            <code>Σ (qty × menu_items.unit_cost_cents)</code> −{' '}
            <code>Σ expense_allocations.amount_cents</code>. Margin % is gross profit ÷
            net revenue.
          </>
        ),
      });
      figures.push({
        id: 'item-sales',
        title: 'Menu item sales',
        seenOn: ['Top sellers', 'Movers', 'Category mix'],
        rows: [
          { label: 'Menu item sales', value: fmtInline(prof.totals.item_sales_cents), note: 'menu price × qty' },
          { label: 'Net revenue', value: fmtInline(prof.totals.net_revenue_cents), note: 'what you earned' },
          {
            label: 'Difference',
            value: fmtInline(prof.totals.item_sales_cents - prof.totals.net_revenue_cents),
            note: 'discounts, service charge and VAT treated differently',
          },
        ],
        why: (
          <>
            <p>
              Ranking figures — top sellers, movers, category mix — use{' '}
              <strong>menu price × quantity</strong>. It is the right basis for “what
              sells”, because it isn’t disturbed by which table happened to get a
              discount.
            </p>
            <p>
              It is the <strong>wrong</strong> basis for money. It ignores discounts
              completely, and with inclusive VAT it counts the government’s share as
              yours. That is why it is always labelled “menu item sales” and never
              “revenue”, and why it never feeds a total or a profit figure.
            </p>
          </>
        ),
        source: (
          <>
            <code>Σ (order_items.qty × order_items.unit_price_cents)</code> over
            non-voided lines of closed orders. Half portions make{' '}
            <code>qty</code> fractional, so this basis cannot be reconciled across
            groupings to the paisa — another reason it is for ranking only.
          </>
        ),
      });
    }

    if (figures.length) {
      sections.push({
        id: 'profit',
        title: 'Profit',
        blurb: 'Two bottom lines, why they differ, and which one to trust for what.',
        figures,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Where the money physically is.
  // -------------------------------------------------------------------------
  if (balance) {
    const channelTotal = balance.channels.reduce((s, c) => s + c.balance_cents, 0);
    sections.push({
      id: 'balance',
      title: 'Cafe balance',
      blurb: 'The four buckets your money sits in, right now.',
      figures: [
        {
          id: 'cafe-balance',
          title: 'Cafe balance',
          seenOn: ['Dashboard', 'Accounts', 'Owners'],
          cents: balance.total_cents,
          terms: [
            {
              label: `Drawer (${drawerSourceLabel(balance.drawer_source)})`,
              cents: balance.drawer_cents,
            },
            { label: 'Bank', cents: balance.bank_cents, op: '+' },
            { label: 'Online channels', cents: channelTotal, op: '+', note: 'eSewa, Khalti, card…' },
            { label: 'Cash with owners', cents: balance.owner_cash_cents, op: '+', note: 'taken from the till, not yet reconciled' },
          ],
          why: (
            <>
              <p>
                A <strong>live snapshot</strong> — it ignores whatever date range the
                page is showing, because money doesn’t belong to a reporting window. It
                is what you hold as of this moment.
              </p>
              <p>
                Moving money between these buckets never changes the total. An owner
                taking cash from the till moves it from Drawer to “Cash with owners”; a
                bank deposit moves it from Drawer to Bank. Only <em>earning</em> and{' '}
                <em>spending</em> move the total. You can watch that play out in the{' '}
                <Link to="/admin/learn/money-flow">money-flow sandbox</Link>.
              </p>
              <p>
                Opening investments are excluded, so the balance you started the books
                with isn’t counted a second time.
              </p>
            </>
          ),
          source: (
            <>
              Drawer: the open shift’s live till, or the last closing count when no shift
              is open. Bank and channels: payments in, minus expenses paid from them,
              transfers out and owner payouts. Owner cash:{' '}
              <code>owner_cash_entries</code>, netted.
            </>
          ),
        },
        ...(balance.owner_outstanding.loans_cents
          ? [
              {
                id: 'outstanding-loans',
                title: 'Owner loans outstanding',
                seenOn: ['Owners', 'Accounts'],
                rows: [
                  { label: 'Still owed to owners', value: fmtInline(balance.owner_outstanding.loans_cents) },
                  { label: 'Part of the cafe balance', value: 'No', note: 'a liability, not an asset you hold' },
                ],
                why: (
                  <>
                    <p>
                      Money an owner lent the cafe and has not been repaid. The cash they
                      lent is already sitting in one of the buckets above — this figure
                      is what you still owe them for it, so it is reported beside the
                      balance rather than inside it.
                    </p>
                  </>
                ),
                source: (
                  <>
                    <code>owner_ledger</code> loan rows minus their repayments, net of
                    corrections.
                  </>
                ),
              } satisfies Figure,
            ]
          : []),
      ],
    });
  }

  // -------------------------------------------------------------------------
  // The shift close — the one place a human counts money by hand.
  // -------------------------------------------------------------------------
  if (shift) {
    const figures: Figure[] = [
      {
        id: 'expected-cash',
        title: 'Expected cash',
        seenOn: ['Shift', 'Accounts'],
        cents: shift.expected_cash_cents,
        terms: [
          { label: 'Opening float', cents: shift.opening_float_cents },
          { label: 'Cash taken from serves', cents: shift.cash_in_cents, op: '+' },
          { label: 'Credit paid down in cash', cents: shift.credit_settled_cash_cents, op: '+', note: 'older sales, but the cash is in this drawer' },
          { label: 'Cash added to the drawer', cents: shift.drops_in_cents, op: '+' },
          { label: 'Cash taken out (drops, cash expenses)', cents: shift.drops_out_cents, op: '−' },
        ],
        why: (
          <>
            <p>
              What should be in the drawer if nothing went wrong. Note the third line:
              when a customer pays down a credit account in cash, that cash is
              physically in <em>this</em> drawer even though the sale belongs to an
              earlier day — so it must be expected here, or every shift that collects
              credit would look short.
            </p>
            <p>
              Online and bank payments are absent on purpose. They never touched the
              drawer.
            </p>
          </>
        ),
        source: (
          <>
            Stamped onto the shift row at close from{' '}
            <code>payments</code> (<code>method = 'cash'</code>),{' '}
            <code>house_tab_settlements</code> paid in cash, and{' '}
            <code>cash_drops</code> — all scoped to this shift.
          </>
        ),
      },
      {
        id: 'variance',
        title: 'Variance',
        seenOn: ['Shift', 'Accounts'],
        cents: shift.variance_cents,
        terms: [
          { label: 'Counted at close', cents: shift.closing_count_cents },
          { label: 'Expected cash', cents: shift.expected_cash_cents, op: '−' },
        ],
        why: (
          <>
            <p>
              The honest difference between the note-by-note count and what the system
              expected. <strong>Negative is short, positive is over.</strong>
            </p>
            <p>
              Small variances are ordinary — change given wrong, a tip left in the till.
              A variance that repeats in the same direction is worth investigating, and
              a large one usually means a payment was recorded under the wrong method
              rather than that money is missing.
            </p>
            <p>
              Once a shift closes, both numbers are frozen. Nothing recorded afterwards
              rewrites a signed-off reconciliation.
            </p>
          </>
        ),
        source: (
          <>
            <code>shifts.closing_count_cents − shifts.expected_cash_cents</code>, both
            stamped at close.
          </>
        ),
      },
    ];
    sections.push({
      id: 'shift',
      title: 'Shift reconciliation',
      blurb: `From the ${shift.is_open ? 'open' : 'most recently closed'} shift — the one place a person counts money by hand.`,
      figures,
    });
  }

  // -------------------------------------------------------------------------
  // Lifetime — the figures owners actually ask about.
  // -------------------------------------------------------------------------
  if (summary) {
    sections.push({
      id: 'lifetime',
      title: 'Lifetime & owners',
      blurb: 'The same rules, applied over the cafe’s whole history.',
      figures: [
        {
          id: 'lifetime-profit',
          title: 'Lifetime net profit',
          seenOn: ['Owners'],
          cents: summary.cafe_net_profit_cents,
          terms: [
            { label: 'Lifetime net revenue', cents: summary.lifetime_revenue_cents, note: 'VAT excluded' },
            { label: 'Lifetime expenses', cents: summary.lifetime_expenses_cents, op: '−' },
            { label: 'Lifetime transfer fees', cents: summary.lifetime_transfer_fees_cents ?? 0, op: '−' },
          ],
          why: (
            <>
              <p>
                Net profit with no date filter — the same definition as the Profitability
                page, so the Owners page and the Reports page cannot disagree.
              </p>
              <p>
                Direct per-item cost ({fmtInline(summary.lifetime_direct_cogs_cents)}) is
                tracked but deliberately <strong>not</strong> subtracted here: that stock
                is already inside lifetime expenses. It is shown for information only.
              </p>
            </>
          ),
          source: (
            <>
              Net revenue over every closed order, minus every non-deleted expense and
              every transfer fee ever paid.
            </>
          ),
        },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Everything else in the metric registry.
  //
  // The blocks above give the money figures a full live derivation. The rest of
  // EXPLAINERS — analytics lenses (peak hours, movers, velocity) and figures
  // that are a single column read (opening float, voids) — have no arithmetic to
  // re-add, but every one of them is the target of a "Learn more →" link. They
  // are appended from the registry rather than restated, so:
  //   - a new explainer shows up here automatically, and
  //   - no deep link can ever land on an anchor this page doesn't render.
  // figures.test.ts asserts exactly that.
  // -------------------------------------------------------------------------
  const covered = new Set(sections.flatMap((s) => s.figures.map((f) => f.id)));
  const rest = EXPLAINERS.filter((e) => !covered.has(e.id));
  if (rest.length) {
    sections.push({
      id: 'reference',
      title: 'Every other figure',
      blurb:
        'Analytics lenses and single-value readings — defined here, with what each one may and may not be used for.',
      figures: rest.map((e) => ({
        id: e.id,
        title: e.label,
        seenOn: [],
        why: e.how,
        source: e.short,
      })),
    });
  }

  return sections;
}

/** Do two reports cover the same period? Compared as instants, so equivalent
 *  timestamps in different offsets still match. */
function sameWindow(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return (
    new Date(a.from).getTime() === new Date(b.from).getTime() &&
    new Date(a.to).getTime() === new Date(b.to).getTime()
  );
}

function drawerSourceLabel(src: CafeBalance['drawer_source']): string {
  if (src === 'live') return 'live, shift open';
  if (src === 'last_close') return 'last closing count';
  return 'no shift yet';
}

/** Rupees for use inside prose and plain rows — the same aligned formatting the
 *  arithmetic blocks use, so a figure quoted in a sentence matches the column. */
const fmtInline = formatNPRExact;
