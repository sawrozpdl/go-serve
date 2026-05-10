/** Format integer paisa as NPR. */
export function formatNPR(cents: number): string {
  const rupees = cents / 100;
  return `रू ${rupees.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function parsePriceInput(s: string): number | null {
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}
