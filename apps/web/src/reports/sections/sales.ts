// Sales sections.
//
// Every label here is taken from the money vocabulary in
// apps/api/internal/api/money.go. That file exists because the same word used to
// mean different numbers on adjacent screens, and a PDF that an accountant reads
// six months later is exactly where a loose label does the most damage:
//
//   Billed sales     Σ total_cents — what the guest was charged, VAT included.
//   VAT collected    a liability, never the cafe's income.
//   Net revenue      Σ (total − tax) — the profit basis.
//   Menu item sales  Σ qty × unit_price — ranking and mix ONLY, never a total.
//   On credit        billed but not collected.
//   Credit collected money in against EARLIER sales. Never sales again.

import { request } from '@/lib/api';
import type {
  CategoryMixRow,
  HeatmapResp,
  HourlyResp,
  MoversResp,
  ReportsDashboard,
  TableMixRow,
  TopSellersResp,
  VelocityResp,
} from '@cafe-mgmt/api-types';

import { count, money, pct, qty, shortDate, signedPct } from '../format';
import { rangeQs, rangeToQuery } from '../range';
import {
  boundRows,
  defineSection,
  heading,
  note,
  pageAll,
  totalRow,
  type LoadCtx,
} from '../section';
import type { ReportBlock } from '../types';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function get<T>(ctx: LoadCtx, path: string): Promise<T> {
  return request<T>('GET', path, { tenantSlug: ctx.slug });
}

// ---------------------------------------------------------------------------
// Sales summary — the KPI block
// ---------------------------------------------------------------------------

export const salesSummary = defineSection<ReportsDashboard>({
  id: 'sales.summary',
  group: 'Sales',
  label: 'Sales summary',
  description: 'Headline figures: billed sales, VAT, discounts, credit, net.',
  perm: 'report:read',
  needsRange: true,
  defaultDetail: 'summary',
  detailLevels: ['summary'],
  explainerIds: ['sales', 'net', 'avg-ticket', 'credit-collected'],
  load: (ctx) => get<ReportsDashboard>(ctx, `/v1/reports/dashboard?${rangeQs(ctx.range)}`),
  rowCount: () => 1,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => {
    const k = d.kpis;
    const creditCollected = k.credit_collected_cents ?? 0;
    const blocks: ReportBlock[] = [
      heading('Sales summary', 'All figures over the reporting period'),
      {
        kind: 'kpis',
        cells: [
          {
            label: 'Billed sales',
            value: money(k.sales_cents),
            note: 'What guests were charged, VAT included',
          },
          { label: 'Serves', value: count(k.order_count) },
          { label: 'Average ticket', value: money(k.avg_ticket_cents) },
          {
            label: 'Net revenue',
            value: money(k.sales_cents - k.tax_cents),
            note: 'Billed sales − VAT. The profit basis.',
          },
        ],
      },
      {
        kind: 'rows',
        rows: [
          { label: 'Billed sales', value: money(k.sales_cents) },
          { label: 'less VAT collected (liability, not income)', value: money(k.tax_cents) },
          {
            label: 'Net revenue',
            value: money(k.sales_cents - k.tax_cents),
            total: true,
          },
        ],
      },
      {
        kind: 'rows',
        rows: [
          { label: 'Service charge included above', value: money(k.service_cents) },
          { label: 'Discounts given', value: money(k.discount_cents) },
          {
            label: 'On credit (billed, not yet collected)',
            value: money(k.tab_cents),
            tone: k.tab_cents > 0 ? 'warn' : undefined,
          },
          { label: 'Expenses paid in period', value: money(k.expenses_cents) },
          { label: 'Voided lines', value: count(k.void_count) },
        ],
      },
    ];

    if (creditCollected > 0) {
      blocks.push({
        kind: 'rows',
        rows: [
          {
            label: 'Credit collected in this period',
            value: money(creditCollected),
            total: true,
          },
        ],
      });
      blocks.push(
        note(
          'Credit collected is money taken in against serves billed on an earlier ' +
            'date. It is shown separately because it is not new sales and is not part ' +
            'of billed sales or net revenue above.',
        ),
      );
    }

    return blocks;
  },
});

// ---------------------------------------------------------------------------
// Daily sales
// ---------------------------------------------------------------------------

