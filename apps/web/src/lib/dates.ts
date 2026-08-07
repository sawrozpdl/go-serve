// Local-calendar ISO date helpers (YYYY-MM-DD). Shared by the day-steppers on
// History and Profitability. All arithmetic is done in local time so a date
// picked at 23:00 NPT — or one that crosses a DST/month boundary — never lands
// on the wrong calendar day (the classic UTC off-by-one trap).

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Step an ISO date by whole days using local-calendar arithmetic (not UTC).
export function addDaysIso(iso: string, delta: number): string {
  const dt = new Date(`${iso}T00:00:00`);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function yesterdayIso(): string {
  return addDaysIso(todayIso(), -1);
}

// ---------------------------------------------------------------------------
// Timestamp display helpers.
//
// A date on its own ("17 Aug 2026") makes you do arithmetic; a relative phrase
// on its own ("in 14 days") makes you guess. The console always shows both, so
// these are the shared pair. Kept here (not in a component) so toast copy and
// email-free plain strings can use them too.
// ---------------------------------------------------------------------------

/** "17 Aug 2026", or `fallback` when there's no date. */
export function fmtDay(at?: string | null, fallback = '—'): string {
  if (!at) return fallback;
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Sun 17 Aug 2026" — the weekday matters when someone is picking a due date. */
export function fmtDayLong(at?: string | null, fallback = '—'): string {
  if (!at) return fallback;
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** Whole days from now until `at` (negative = in the past). */
export function daysUntil(at: string): number {
  return Math.round((new Date(at).getTime() - Date.now()) / 86_400_000);
}

/** "today" / "in 3 days" / "5 days ago". Empty string when there's no date. */
export function fmtRelative(at?: string | null): string {
  if (!at) return '';
  const d = daysUntil(at);
  if (d === 0) return 'today';
  if (d > 0) return d === 1 ? 'in 1 day' : `in ${d} days`;
  const ago = -d;
  return ago === 1 ? '1 day ago' : `${ago} days ago`;
}

/** "Sun 17 Aug 2026 · in 30 days" — the one-line form used in toast hints. */
export function fmtDayWithRelative(at?: string | null, fallback = '—'): string {
  if (!at) return fallback;
  const rel = fmtRelative(at);
  return rel ? `${fmtDayLong(at)} · ${rel}` : fmtDayLong(at);
}

/** Urgency of a date that governs something (a trial end, a paid-through). */
export type DateTone = 'neutral' | 'ok' | 'warn' | 'critical';

/** Lapsed = critical, within a fortnight = warn, otherwise fine. The 14-day
 *  window matches the "expiring soon" KPI the platform console already counts. */
export function toneForDate(at?: string | null): DateTone {
  if (!at) return 'neutral';
  const d = daysUntil(at);
  if (d < 0) return 'critical';
  if (d <= 14) return 'warn';
  return 'ok';
}

/** Urgency of a DATE-ONLY (YYYY-MM-DD) deadline, e.g. a lead's follow-up.
 *
 *  Deliberately not toneForDate: that one goes through `new Date(at)`, which
 *  reads a bare "2026-08-07" as UTC midnight — so anywhere east of Greenwich a
 *  follow-up due TODAY already reads as overdue, and the column that's meant to
 *  say "ring them this morning" says "you're late" instead. Comparing the
 *  strings is exact, timezone-proof, and matches the server's `due` filters
 *  (overdue = `< CURRENT_DATE`, today = `<= CURRENT_DATE`). */
export function toneForDueDate(due?: string | null): DateTone {
  if (!due) return 'neutral';
  const today = todayIso();
  if (due < today) return 'critical';
  if (due === today) return 'warn';
  return 'neutral';
}
