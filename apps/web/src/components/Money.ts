/** Format integer paisa as NPR. */
export function formatNPR(cents: number): string {
  const rupees = cents / 100;
  return `रू ${rupees.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Format integer paisa as NPR with the paisa ALWAYS shown.
 *
 * formatNPR trims trailing zeros, which reads better in isolation but breaks a
 * column that has to be checked by eye: 228526.24 / 105354.3 / 0 doesn't line
 * up, and "does this add up?" becomes work. Use this wherever terms are stacked
 * above a total the reader is meant to verify. */
export function formatNPRExact(cents: number): string {
  const rupees = cents / 100;
  return `रू ${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a rupee decimal amount (NOT paisa) as NPR — used for salary/pay,
 *  which are stored as numeric rupees rather than integer paisa. */
export function formatRupees(rupees: number): string {
  return `रू ${rupees.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function parsePriceInput(s: string): number | null {
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}