export const salesDaily = defineSection<ReportsDashboard>({
  id: 'sales.daily',
  group: 'Sales',
  label: 'Sales by day',
  description: 'Billed sales per calendar day, with a bar for shape.',
  perm: 'report:read',
  needsRange: true,
  explainerIds: ['daily-sales'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<ReportsDashboard>(ctx, `/v1/reports/dashboard?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.daily.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => {
    const max = d.daily.reduce((m, p) => Math.max(m, p.sales_cents), 0) || 1;
    const total = d.daily.reduce((n, p) => n + p.sales_cents, 0);
    const blocks: ReportBlock[] = [heading('Sales by day')];

    // The dashboard pads short presets back to ~14 days so its chart has bars,
    // which makes the series legitimately wider than the KPI window. Saying so
    // is the difference between a footnote and an apparent contradiction.
    if (d.daily_padded && d.daily_from && d.daily_to) {
      blocks.push(
        note(
          `This series covers ${shortDate(d.daily_from)} to ${shortDate(d.daily_to)}, a wider ` +
            `span than the reporting period, so its total will exceed the billed sales figure above.`,
        ),
      );
    }

    blocks.push({
      kind: 'table',
      repeatHeader: true,
      columns: [
        { key: 'day', label: 'Day', width: 2 },
        { key: 'bar', label: '', width: 3 },
        { key: 'sales', label: 'Billed sales', numeric: true, width: 2 },
      ],
      rows: [
        ...d.daily.map((p) => ({
          cells: [shortDate(p.day), barCell(p.sales_cents, max), money(p.sales_cents)],
        })),
        totalRow(['Total', '', money(total)]),
      ],
    });
    return blocks;
  },
});

/** A crude text bar. Real <div> bars can't live inside a table cell string. */
function barCell(value: number, max: number): string {
  const width = Math.round((Math.max(0, value) / max) * 24);
  return '█'.repeat(width) || '·';
}

// ---------------------------------------------------------------------------
// Payment mix
// ---------------------------------------------------------------------------

export const salesPaymentMix = defineSection<ReportsDashboard>({
  id: 'sales.payment_mix',
  group: 'Sales',
  label: 'How guests paid',
  description: 'Cash / bank / online split, plus what went on credit and to whom.',
  perm: 'report:read',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['full'],
  explainerIds: ['payment-split', 'credit-collected'],
  load: (ctx) => get<ReportsDashboard>(ctx, `/v1/reports/dashboard?${rangeQs(ctx.range)}`),
  rowCount: (d) => 3 + d.tab_breakdown.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => {
    const m = d.payment_mix;
    const collected = m.cash_cents + m.bank_cents + m.online_cents;
    const share = (v: number) => (collected > 0 ? pct((v / collected) * 100) : '—');

    const blocks: ReportBlock[] = [
      heading('How guests paid', 'The collected portion of billed sales'),
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'method', label: 'Method', width: 3 },
          { key: 'amount', label: 'Amount', numeric: true, width: 2 },
          { key: 'share', label: 'Share', numeric: true, width: 1 },
        ],
        rows: [
          { cells: ['Cash', money(m.cash_cents), share(m.cash_cents)] },
          { cells: ['Bank transfer', money(m.bank_cents), share(m.bank_cents)] },
          { cells: ['Online / wallet', money(m.online_cents), share(m.online_cents)] },
          totalRow(['Collected', money(collected), '100.0%']),
        ],
      },
    ];

    if (d.tab_breakdown.length > 0) {
      const tabTotal = d.tab_breakdown.reduce((n, r) => n + r.amount_cents, 0);
      blocks.push(heading('Charged to credit accounts', undefined, 2));
      blocks.push({
        kind: 'table',
        repeatHeader: true,
        caption:
          'Billed in this period but not collected — these balances were added to a ' +
          "customer's credit account.",
        columns: [
          { key: 'name', label: 'Credit account', width: 3 },
          { key: 'amount', label: 'Charged', numeric: true, width: 2 },
        ],
        rows: [
          ...d.tab_breakdown.map((r) => ({ cells: [r.name, money(r.amount_cents)] })),
          totalRow(['Total on credit', money(tabTotal)]),
        ],
      });
    }

    return blocks;
  },
});

// ---------------------------------------------------------------------------
// Top sellers (with previous-period delta)
// ---------------------------------------------------------------------------

export const salesTopSellers = defineSection<TopSellersResp>({
  id: 'sales.top_sellers',
  group: 'Sales',
  label: 'Best and worst sellers',
  description: 'Top and bottom items by menu item sales, against the previous period.',
  perm: 'report:read',
  feature: 'advanced_analytics',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['full'],
  explainerIds: ['top-sellers', 'top-movers'],
  load: (ctx) => get<TopSellersResp>(ctx, `/v1/reports/top-sellers?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.top.length + d.bottom.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to }),
  render: (d, opts) => {
    const table = (rows: TopSellersResp['top'], label: string): ReportBlock[] => [
      heading(label, undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'name', label: 'Item', width: 3 },
          { key: 'cat', label: 'Category', width: 2 },
          { key: 'qty', label: 'Qty', numeric: true, width: 1 },
          { key: 'rev', label: 'Menu item sales', numeric: true, width: 2 },
          ...(opts.compare
            ? [{ key: 'delta', label: 'vs prev', numeric: true, width: 1 } as const]
            : []),
        ],
        rows: rows.map((r) => ({
          cells: [
            r.name,
            r.category_name ?? '—',
            qty(r.qty),
            money(r.revenue_cents),
            ...(opts.compare ? [signedPct(r.delta_pct)] : []),
          ],
        })),
      },
    ];

    return [
      heading('Best and worst sellers'),
      note(
        'Ranked on menu item sales (menu price × quantity). That basis ignores ' +
          'discounts and, under inclusive VAT, still contains VAT — it is the right ' +
          'measure for what sells, but it is not revenue and will not match billed sales.',
      ),
      ...table(d.top, 'Best sellers'),
      ...table(d.bottom, 'Slowest movers'),
      ...(opts.compare
        ? [note(`Previous period compared: ${shortDate(d.prev_from)} to ${shortDate(d.prev_to)}.`)]
        : []),
    ];
  },
});

