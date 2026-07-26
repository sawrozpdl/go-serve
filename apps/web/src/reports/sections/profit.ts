// Profit sections.
//
// Labels follow money.go: category rows are NET REVENUE (billed − VAT, net of
// discounts, service charge included), which is the profit basis. `item_sales`
// is menu price × qty and appears only as a secondary column, never as revenue.

import { request } from '@/lib/api';
import type { ProfitDrilldown, ProfitReport, ProfitRow } from '@cafe-mgmt/api-types';

import { count, money, pct, qty, shortDate } from '../format';
import { rangeQs } from '../range';
import { defineSection, heading, note, totalRow, type LoadCtx } from '../section';
import type { ReportBlock, TableRow } from '../types';

function get<T>(ctx: LoadCtx, path: string): Promise<T> {
  return request<T>('GET', path, { tenantSlug: ctx.slug });
}

/** Categories showing revenue with no cost allocated — almost always a config
 *  gap rather than a genuinely cost-free product. */
function phantomFullMargin(rows: ProfitRow[]): ProfitRow[] {
  return rows.filter((c) => c.net_revenue_cents > 0 && c.cogs_cents === 0);
}

// ---------------------------------------------------------------------------
// P&L summary — the bridge
// ---------------------------------------------------------------------------

export const profitSummary = defineSection<ProfitReport>({
  id: 'profit.summary',
  group: 'Profit',
  label: 'Profit & loss summary',
  description: 'Billed sales → net revenue → gross profit → net profit, shown as arithmetic.',
  perm: 'report:read',
  feature: 'profitability',
  needsRange: true,
  defaultDetail: 'summary',
  detailLevels: ['summary'],
  explainerIds: ['profit-net', 'net-revenue'],
  load: (ctx) => get<ProfitReport>(ctx, `/v1/reports/profitability?${rangeQs(ctx.range)}`),
  rowCount: () => 1,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => {
    const t = d.totals;
    const transferFees = d.transfer_fees_cents ?? 0;
    const blocks: ReportBlock[] = [
      heading('Profit & loss summary'),
      {
        kind: 'kpis',
        cells: [
          { label: 'Net revenue', value: money(t.net_revenue_cents) },
          { label: 'Cost of goods', value: money(t.cogs_cents), tone: 'warn' },
          {
            label: 'Gross profit',
            value: money(t.gross_profit_cents),
            note: t.margin_pct == null ? undefined : `${pct(t.margin_pct)} margin`,
            tone: t.gross_profit_cents >= 0 ? 'good' : 'bad',
          },
          {
            label: 'Net profit',
            value: money(d.net_profit_cents),
            note: 'after all expenses',
            tone: d.net_profit_cents >= 0 ? 'good' : 'bad',
          },
        ],
      },
    ];

    // Show the arithmetic. The whole reason net revenue exists as a distinct
    // figure is that it differs from billed sales, and a reader who only sees
    // the result cannot tell which basis was used.
    if (d.billed_sales_cents != null) {
      blocks.push(heading('From billed sales to net revenue', undefined, 2));
      blocks.push({
        kind: 'rows',
        rows: [
          { label: 'Billed sales (receipt totals)', value: money(d.billed_sales_cents) },
          { label: 'less VAT collected', value: money(d.vat_cents ?? 0) },
          { label: 'Net revenue', value: money(t.net_revenue_cents), total: true },
        ],
      });
    }

    blocks.push(heading('Gross profit', undefined, 2));
    blocks.push({
      kind: 'rows',
      rows: [
        { label: 'Net revenue', value: money(t.net_revenue_cents) },
        {
          label: 'less direct cost (per-item cost × qty)',
          value: money(t.direct_cogs_cents),
          tone: 'warn',
        },
        {
          label: 'less allocated cost (expenses tagged to a category)',
          value: money(t.allocated_cogs_cents),
          tone: 'warn',
        },
        { label: 'Gross profit', value: money(t.gross_profit_cents), total: true },
      ],
    });

    blocks.push(heading('Net profit', undefined, 2));
    blocks.push({
      kind: 'rows',
      rows: [
        { label: 'Net revenue', value: money(t.net_revenue_cents) },
        {
          label: 'less all expenses paid in period',
          value: money(d.total_expenses_cents),
          tone: 'warn',
        },
        ...(transferFees > 0
          ? [
              {
                label: 'less bank / wallet charges on transfers',
                value: money(transferFees),
                tone: 'warn' as const,
              },
            ]
          : []),
        { label: 'Net profit', value: money(d.net_profit_cents), total: true },
      ],
    });

    blocks.push(
      note(
        'Net profit is cash-basis: it counts every expense paid inside the period, ' +
          'including those tagged to a menu category (which also reduce gross profit ' +
          'above). Gross profit and net profit therefore answer different questions and ' +
          'are not meant to reconcile to each other.',
      ),
    );

    return blocks;
  },
});

