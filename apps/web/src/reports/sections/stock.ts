// Inventory sections — stock on hand and stock movements.
//
// Quantities arrive as strings because the DB column is `numeric` (half plates
// need fractions, see migration 0044). Parse for arithmetic, but print the
// server's string where possible so a value never gains or loses precision on
// the way to paper.

import { request } from '@/lib/api';
import type { InventoryItem, StockMovement } from '@cafe-mgmt/api-types';

import { count, money, orDash, shortDate, titleCase } from '../format';
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

function get<T>(ctx: LoadCtx, path: string): Promise<T> {
  return request<T>('GET', path, { tenantSlug: ctx.slug });
}

function num(s: string | null | undefined): number {
  const v = Number.parseFloat(s ?? '0');
  return Number.isFinite(v) ? v : 0;
}

/** Stock value at last known purchase cost — the only cost we have per unit. */
function itemValueCents(it: InventoryItem): number {
  const unit = it.last_purchase_unit_cost_cents ?? 0;
  return Math.round(num(it.qty_on_hand_units) * unit);
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

export const stockOnHand = defineSection<{ items: InventoryItem[] }>({
  id: 'inv.on_hand',
  group: 'Inventory',
  label: 'Stock on hand',
  description: 'Current quantity and value of every stocked item. Point in time.',
  perm: 'inventory:read',
  feature: 'inventory',
  // Stock is a snapshot, like balances — it is whatever it is now.
  needsRange: false,
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<{ items: InventoryItem[] }>(ctx, '/v1/inventory'),
  rowCount: (d) => d.items.length,
  render: (d) => {
    const items = d.items;
    const low = items.filter((it) => it.is_low_stock);
    const valued = items.filter((it) => (it.last_purchase_unit_cost_cents ?? 0) > 0);
    const totalValue = items.reduce((n, it) => n + itemValueCents(it), 0);

    const blocks: ReportBlock[] = [
      heading('Stock on hand', 'Position as at the moment this report was generated'),
      note(
        'Quantities and values are current, not period figures — they are unaffected by ' +
          'the reporting period stated on the cover.',
      ),
      {
        kind: 'kpis',
        cells: [
          { label: 'Items stocked', value: count(items.length) },
          {
            label: 'Below par level',
            value: count(low.length),
            tone: low.length > 0 ? 'warn' : 'good',
          },
          { label: 'Value at last cost', value: money(totalValue) },
        ],
      },
    ];

    if (low.length > 0) {
      blocks.push(heading('Needs reordering', undefined, 2));
      blocks.push({
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'name', label: 'Item', width: 3 },
          { key: 'qty', label: 'On hand', numeric: true, width: 1.6 },
          { key: 'par', label: 'Par level', numeric: true, width: 1.6 },
          { key: 'unit', label: 'Unit', width: 1.2 },
        ],
        rows: low.map((it) => ({
          cells: [it.name, it.qty_on_hand_units, it.par_low_units, it.sale_unit],
        })),
      });
    }

    blocks.push(heading('All stocked items', undefined, 2));
    blocks.push({
      kind: 'table',
      repeatHeader: true,
      caption: items.length === 0 ? 'No inventory items exist.' : undefined,
      columns: [
        { key: 'name', label: 'Item', width: 2.8 },
        { key: 'sku', label: 'SKU', width: 1.6 },
        { key: 'kind', label: 'Type', width: 1.4 },
        { key: 'qty', label: 'On hand', numeric: true, width: 1.4 },
        { key: 'unit', label: 'Unit', width: 1.2 },
        { key: 'par', label: 'Par', numeric: true, width: 1.2 },
        { key: 'cost', label: 'Last unit cost', numeric: true, width: 1.6 },
        { key: 'value', label: 'Value', numeric: true, width: 1.6 },
      ],
      rows: [
        ...items.map((it) => ({
          cells: [
            it.name,
            orDash(it.sku),
            titleCase(it.kind),
            it.qty_on_hand_units,
            it.sale_unit,
            it.par_low_units,
            money(it.last_purchase_unit_cost_cents ?? 0, { zeroDash: true }),
            money(itemValueCents(it), { zeroDash: true }),
          ],
          muted: it.is_low_stock,
        })),
        totalRow(['Total value', '', '', '', '', '', '', money(totalValue)]),
      ],
    });

    // A stock value that silently omits unpriced items reads as a full valuation.
    if (valued.length < items.length) {
      blocks.push(
        note(
          `${count(items.length - valued.length)} of ${count(items.length)} items have no recorded ` +
            `purchase cost and are valued at zero above, so the total understates the real ` +
            `stock value.`,
          'warn',
        ),
      );
    }

    return blocks;
  },
});

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------

type MovementRow = StockMovement & { itemName: string; unit: string };
type MovementData = { rows: MovementRow[]; total: number; truncated: boolean };

export const stockMovements = defineSection<MovementData>({
  id: 'inv.movements',
  group: 'Inventory',
  label: 'Stock movements',
  description: 'Every purchase, sale deduction, waste and manual correction.',
  perm: 'inventory:read',
  feature: 'inventory',
  needsRange: false,
  defaultDetail: 'topN',
  detailLevels: ['topN', 'full'],
  load: async (ctx) => {
    const items = (await get<{ items: InventoryItem[] }>(ctx, '/v1/inventory')).items;
    // Movements are per-item on the API, so the report walks every item and
    // merges. Without this the export could only ever show one item's history.
    const perItem = await Promise.all(
      items.map(async (it) => {
        const paged = await pageAll<StockMovement>(
          async (offset, limit) => {
            const r = await get<{ movements: StockMovement[]; total: number }>(
              ctx,
              `/v1/inventory/${it.id}/movements?limit=${limit}&offset=${offset}`,
            );
            return { rows: r.movements, total: r.total };
          },
          // The endpoint caps a page at 200.
          { pageSize: 200, hardCap: 2000 },
        );
        return {
          rows: paged.rows.map((m) => ({ ...m, itemName: it.name, unit: it.sale_unit })),
          truncated: paged.truncated,
        };
      }),
    );
    const rows = perItem
      .flatMap((p) => p.rows)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return {
      rows,
      total: rows.length,
      truncated: perItem.some((p) => p.truncated),
    };
  },
  rowCount: (d) => d.total,
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.rows, opts, {
      total: d.total,
      truncated: d.truncated,
      orderedBy: 'date (most recent first)',
      emptyText: 'No stock movements have been recorded.',
    });
    return [
      heading('Stock movements'),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'when', label: 'Date', width: 1.6 },
          { key: 'item', label: 'Item', width: 2.4 },
          { key: 'reason', label: 'Reason', width: 1.6 },
          { key: 'delta', label: 'Change', numeric: true, width: 1.4 },
          { key: 'unit', label: 'Unit', width: 1 },
          { key: 'cost', label: 'Unit cost', numeric: true, width: 1.4 },
          { key: 'who', label: 'By', width: 1.8 },
          { key: 'notes', label: 'Notes', width: 2.2 },
        ],
        rows: rows.map((m) => {
          const delta = num(m.delta_units);
          return {
            cells: [
              shortDate(m.at),
              m.itemName,
              titleCase(m.reason),
              // Sign it explicitly: "5" and "-5" are the whole meaning of the row.
              delta > 0 ? `+${m.delta_units}` : m.delta_units,
              m.unit,
              money(m.unit_cost_cents ?? 0, { zeroDash: true }),
              orDash(m.by_user_name),
              orDash(m.notes),
            ],
            muted: delta < 0,
          };
        }),
      },
    ];
  },
});

export const STOCK_SECTIONS = [stockOnHand, stockMovements];
