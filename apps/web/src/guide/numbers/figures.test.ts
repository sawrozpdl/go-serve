import { describe, expect, it } from 'vitest';
import type {
  CafeBalance,
  CafeSummary,
  ProfitReport,
  ReportsDashboard,
  ShiftSummaryReport,
} from '@cafe-mgmt/api-types';

import { buildFormula } from '@/lib/formula';
import { EXPLAINERS } from '@/guide/explainers';
import { buildFigureSections, collectedCents, type FigureInput } from './figures';

/* The fixture below is a real API response set, captured from a seeded tenant
 * with 2,106 closed orders, VAT on and a service charge. Using live-shaped
 * numbers rather than round invented ones matters here: several of these
 * figures only disagree once VAT and discounts are non-zero, which is precisely
 * the case a hand-written 100/200/300 fixture would pass while being wrong.
 *
 * The contract these tests defend: every figure this page displays as an
 * arithmetic derivation must actually reproduce the number the API reports. If
 * a backend basis changes and the page's explanation of it doesn't, this fails
 * instead of the page confidently showing an incorrect derivation. */

const dash: ReportsDashboard = {
  range: 'all',
  from: '2019-12-31T18:15:00Z',
  to: '2026-07-26T18:15:00Z',
  timezone: 'Asia/Kathmandu',
  kpis: {
    sales_cents: 147641038,
    tab_cents: 16197991,
    credit_collected_cents: 14776411,
    tax_cents: 16985298,
    service_cents: 11986500,
    order_count: 2106,
    avg_ticket_cents: 70104,
    expenses_cents: 27184000,
    net_cents: 120457038,
    void_count: 12,
    discount_cents: 1195760,
  },
  daily: [],
  daily_from: '2019-12-31T18:15:00Z',
  daily_to: '2026-07-26T18:15:00Z',
  daily_padded: false,
  top_sellers: [],
  slow_movers: [],
  payment_mix: { cash_cents: 86685466, bank_cents: 0, online_cents: 44757581 },
  tab_breakdown: [],
} as unknown as ReportsDashboard;

const prof: ProfitReport = {
  range: 'all',
  from: '2019-12-31T18:15:00Z',
  to: '2026-07-26T18:15:00Z',
  timezone: 'Asia/Kathmandu',
  categories: [],
  totals: {
    name: 'All categories',
    net_revenue_cents: 130655740,
    item_sales_cents: 119865000,
    cogs_cents: 40797900,
    direct_cogs_cents: 40797900,
    allocated_cogs_cents: 0,
    gross_profit_cents: 89857840,
    margin_pct: 68.77,
  },
  billed_sales_cents: 147641038,
  vat_cents: 16985298,
  unallocated_cogs_cents: 27184000,
  total_expenses_cents: 27184000,
  transfer_fees_cents: 475,
  net_profit_cents: 103471265,
} as unknown as ProfitReport;

const balance: CafeBalance = {
  drawer_cents: 524160,
  drawer_source: 'live',
  drawer_as_of: '2026-07-25T08:00:00+05:45',
  bank_cents: -6680000,
  channels: [{ method: 'online', label: 'Online', balance_cents: 44757581 }],
  owner_cash_cents: 850000,
  total_cents: 39451741,
  owner_outstanding: { loans_cents: 246000 },
} as unknown as CafeBalance;

const summary: CafeSummary = {
  lifetime_invested_cents: 15000000,
  lifetime_payouts_cents: 1500000,
  outstanding_loans_cents: 246000,
  lifetime_revenue_cents: 130655740,
  lifetime_direct_cogs_cents: 40797900,
  lifetime_expenses_cents: 27184000,
  lifetime_transfer_fees_cents: 475,
  cafe_net_profit_cents: 103471265,
  cafe_balance_cents: 39451741,
};