// ---------------------------------------------------------------------------
// By category
// ---------------------------------------------------------------------------

export const profitByCategory = defineSection<ProfitReport>({
  id: 'profit.by_category',
  group: 'Profit',
  label: 'Margin by category',
  description: 'Net revenue, cost and margin for each menu category.',
  perm: 'report:read',
  feature: 'profitability',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['full'],
  explainerIds: ['profit-gross', 'net-revenue', 'item-sales'],
  load: (ctx) => get<ProfitReport>(ctx, `/v1/reports/profitability?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.categories.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => {
    const cats = d.categories;
    const t = d.totals;
    const phantom = phantomFullMargin(cats);
    const unallocated = d.unallocated_cogs_cents;

    const rows: TableRow[] = cats.map((c) => ({
      cells: [
        c.name,
        money(c.net_revenue_cents),
        money(c.item_sales_cents),
        money(c.cogs_cents, { zeroDash: true }),
        money(c.gross_profit_cents),
        // A category with revenue and no cost is 100% margin arithmetically but
        // meaningless as a figure — flag it in place instead of letting it read
        // as the best-performing line on the page.
        c.margin_pct == null
          ? '—'
          : c.net_revenue_cents > 0 && c.cogs_cents === 0
            ? '100% (no cost set)'
            : pct(c.margin_pct),
      ],
      muted: c.net_revenue_cents === 0 && c.cogs_cents === 0,
    }));

    const blocks: ReportBlock[] = [
      heading('Margin by category'),
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'name', label: 'Category', width: 2.6 },
          { key: 'net', label: 'Net revenue', numeric: true, width: 1.8 },
          { key: 'item', label: 'Menu item sales', numeric: true, width: 1.8 },
          { key: 'cogs', label: 'Cost', numeric: true, width: 1.6 },
          { key: 'gp', label: 'Gross profit', numeric: true, width: 1.8 },
          { key: 'margin', label: 'Margin', numeric: true, width: 1.6 },
        ],
        rows: [
          ...rows,
          totalRow([
            'Total',
            money(t.net_revenue_cents),
            money(t.item_sales_cents),
            money(t.cogs_cents),
            money(t.gross_profit_cents),
            t.margin_pct == null ? '—' : pct(t.margin_pct),
          ]),
        ],
      },
      note(
        'Net revenue is the profit basis: billed sales less VAT, net of discounts, ' +
          "with service charge included. Each serve's discount, service charge and VAT " +
          'are spread across its categories in proportion to line value, so these rows ' +
          "sum exactly to the period's net revenue. Menu item sales is shown alongside " +
          'for mix only — it ignores discounts and will not tie to net revenue.',
      ),
    ];

    if (phantom.length > 0) {
      blocks.push(
        note(
          `${phantom.length} categor${phantom.length === 1 ? 'y' : 'ies'} ` +
            `(${phantom.map((c) => c.name).join(', ')}) show full margin because no cost is ` +
            `recorded against them. Set a cost per unit on the menu items, or tag an expense ` +
            `to the category, before treating these margins as real.`,
          'warn',
        ),
      );
    }

    if (unallocated > 0) {
      blocks.push(
        note(
          `${money(unallocated)} of expenses in this period are not tagged to any menu ` +
            `category. They reduce net profit but not the per-category margins above.`,
          'warn',
        ),
      );
    }

    return blocks;
  },
});

// ---------------------------------------------------------------------------
// Per-category drill-down appendix
// ---------------------------------------------------------------------------

type DrilldownData = {
  report: ProfitReport;
  drilldowns: { category: ProfitRow; detail: ProfitDrilldown }[];
};

export const profitDrilldowns = defineSection<DrilldownData>({
  id: 'profit.drilldowns',
  group: 'Profit',
  label: 'Category cost breakdown (appendix)',
  description: 'For every category: the expenses allocated to it and the items sold.',
  perm: 'report:read',
  feature: 'profitability',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: async (ctx) => {
    const qs = rangeQs(ctx.range);
    const report = await get<ProfitReport>(ctx, `/v1/reports/profitability?${qs}`);
    // On screen this lives behind a click, one category at a time, so the old
    // export never contained any of it. Fan out over every category that has
    // anything to show and print the lot.
    const targets = report.categories.filter(
      (c) => c.menu_category_id && (c.net_revenue_cents !== 0 || c.cogs_cents !== 0),
    );
    const details = await Promise.all(
      targets.map(async (c) => ({
        category: c,
        detail: await get<ProfitDrilldown>(
          ctx,
          `/v1/reports/profitability/${c.menu_category_id}?${qs}`,
        ),
      })),
    );
    return { report, drilldowns: details };
  },
  rowCount: (d) =>
    d.drilldowns.reduce((n, x) => n + x.detail.expenses.length + x.detail.items.length, 0),
  resolvedWindow: (d) => ({ from: d.report.from, to: d.report.to, timezone: d.report.timezone }),
  render: (d) => {
    const blocks: ReportBlock[] = [
      heading('Category cost breakdown', 'Appendix — how each margin was arrived at'),
    ];

    if (d.drilldowns.length === 0) {
      blocks.push(note('No categories had any activity in this period.'));
      return blocks;
    }

    d.drilldowns.forEach((entry, i) => {
      const c = entry.category;
      const det = entry.detail;
      // Each category starts a fresh page: this is reference material read one
      // category at a time, not a continuous table.
      if (i > 0) blocks.push({ kind: 'pagebreak' });
      blocks.push(heading(c.name, 'Cost breakdown', 2));
      blocks.push({
        kind: 'rows',
        rows: [
          { label: 'Net revenue', value: money(c.net_revenue_cents) },
          { label: 'Menu item sales (price × qty)', value: money(c.item_sales_cents) },
          {
            label: 'Direct cost (per-item cost × qty)',
            value: money(c.direct_cogs_cents),
            tone: 'warn',
          },
          {
            label: 'Allocated cost (from expenses)',
            value: money(c.allocated_cogs_cents),
            tone: 'warn',
          },
          { label: 'Total cost', value: money(c.cogs_cents), tone: 'warn' },
          {
            label: 'Gross profit',
            value: money(c.gross_profit_cents),
            total: true,
            tone: c.gross_profit_cents >= 0 ? 'good' : 'bad',
          },
        ],
      });

      const expTotal = det.expenses.reduce((n, e) => n + e.allocated_cents, 0);
      blocks.push({
        kind: 'table',
        repeatHeader: true,
        caption:
          det.expenses.length === 0
            ? 'No expenses are tagged to this category in this period.'
            : `Expenses tagged to ${c.name}`,
        columns: [
          { key: 'date', label: 'Paid', width: 1.6 },
          { key: 'vendor', label: 'Vendor', width: 2.4 },
          { key: 'notes', label: 'Notes', width: 2.6 },
          { key: 'share', label: 'Share', numeric: true, width: 1 },
          { key: 'full', label: 'Expense total', numeric: true, width: 1.6 },
          { key: 'alloc', label: 'Allocated here', numeric: true, width: 1.8 },
        ],
        rows: [
          ...det.expenses.map((e) => ({
            cells: [
              shortDate(e.paid_at),
              e.vendor || '—',
              e.notes || '—',
              `${e.share_pct}%`,
              money(e.expense_amount_cents),
              money(e.allocated_cents),
            ],
          })),
          ...(det.expenses.length > 0
            ? [totalRow(['Allocated total', '', '', '', '', money(expTotal)])]
            : []),
        ],
      });

      const itemRev = det.items.reduce((n, it) => n + it.revenue_cents, 0);
      const itemCost = det.items.reduce((n, it) => n + it.cost_cents, 0);
      blocks.push({
        kind: 'table',
        repeatHeader: true,
        caption:
          det.items.length === 0
            ? 'No items in this category were sold in this period.'
            : `Items sold in ${c.name}`,
        columns: [
          { key: 'name', label: 'Item', width: 3.4 },
          { key: 'qty', label: 'Qty', numeric: true, width: 1 },
          { key: 'rev', label: 'Menu item sales', numeric: true, width: 1.8 },
          { key: 'cost', label: 'Direct cost', numeric: true, width: 1.6 },
          { key: 'margin', label: 'Item margin', numeric: true, width: 1.4 },
        ],
        rows: [
          ...det.items.map((it) => ({
            cells: [
              it.name,
              qty(it.qty),
              money(it.revenue_cents),
              money(it.cost_cents, { zeroDash: true }),
              it.cost_cents > 0 && it.revenue_cents > 0
                ? pct(((it.revenue_cents - it.cost_cents) / it.revenue_cents) * 100, 0)
                : '—',
            ],
          })),
          ...(det.items.length > 0
            ? [
                totalRow([
                  `${count(det.items.length)} items`,
                  '',
                  money(itemRev),
                  money(itemCost, { zeroDash: true }),
                  '',
                ]),
              ]
            : []),
        ],
      });
    });

    return blocks;
  },
});

export const PROFIT_SECTIONS = [profitSummary, profitByCategory, profitDrilldowns];