// ---------------------------------------------------------------------------
// Item movers — the full list, paged to completion
// ---------------------------------------------------------------------------

type MoversData = { resp: MoversResp; rows: MoversResp['rows']; total: number; truncated: boolean };

export const salesMovers = defineSection<MoversData>({
  id: 'sales.movers',
  group: 'Sales',
  label: 'Every item sold',
  description: 'The complete item list, ranked by menu item sales. Can be long.',
  perm: 'report:read',
  feature: 'advanced_analytics',
  needsRange: true,
  prefersLandscape: true,
  defaultDetail: 'topN',
  detailLevels: ['topN', 'full'],
  explainerIds: ['top-movers', 'item-sales'],
  load: async (ctx) => {
    const qs = rangeQs(ctx.range);
    let first: MoversResp | undefined;
    // The movers endpoint caps a page at 1000 and offsets from there, so the
    // only way to get everything is to walk it.
    const paged = await pageAll<MoversResp['rows'][number]>(
      async (offset, limit) => {
        const r = await get<MoversResp>(
          ctx,
          `/v1/reports/movers?${qs}&limit=${limit}&offset=${offset}&sort=revenue&order=desc`,
        );
        first ??= r;
        return { rows: r.rows, total: r.total };
      },
      { pageSize: 500, hardCap: 5000 },
    );
    return {
      resp: first as MoversResp,
      rows: paged.rows,
      total: paged.total,
      truncated: paged.truncated,
    };
  },
  rowCount: (d) => d.total,
  resolvedWindow: (d) => ({ from: d.resp?.from, to: d.resp?.to }),
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.rows, opts, {
      total: d.total,
      truncated: d.truncated,
      orderedBy: 'menu item sales',
      emptyText: 'No items were sold in this period.',
    });
    const shownTotal = rows.reduce((n, r) => n + r.revenue_cents, 0);
    const allTotal = d.rows.reduce((n, r) => n + r.revenue_cents, 0);

    return [
      heading('Every item sold', 'Ranked by menu item sales'),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'name', label: 'Item', width: 3 },
          { key: 'cat', label: 'Category', width: 2 },
          { key: 'qty', label: 'Qty', numeric: true, width: 1 },
          { key: 'rev', label: 'Menu item sales', numeric: true, width: 2 },
          ...(opts.compare
            ? [{ key: 'delta', label: 'vs prev', numeric: true, width: 1 } as const]
            : []),
        ],
        rows: [
          ...rows.map((r) => ({
            cells: [
              r.name,
              r.category_name ?? '—',
              qty(r.qty),
              money(r.revenue_cents),
              ...(opts.compare ? [signedPct(r.delta_pct)] : []),
            ],
          })),
          // When the table is bounded, a "total" of the visible rows only would
          // be misread as the period's total. Label both.
          ...(rows.length < d.rows.length
            ? [
                totalRow([
                  `Total of the ${rows.length.toLocaleString('en-IN')} rows shown`,
                  '',
                  '',
                  money(shownTotal),
                  ...(opts.compare ? [''] : []),
                ]),
                totalRow([
                  `Total across all ${d.rows.length.toLocaleString('en-IN')} items`,
                  '',
                  '',
                  money(allTotal),
                  ...(opts.compare ? [''] : []),
                ]),
              ]
            : [totalRow(['Total', '', '', money(allTotal), ...(opts.compare ? [''] : [])])]),
        ],
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Category mix
// ---------------------------------------------------------------------------

