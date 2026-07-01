/** Formatting helpers shared across screens. */

/** Format integer paisa as NPR, matching web's `formatNPR` (Rs prefix — the
 * Devanagari रू is fine on-screen but folds to "Rs" on thermal printers). */
export function formatNPR(cents: number): string {
  const rupees = cents / 100;
  return `Rs ${rupees.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Compact "time ago" for tab age, e.g. "just now", "12m", "3h", "2d". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
