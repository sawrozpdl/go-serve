// Report formatting.
//
// Sections hand the layout finished strings — blocks never format anything. This
// module is that formatting layer, and it deliberately reuses the app's own
// `formatNPR` so a figure in the PDF reads identically to the same figure on
// screen (including the रू symbol and en-IN grouping).

import { formatNPR } from '@/components/Money';

export { formatNPR };

/** Money, with a dash for a true zero so a sparse table stays readable. */
export function money(cents: number | null | undefined, opts?: { zeroDash?: boolean }): string {
  const v = cents ?? 0;
  if (v === 0 && opts?.zeroDash) return '—';
  return formatNPR(v);
}

/** Signed money — for variances and deltas, where the direction is the point. */
export function signedMoney(cents: number | null | undefined): string {
  const v = cents ?? 0;
  if (v === 0) return formatNPR(0);
  return `${v > 0 ? '+' : '−'}${formatNPR(Math.abs(v))}`;
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function signedPct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function count(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-IN');
}

/** Quantities can be fractional (half plates — qty is numeric(6,2)). */
export function qty(n: number | null | undefined): string {
  const v = n ?? 0;
  return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toFixed(2);
}

/** `05 Jun 2026` — the report's one date format. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** `05 Jun 2026, 14:32` — for ledger rows where the time matters. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(
    'en-GB',
    { hour: '2-digit', minute: '2-digit' },
  )}`;
}

/** Timestamp for the cover / running footers. */
export function generatedStamp(now = new Date()): string {
  return now.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `drawer` -> `Cash drawer`, for the expense register's source column. */
export const PAID_FROM_LABELS: Record<string, string> = {
  drawer: 'Cash drawer',
  bank: 'Bank / online',
  owner: 'Owner advanced',
  owner_cash: 'Owner-held cash',
};

export function paidFromLabel(v: string | null | undefined): string {
  if (!v) return '—';
  return PAID_FROM_LABELS[v] ?? titleCase(v);
}

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Empty-string-safe fallback for optional text columns. */
export function orDash(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return t === '' ? '—' : t;
}
