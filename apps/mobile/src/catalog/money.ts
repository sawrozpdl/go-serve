/**
 * Money <-> text-field helpers for the catalog forms (prices, costs). Kept pure
 * and unit-tested; the same parse rule the settle sheet uses, centralised.
 */

/** Parse a user-typed price ("12", "12.5", "Rs 1,200.50") to integer cents.
 * Strips everything but digits and a single dot; non-numeric → 0. */
export function parsePriceToCents(input: string): number {
  const cleaned = input.replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/** Render cents back into a compact editable string: 1200 → "12", 1250 → "12.5",
 * 1299 → "12.99". null/0 → "". */
export function centsToPriceInput(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return '';
  return String(cents / 100);
}
