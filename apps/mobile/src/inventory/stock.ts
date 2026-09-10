/**
 * Pure stock helpers for the Inventory screen.
 *
 * Quantities cross the wire as STRINGS, not numbers: they are Postgres
 * `numeric`, and JSON's float would silently round a 3-decimal recipe
 * quantity. So everything here parses defensively and never hands a raw
 * `numeric` string to a renderer.
 */
import type { InventoryItem, StockMovement, StockReason } from '@cafe-mgmt/api-types';

/** Parse a `numeric` string, treating anything unparseable as zero. */
function num(qty: string | null | undefined): number {
  const n = parseFloat(qty ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * More has been sold than was ever recorded as coming in — the ledger is
 * below zero.
 *
 * This is a different problem from low stock and needs saying separately: low
 * means "order more", negative means "the book is wrong", and a cafe that
 * reads the second as the first goes on trusting a count that cannot be true.
 */
export function isNegativeStock(item: InventoryItem): boolean {
  return num(item.qty_on_hand_units) < 0;
}

/**
 * How many items need attention, and of which kind.
 *
 * A negative item is deliberately NOT counted as low even when the server
 * flags it that way: it is already being reported as the worse of the two, and
 * counting it twice makes the two badges add up to more than the list.
 */
export function stockCounts(items: InventoryItem[] | undefined): { low: number; negative: number } {
  let low = 0;
  let negative = 0;
  for (const it of items ?? []) {
    if (isNegativeStock(it)) negative += 1;
    else if (it.is_low_stock) low += 1;
  }
  return { low, negative };
}

/**
 * Trim the trailing zeros Postgres pads a `numeric` with, so "200.000" reads
 * as "200" while "12.500" keeps the half it needs.
 */
export function trimQty(qty: string | null | undefined): string {
  const s = (qty ?? '').trim();
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/** Signed delta with an explicit sign, for a ledger column. */
export function formatDelta(delta: string): string {
  const n = num(delta);
  const body = trimQty(n < 0 ? delta.replace(/^-/, '') : delta);
  return `${n < 0 ? '−' : '+'}${body}`;
}

export type MovementRow = { movement: StockMovement; balanceAfter: number };

/**
 * Walk the running balance back up the ledger.
 *
 * Movements arrive newest-first, so the balance AFTER the newest row is
 * today's on-hand figure, and each older row's balance is the one above it
 * minus the newer row's delta. Done here rather than server-side because only
 * the client knows how much of the ledger it is showing.
 *
 * Rounded to 3 decimals at the end: repeated float subtraction of decimal
 * quantities otherwise prints 11.899999999999999 on a page of tea purchases.
 */
export function runningBalances(
  movements: StockMovement[],
  onHandUnits: string,
): MovementRow[] {
  let running = num(onHandUnits);
  return movements.map((movement) => {
    const balanceAfter = Math.round(running * 1000) / 1000;
    running -= num(movement.delta_units);
    return { movement, balanceAfter };
  });
}

/** How a movement should read: stock arriving, leaving, or being corrected. */
export function movementTone(reason: StockReason): 'success' | 'danger' | 'warn' | 'neutral' {
  switch (reason) {
    case 'purchase':
      return 'success';
    case 'sale':
      return 'neutral';
    case 'waste':
      return 'danger';
    default:
      return 'warn';
  }
}

const REASON_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  sale: 'Sold',
  waste: 'Waste',
  adjust: 'Correction',
  transfer: 'Transfer',
};

export function movementLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

/**
 * Human form of a pack rule: "1 carton = 200 bottle".
 *
 * The whole point of a pack rule is that stock is BOUGHT in one unit and SOLD
 * in another, so both halves have to be on screen — a bare "200" says nothing
 * about what was bought.
 */
export function packRuleLabel(rule: {
  container_qty: number;
  container_unit: string;
  sale_qty_per_container: number;
  sale_unit: string;
}): string {
  return `${rule.container_qty} ${rule.container_unit} = ${rule.sale_qty_per_container} ${rule.sale_unit}`;
}
