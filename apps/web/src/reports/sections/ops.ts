// Operations sections — the order log, voids and discounts, and shift closes.
//
// The order log is the one section where a silent cap would be most damaging:
// it is the transaction-level record everything else aggregates from. The
// endpoint has no row limit at all, and this section asks for the whole span in
// one request (see the from/to support added to GetOrderHistory).

import { request } from '@/lib/api';
import type {
  HistoryCreditCollection,
  HistoryOrder,
  OrderHistoryResp,
  Shift,
  ShiftSummaryReport,
} from '@cafe-mgmt/api-types';
import { resolveTableLabel } from '@cafe-mgmt/api-types';

import { count, dateTime, money, orDash, qty, shortDate, signedMoney, titleCase } from '../format';
import { resolveWindowDays } from '../window';
import { boundRows, defineSection, heading, note, totalRow, type LoadCtx } from '../section';
import type { ReportBlock, TableRow } from '../types';

function get<T>(ctx: LoadCtx, path: string): Promise<T> {
  return request<T>('GET', path, { tenantSlug: ctx.slug });
}

/** Order history takes explicit days, so a preset must be resolved to a span. */
async function loadHistory(ctx: LoadCtx): Promise<OrderHistoryResp> {
  const w = await resolveWindowDays(ctx);
  return get<OrderHistoryResp>(
    ctx,
    `/v1/orders/history?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`,
  );
}

// ---------------------------------------------------------------------------
// Order log
// ---------------------------------------------------------------------------

export const opsOrderLog = defineSection<OrderHistoryResp>({
  id: 'ops.order_log',
  group: 'Operations',
  label: 'Order log',
  description: 'Every closed serve in the period, with its totals and how it was paid.',
  perm: 'order:read',
  needsRange: true,
  prefersLandscape: true,
  defaultDetail: 'full',
  detailLevels: ['topN', 'full'],
  load: loadHistory,
  rowCount: (d) => d.orders.length,
  resolvedWindow: (d) => ({ from: d.from ?? d.date, to: d.to ?? d.date, timezone: d.timezone }),
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.orders, opts, {
      total: d.orders.length,
      orderedBy: 'settle time (most recent first)',
      emptyText: 'No serves were closed in this period.',
    });

    const sum = (pick: (o: HistoryOrder) => number, list: HistoryOrder[]) =>
      list.reduce((n, o) => n + pick(o), 0);
    const bounded = rows.length < d.orders.length;
    const totalsFor = (list: HistoryOrder[], label: string): TableRow =>
      totalRow([
        label,
        '',
        '',
        money(sum((o) => o.subtotal_cents, list)),
        money(sum((o) => o.discount_cents, list)),
        money(sum((o) => o.service_charge_cents, list)),
        money(sum((o) => o.tax_cents, list)),
        money(sum((o) => o.total_cents, list)),
        '',
      ]);

    const blocks: ReportBlock[] = [
      heading('Order log'),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'when', label: 'Settled', width: 2 },
          { key: 'table', label: 'Table', width: 1.8 },
          { key: 'items', label: 'Items', numeric: true, width: 1 },
          { key: 'sub', label: 'Subtotal', numeric: true, width: 1.6 },
          { key: 'disc', label: 'Discount', numeric: true, width: 1.4 },
          { key: 'svc', label: 'Service', numeric: true, width: 1.4 },
          { key: 'vat', label: 'VAT', numeric: true, width: 1.4 },
          { key: 'total', label: 'Billed total', numeric: true, width: 1.8 },
          { key: 'paid', label: 'Paid by', width: 2 },
        ],
        rows: [
          ...rows.map((o) => ({
            cells: [
              o.closed_at ? dateTime(o.closed_at) : '—',
              // The shared helper handles named walk-in tabs and retired tables,
              // so the log matches what the History screen shows.
              resolveTableLabel(o),
              qty(o.item_count),
              money(o.subtotal_cents),
              money(o.discount_cents, { zeroDash: true }),
              money(o.service_charge_cents, { zeroDash: true }),
              money(o.tax_cents, { zeroDash: true }),
              money(o.total_cents),
              o.payments.length === 0
                ? '—'
                : o.payments
                    .map((p) => `${titleCase(p.method)} ${money(p.amount_cents)}`)
                    .join(', '),
            ],
          })),
          ...(bounded
            ? [
                totalsFor(rows, `Total of the ${count(rows.length)} rows shown`),
                totalsFor(d.orders, `Total across all ${count(d.orders.length)} serves`),
              ]
            : [totalsFor(d.orders, 'Total')]),
        ],
      },
    ];

    const collections: HistoryCreditCollection[] = d.credit_collections ?? [];
    if (collections.length > 0) {
      const total = collections.reduce((n, c) => n + c.amount_cents, 0);
      blocks.push(heading('Credit collected in this period', undefined, 2));
      blocks.push({
        kind: 'table',
        repeatHeader: true,
        caption:
          'Money received against serves billed on an earlier date. These are not ' +
          'serves and are not part of the billed totals above — they explain a drawer ' +
          "or account holding more than the period's sales.",
        columns: [
          { key: 'when', label: 'Received', width: 2 },
          { key: 'tab', label: 'Credit account', width: 2.4 },
          { key: 'method', label: 'Method', width: 1.4 },
          { key: 'ref', label: 'Reference', width: 1.8 },
          { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
        ],
        rows: [
          ...collections.map((c) => ({
            cells: [
              dateTime(c.recorded_at),
              c.house_tab_name,
              titleCase(c.method),
              orDash(c.reference_no),
              money(c.amount_cents),
            ],
          })),
          totalRow(['Total credit collected', '', '', '', money(total)]),
        ],
      });
    }

    return blocks;
  },
});