type CategoryMixData = { rows: CategoryMixRow[]; from: string; to: string };

export const salesCategoryMix = defineSection<CategoryMixData>({
  id: 'sales.category_mix',
  group: 'Sales',
  label: 'Category mix',
  description: 'Share of menu item sales by menu category.',
  perm: 'report:read',
  feature: 'advanced_analytics',
  needsRange: true,
  explainerIds: ['category-mix'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<CategoryMixData>(ctx, `/v1/reports/category-mix?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.rows.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to }),
  render: (d) => {
    const max = d.rows.reduce((m, r) => Math.max(m, r.revenue_cents), 0) || 1;
    const total = d.rows.reduce((n, r) => n + r.revenue_cents, 0);
    return [
      heading('Category mix', 'Share of menu item sales'),
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'name', label: 'Category', width: 3 },
          { key: 'bar', label: '', width: 3 },
          { key: 'qty', label: 'Qty', numeric: true, width: 1 },
          { key: 'rev', label: 'Menu item sales', numeric: true, width: 2 },
          { key: 'share', label: 'Share', numeric: true, width: 1 },
        ],
        rows: [
          ...d.rows.map((r) => ({
            cells: [
              r.name,
              barCell(r.revenue_cents, max),
              qty(r.qty),
              money(r.revenue_cents),
              pct(r.share_pct),
            ],
          })),
          totalRow(['Total', '', '', money(total), '100.0%']),
        ],
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Table mix
// ---------------------------------------------------------------------------

type TableMixData = { rows: TableMixRow[] };

export const salesTableMix = defineSection<TableMixData>({
  id: 'sales.table_mix',
  group: 'Sales',
  label: 'Table performance',
  description: 'Serves, sales and average ticket per table.',
  perm: 'report:read',
  feature: 'advanced_analytics',
  needsRange: true,
  explainerIds: ['table-mix'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<TableMixData>(ctx, `/v1/reports/table-mix?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.rows.length,
  render: (d) => {
    const totalRev = d.rows.reduce((n, r) => n + r.revenue_cents, 0);
    const totalOrders = d.rows.reduce((n, r) => n + r.order_count, 0);
    return [
      heading('Table performance'),
      {
        kind: 'table',
        repeatHeader: true,
        caption:
          'Take-away, walk-in and retired tables appear as their own rows — their ' +
          'sales are real, so omitting them would stop the column summing to the period.',
        columns: [
          { key: 'name', label: 'Table', width: 3 },
          { key: 'seats', label: 'Seats', numeric: true, width: 1 },
          { key: 'orders', label: 'Serves', numeric: true, width: 1 },
          { key: 'rev', label: 'Billed sales', numeric: true, width: 2 },
          { key: 'avg', label: 'Avg ticket', numeric: true, width: 2 },
        ],
        rows: [
          ...d.rows.map((r) => ({
            cells: [
              r.name,
              r.capacity > 0 ? count(r.capacity) : '—',
              count(r.order_count),
              money(r.revenue_cents),
              money(r.avg_ticket_cents),
            ],
          })),
          totalRow(['Total', '', count(totalOrders), money(totalRev), '']),
        ],
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

export const salesVelocity = defineSection<VelocityResp>({
  id: 'sales.velocity',
  group: 'Sales',
  label: 'Throughput by day',
  description: 'Serves, average ticket and items per serve, day by day.',
  perm: 'report:read',
  feature: 'advanced_analytics',
  needsRange: true,
  explainerIds: ['velocity'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<VelocityResp>(ctx, `/v1/reports/velocity?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.series.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => [
    heading('Throughput by day'),
    {
      kind: 'kpis',
      cells: [
        { label: 'Serves', value: count(d.total_orders) },
        { label: 'Billed sales', value: money(d.total_revenue_cents) },
        { label: 'Average ticket', value: money(d.avg_ticket_cents) },
        {
          label: 'Items per serve',
          value: (d.avg_items_per_order_x10 / 10).toFixed(1),
        },
      ],
    },
    {
      kind: 'table',
      repeatHeader: true,
      columns: [
        { key: 'day', label: 'Day', width: 2 },
        { key: 'orders', label: 'Serves', numeric: true, width: 1 },
        { key: 'rev', label: 'Billed sales', numeric: true, width: 2 },
        { key: 'avg', label: 'Avg ticket', numeric: true, width: 2 },
        { key: 'items', label: 'Items', numeric: true, width: 1 },
        { key: 'ipo', label: 'Items/serve', numeric: true, width: 1 },
      ],
      rows: d.series.map((p) => ({
        cells: [
          shortDate(p.day),
          count(p.order_count),
          money(p.revenue_cents),
          money(p.avg_ticket_cents),
          qty(p.items_total),
          (p.items_per_order_x10 / 10).toFixed(1),
        ],
      })),
    },
  ],
});

// ---------------------------------------------------------------------------
// Hourly profile (single day)
// ---------------------------------------------------------------------------

export const salesHourly = defineSection<HourlyResp>({
  id: 'sales.hourly',
  group: 'Sales',
  label: 'Hourly profile',
  description: 'Serves and sales by hour of day. Covers one day only.',
  perm: 'report:read',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => {
    // This endpoint is inherently single-day. Use the range's start so the day
    // shown is at least inside the reporting period, and say which day it is.
    const q = rangeToQuery(ctx.range);
    const qs = q.from ? `?date=${encodeURIComponent(q.from)}` : '';
    return get<HourlyResp>(ctx, `/v1/reports/hourly${qs}`);
  },
  rowCount: (d) => d.hours.length,
  render: (d) => {
    const max = d.hours.reduce((m, h) => Math.max(m, h.revenue_cents), 0) || 1;
    const byHour = new Map(d.hours.map((h) => [h.hour, h]));
    return [
      heading('Hourly profile', shortDate(d.date)),
      note(
        `This section covers a single day (${shortDate(d.date)}), not the whole reporting period.`,
      ),
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'hour', label: 'Hour', width: 1 },
          { key: 'bar', label: '', width: 3 },
          { key: 'orders', label: 'Serves', numeric: true, width: 1 },
          { key: 'rev', label: 'Billed sales', numeric: true, width: 2 },
        ],
        rows: HOURS.map((h) => {
          const row = byHour.get(h);
          const rev = row?.revenue_cents ?? 0;
          return {
            cells: [
              `${String(h).padStart(2, '0')}:00`,
              barCell(rev, max),
              count(row?.order_count ?? 0),
              money(rev, { zeroDash: true }),
            ],
            muted: (row?.order_count ?? 0) === 0,
          };
        }),
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Heatmap — day-of-week × hour
// ---------------------------------------------------------------------------

export const salesHeatmap = defineSection<HeatmapResp>({
  id: 'sales.heatmap',
  group: 'Sales',
  label: 'Busy times',
  description: 'Serves by day of week and hour. Wide — prints best in landscape.',
  perm: 'report:read',
  feature: 'advanced_analytics',
  needsRange: true,
  prefersLandscape: true,
  explainerIds: ['peak-hours'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<HeatmapResp>(ctx, `/v1/reports/heatmap?${rangeQs(ctx.range)}`),
  rowCount: (d) => d.cells.length,
  resolvedWindow: (d) => ({ from: d.from, to: d.to, timezone: d.timezone }),
  render: (d) => {
    // Only print hours the cafe actually trades in — a full 24 columns is mostly
    // zeros and forces the table narrower than it needs to be.
    const active = HOURS.filter((h) => d.cells.some((c) => c.hour === h && c.order_count > 0));
    const hours = active.length > 0 ? active : HOURS.slice(8, 22);
    const byKey = new Map(d.cells.map((c) => [`${c.dow}-${c.hour}`, c]));

    return [
      heading('Busy times', 'Serves by day of week and hour'),
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'dow', label: 'Day', width: 1.4 },
          ...hours.map((h) => ({
            key: `h${h}`,
            label: String(h).padStart(2, '0'),
            numeric: true,
            width: 1,
          })),
          { key: 'tot', label: 'Total', numeric: true, width: 1.2 },
        ],
        rows: DOW.map((name, dow) => {
          const cells = hours.map((h) => byKey.get(`${dow}-${h}`)?.order_count ?? 0);
          const rowTotal = DOW.length
            ? d.cells.filter((c) => c.dow === dow).reduce((n, c) => n + c.order_count, 0)
            : 0;
          return {
            cells: [name, ...cells.map((n) => (n === 0 ? '·' : count(n))), count(rowTotal)],
          };
        }),
      },
    ];
  },
});

export const SALES_SECTIONS = [
  salesSummary,
  salesDaily,
  salesPaymentMix,
  salesTopSellers,
  salesMovers,
  salesCategoryMix,
  salesTableMix,
  salesVelocity,
  salesHourly,
  salesHeatmap,
];