const shift: ShiftSummaryReport = {
  shift_id: '08f59275-cace-4efd-aca0-a1c0b0f5c25e',
  timezone: 'Asia/Kathmandu',
  is_open: false,
  opening_float_cents: 550000,
  cash_in_cents: 922306,
  credit_settled_cash_cents: 0,
  credit_settled_other_cents: 0,
  drops_in_cents: 0,
  drops_out_cents: 0,
  expected_cash_cents: 1472306,
  closing_count_cents: 1472306,
  variance_cents: 0,
  order_count: 20,
  billed_sales_cents: 1854556,
} as unknown as ShiftSummaryReport;

const full: FigureInput = { dash, prof, balance, summary, shift };

/** Re-add every displayed formula and compare with the figure it claims to
 *  explain — the same check the UI performs, asserted here. */
function mismatches(input: FigureInput) {
  return buildFigureSections(input)
    .flatMap((s) => s.figures)
    .filter((fig) => fig.terms && fig.cents !== undefined)
    .map((fig) => ({ id: fig.id, f: buildFormula(fig.title, fig.cents!, fig.terms!) }))
    .filter((x) => x.f.mismatch)
    .map((x) => `${x.id}: terms=${x.f.computedCents} reported=${x.f.resultCents}`);
}

describe('buildFigureSections', () => {
  it('every displayed derivation reproduces the API figure', () => {
    expect(mismatches(full)).toEqual([]);
  });

  it('covers the figures an operator actually asks about', () => {
    const ids = buildFigureSections(full).flatMap((s) => s.figures.map((f) => f.id));
    for (const id of [
      'sales',
      'net-revenue',
      'payment-split',
      'credit-collected',
      'net',
      'profit-net',
      'profit-bridge',
      'profit-gross',
      'cafe-balance',
      'expected-cash',
      'variance',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('renders a block for every metric an InfoHint can deep-link to', () => {
    // Each InfoHint's "Learn more →" points at /admin/learn/numbers#metric-<id>.
    // A registry entry with no block here means that link scrolls nowhere and the
    // operator lands on a wall of text with no answer — so the page must cover
    // the whole registry, not just the figures with arithmetic.
    const ids = new Set(buildFigureSections(full).flatMap((s) => s.figures.map((f) => f.id)));
    const missing = EXPLAINERS.filter((e) => !ids.has(e.id)).map((e) => e.id);
    expect(missing).toEqual([]);
  });

  it('does not show the same metric twice', () => {
    // A dedicated block plus its registry fallback would render duplicate DOM ids,
    // and the deep link would land on whichever came first.
    const ids = buildFigureSections(full).flatMap((s) => s.figures.map((f) => f.id));
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('still covers the registry when no live data is available at all', () => {
    // A member with no reporting permissions gets no derivations, but their
    // tooltips still deep-link here and must still find an explanation.
    const ids = new Set(buildFigureSections({}).flatMap((s) => s.figures.map((f) => f.id)));
    expect(EXPLAINERS.filter((e) => !ids.has(e.id)).map((e) => e.id)).toEqual([]);
  });

  it('renders whatever data it has, and derives nothing it cannot', () => {
    // A member without report:read gets no dashboard, so no sales/profit
    // derivations — but the balance section and the registry reference still
    // render. Nothing is invented from absent data.
    const partial = buildFigureSections({ balance });
    expect(partial.map((s) => s.id)).toEqual(['balance', 'reference']);
    expect(mismatches({ balance })).toEqual([]);

    // With no data at all, only the reference remains, and it derives nothing.
    const none = buildFigureSections({});
    expect(none.map((s) => s.id)).toEqual(['reference']);
    expect(none.flatMap((s) => s.figures).every((f) => !f.terms)).toBe(true);
  });

  it('omits the two-bottom-lines bridge unless both figures are present', () => {
    const ids = (input: FigureInput) =>
      buildFigureSections(input).flatMap((s) => s.figures.map((f) => f.id));
    expect(ids({ dash })).not.toContain('profit-bridge');
    expect(ids({ prof })).not.toContain('profit-bridge');
    expect(ids({ dash, prof })).toContain('profit-bridge');
  });

  it('drops the bridge when the two reports cover different windows', () => {
    // The block claims the gap is exactly VAT + transfer fees. Across mismatched
    // periods that claim is false, so the block must not render at all.
    const otherWindow = { ...prof, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
    const ids = buildFigureSections({ dash, prof: otherWindow }).flatMap((s) =>
      s.figures.map((f) => f.id),
    );
    expect(ids).not.toContain('profit-bridge');
    // The individual figures still appear — only the comparison is withheld.
    expect(ids).toContain('net');
    expect(ids).toContain('profit-net');
  });

  it('matches windows across equivalent timestamps in different offsets', () => {
    // 2019-12-31T18:15:00Z is 2020-01-01T00:00+05:45 — the same instant. A naive
    // string compare would drop the bridge for every Kathmandu tenant.
    const offsetForm = { ...prof, from: '2020-01-01T00:00:00+05:45' };
    const ids = buildFigureSections({ dash, prof: offsetForm }).flatMap((s) =>
      s.figures.map((f) => f.id),
    );
    expect(ids).toContain('profit-bridge');
  });

  it('collected + on credit equals billed sales', () => {
    // The invariant the payment-split block asserts on screen. It is the API's
    // to keep; this pins the arithmetic the page uses to display it.
    expect(collectedCents(dash) + dash.kpis.tab_cents).toBe(dash.kpis.sales_cents);
  });

  it('the bridge accounts for the whole gap between the two bottom lines', () => {
    const gap = dash.kpis.net_cents - prof.net_profit_cents;
    // VAT sits inside the Dashboard's figure; transfer fees are subtracted only
    // by net profit. Nothing else may contribute, or the page's explanation of
    // the difference would be incomplete.
    expect(gap).toBe((prof.vat_cents ?? 0) + (prof.transfer_fees_cents ?? 0));
  });

  it('net revenue is billed sales minus VAT, on the API\'s own numbers', () => {
    expect(prof.totals.net_revenue_cents).toBe(dash.kpis.sales_cents - dash.kpis.tax_cents);
  });

  it('the cafe balance is the four buckets and nothing else', () => {
    const channels = balance.channels.reduce((s, c) => s + c.balance_cents, 0);
    expect(
      balance.drawer_cents + balance.bank_cents + channels + balance.owner_cash_cents,
    ).toBe(balance.total_cents);
  });

  it('handles a negative bank balance without breaking the balance formula', () => {
    // Overdrawn bank accounts are real (expenses paid out before deposits land).
    // The bucket formula must still sum, so the figure can't be built from
    // absolute values or clamped at zero anywhere.
    expect(balance.bank_cents).toBeLessThan(0);
    expect(mismatches({ balance })).toEqual([]);
  });

  it('shift expected cash includes cash credit settlements', () => {
    // A cash credit settlement is physically in this drawer even though its sale
    // belongs to an earlier day. Omitting it made every collecting shift read
    // short — the bug fixed in "count cash credit settlements in expected cash".
    // Collecting Rs 500 of credit in cash raises expected cash by Rs 500; with
    // the same closing count the drawer is then Rs 500 short.
    const withCredit = {
      ...shift,
      credit_settled_cash_cents: 50000,
      expected_cash_cents: 1522306,
      variance_cents: -50000,
    };
    expect(mismatches({ shift: withCredit })).toEqual([]);

    // And the term is genuinely load-bearing: drop it from expected cash and
    // both derivations that depend on it break.
    expect(mismatches({ shift: { ...withCredit, expected_cash_cents: 1472306 } })).toContain(
      'expected-cash: terms=1522306 reported=1472306',
    );
  });

  it('flags a drifted derivation rather than displaying it as correct', () => {
    // The failure mode this page is built to catch: the API reports one number
    // and the explanation of it adds to another.
    const drifted = { ...dash, kpis: { ...dash.kpis, net_cents: 999 } };
    expect(mismatches({ dash: drifted })).toContain(
      'net: terms=120457038 reported=999',
    );
  });
});