// ---------------------------------------------------------------------------
// Voids and discounts — the exception report
// ---------------------------------------------------------------------------

export const opsVoidsDiscounts = defineSection<OrderHistoryResp>({
  id: 'ops.voids_discounts',
  group: 'Operations',
  label: 'Voids and discounts',
  description: 'Every voided line and discounted serve — the exception report.',
  perm: 'order:read',
  needsRange: true,
  explainerIds: ['voids', 'discounts'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: loadHistory,
  rowCount: (d) =>
    d.orders.filter((o) => o.discount_cents > 0).length +
    d.orders.reduce((n, o) => n + o.items.filter((it) => it.voided_at).length, 0),
  resolvedWindow: (d) => ({ from: d.from ?? d.date, to: d.to ?? d.date, timezone: d.timezone }),
  render: (d) => {
    const discounted = d.orders.filter((o) => o.discount_cents > 0);
    const voids = d.orders.flatMap((o) =>
      o.items.filter((it) => it.voided_at).map((it) => ({ order: o, item: it })),
    );

    const discTotal = discounted.reduce((n, o) => n + o.discount_cents, 0);
    const voidTotal = voids.reduce((n, v) => n + v.item.line_cents, 0);

    return [
      heading('Voids and discounts', 'Exceptions worth a second look'),
      {
        kind: 'kpis',
        cells: [
          { label: 'Serves discounted', value: count(discounted.length) },
          {
            label: 'Discount given',
            value: money(discTotal),
            tone: discTotal > 0 ? 'warn' : undefined,
          },
          { label: 'Lines voided', value: count(voids.length) },
          {
            label: 'Value voided',
            value: money(voidTotal),
            tone: voidTotal > 0 ? 'warn' : undefined,
          },
        ],
      },
      heading('Discounted serves', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption: discounted.length === 0 ? 'No serves were discounted in this period.' : undefined,
        columns: [
          { key: 'when', label: 'Settled', width: 2 },
          { key: 'table', label: 'Table', width: 2 },
          { key: 'sub', label: 'Subtotal', numeric: true, width: 1.6 },
          { key: 'disc', label: 'Discount', numeric: true, width: 1.6 },
          { key: 'rate', label: 'Rate', numeric: true, width: 1.2 },
          { key: 'total', label: 'Billed total', numeric: true, width: 1.8 },
        ],
        rows: [
          ...discounted.map((o) => ({
            cells: [
              o.closed_at ? dateTime(o.closed_at) : '—',
              resolveTableLabel(o),
              money(o.subtotal_cents),
              money(o.discount_cents),
              o.subtotal_cents > 0
                ? `${((o.discount_cents / o.subtotal_cents) * 100).toFixed(1)}%`
                : '—',
              money(o.total_cents),
            ],
          })),
          ...(discounted.length > 0 ? [totalRow(['Total', '', '', money(discTotal), '', ''])] : []),
        ],
      },
      heading('Voided lines', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption: voids.length === 0 ? 'No lines were voided in this period.' : undefined,
        columns: [
          { key: 'when', label: 'Voided', width: 2 },
          { key: 'table', label: 'Table', width: 1.8 },
          { key: 'item', label: 'Item', width: 2.4 },
          { key: 'qty', label: 'Qty', numeric: true, width: 1 },
          { key: 'value', label: 'Line value', numeric: true, width: 1.6 },
          { key: 'reason', label: 'Reason', width: 2.4 },
        ],
        rows: [
          ...voids.map((v) => ({
            cells: [
              dateTime(v.item.voided_at),
              resolveTableLabel(v.order),
              v.item.menu_item_name,
              qty(v.item.qty),
              money(v.item.line_cents),
              orDash(v.item.void_reason),
            ],
          })),
          ...(voids.length > 0 ? [totalRow(['Total', '', '', '', money(voidTotal), ''])] : []),
        ],
      },
      note(
        'Voided lines never reached a bill, so their value is not part of sales. They are ' +
          'listed because a pattern of voids is worth investigating.',
      ),
    ];
  },
});

// ---------------------------------------------------------------------------
// Shift log + per-shift reconciliation
// ---------------------------------------------------------------------------

type ShiftData = { shifts: Shift[]; summaries: ShiftSummaryReport[] };

export const opsShifts = defineSection<ShiftData>({
  id: 'ops.shifts',
  group: 'Operations',
  label: 'Shifts and cash drawer',
  description: 'Every shift with its opening float, expected cash, count and variance.',
  perm: 'shift:read',
  needsRange: false,
  defaultDetail: 'summary',
  detailLevels: ['summary', 'full'],
  explainerIds: ['expected-cash', 'variance', 'opening-float', 'cash-drops'],
  load: async (ctx) => {
    const shifts = (await get<{ shifts: Shift[] }>(ctx, '/v1/shifts')).shifts;
    // Full detail needs the per-shift reconciliation, which is one request each.
    // Bound the fan-out: a shift-by-shift appendix past ~30 closes is not
    // something anyone reads, and it would be 30 round-trips.
    const recent = shifts.slice(0, 30);
    const summaries = await Promise.all(
      recent.map((s) => get<ShiftSummaryReport>(ctx, `/v1/shifts/${s.id}/summary`)),
    );
    return { shifts, summaries };
  },
  rowCount: (d) => d.shifts.length,
  render: (d, opts) => {
    const closed = d.shifts.filter((s) => s.closed_at);
    const varianceTotal = closed.reduce((n, s) => n + (s.variance_cents ?? 0), 0);

    const blocks: ReportBlock[] = [
      heading('Shifts and cash drawer'),
      {
        kind: 'table',
        repeatHeader: true,
        caption: d.shifts.length === 0 ? 'No shifts have been recorded.' : undefined,
        columns: [
          { key: 'opened', label: 'Opened', width: 2 },
          { key: 'closed', label: 'Closed', width: 2 },
          { key: 'float', label: 'Opening float', numeric: true, width: 1.6 },
          { key: 'expected', label: 'Expected cash', numeric: true, width: 1.8 },
          { key: 'counted', label: 'Counted', numeric: true, width: 1.6 },
          { key: 'var', label: 'Variance', numeric: true, width: 1.6 },
        ],
        rows: [
          ...d.shifts.map((s) => {
            const open = !s.closed_at;
            const variance = s.variance_cents ?? 0;
            return {
              cells: [
                dateTime(s.opened_at),
                s.closed_at ? dateTime(s.closed_at) : 'still open',
                money(s.opening_float_cents),
                money(open ? s.live_expected_cash_cents : (s.expected_cash_cents ?? 0)),
                open ? '—' : money(s.closing_count_cents ?? 0),
                open ? '—' : signedMoney(variance),
              ],
              muted: open,
            };
          }),
          ...(closed.length > 0
            ? [
                totalRow([
                  'Total variance across closed shifts',
                  '',
                  '',
                  '',
                  '',
                  signedMoney(varianceTotal),
                ]),
              ]
            : []),
        ],
      },
      note(
        'Variance is counted cash less expected cash: negative is short, positive is over. ' +
          'Expected cash for an open shift is live and nothing has been counted yet, so those ' +
          'rows show no variance.',
      ),
    ];

    if (opts.detail === 'full') {
      d.summaries.forEach((s) => {
        blocks.push({ kind: 'pagebreak' });
        blocks.push(
          heading(
            `Shift of ${shortDate(s.opened_at)}`,
            s.is_open ? 'Still open — figures are live' : `Closed ${dateTime(s.closed_at)}`,
            2,
          ),
        );
        blocks.push({
          kind: 'rows',
          rows: [
            { label: 'Opening float', value: money(s.opening_float_cents) },
            { label: 'Cash from serves', value: money(s.cash_in_cents) },
            { label: 'Credit collected in cash', value: money(s.credit_settled_cash_cents) },
            { label: 'Cash brought in', value: money(s.drops_in_cents, { zeroDash: true }) },
            {
              label: 'Cash taken out',
              value: money(s.drops_out_cents, { zeroDash: true }),
              tone: 'warn',
            },
            { label: 'Expected in drawer', value: money(s.expected_cash_cents), total: true },
            ...(s.is_open
              ? []
              : [
                  { label: 'Counted at close', value: money(s.closing_count_cents) },
                  {
                    label: 'Variance',
                    value: signedMoney(s.variance_cents),
                    total: true,
                    tone: (s.variance_cents === 0
                      ? 'good'
                      : Math.abs(s.variance_cents) < 5000
                        ? 'warn'
                        : 'bad') as 'good' | 'warn' | 'bad',
                  },
                ]),
          ],
        });
        blocks.push({
          kind: 'rows',
          rows: [
            { label: 'Serves', value: count(s.order_count) },
            { label: 'Billed sales', value: money(s.billed_sales_cents) },
            { label: 'of which on credit', value: money(s.on_credit_cents, { zeroDash: true }) },
            { label: 'Collected', value: money(s.received_cents) },
            {
              label: 'Credit collected digitally',
              value: money(s.credit_settled_other_cents, { zeroDash: true }),
            },
            { label: 'Discounts', value: money(s.discount_cents, { zeroDash: true }) },
            { label: 'Voided lines', value: count(s.void_count) },
            {
              label: 'Expenses paid from the drawer',
              value: money(s.expenses_cents, { zeroDash: true }),
            },
          ],
        });
        if (s.payment_methods.length > 0) {
          blocks.push({
            kind: 'table',
            repeatHeader: true,
            caption: 'How guests paid during this shift',
            columns: [
              { key: 'method', label: 'Method', width: 3 },
              { key: 'n', label: 'Payments', numeric: true, width: 1.4 },
              { key: 'amt', label: 'Amount', numeric: true, width: 2 },
            ],
            rows: s.payment_methods.map((m) => ({
              cells: [titleCase(m.method), count(m.count), money(m.amount_cents)],
            })),
          });
        }
        if (s.notes.trim()) {
          blocks.push({ kind: 'prose', paragraphs: [`Notes: ${s.notes.trim()}`] });
        }
      });

      if (d.shifts.length > d.summaries.length) {
        blocks.push(
          note(
            `Detailed reconciliation is shown for the ${count(d.summaries.length)} most recent ` +
              `shifts of ${count(d.shifts.length)}. The summary table above covers them all.`,
          ),
        );
      }
    }

    return blocks;
  },
});

export const OPS_SECTIONS = [opsOrderLog, opsVoidsDiscounts, opsShifts];
