/**
 * Day arithmetic on plain `YYYY-MM-DD` strings.
 *
 * Deliberately string-in / string-out and UTC-internally: a `Date` shifted by
 * 24h crosses DST wrong twice a year, and Nepal's +05:45 offset makes the
 * naive `toISOString().slice(0,10)` land on the wrong day for half the
 * evening. `todayStr` therefore reads the LOCAL calendar fields, and every
 * shift is done in UTC where days are exactly 24h.
 *
 * `now` / `today` are injected so tests never depend on the clock.
 */

/** Local YYYY-MM-DD for a given moment (defaults to now). */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shift a YYYY-MM-DD string by `delta` days (UTC math avoids DST drift). */
export function shiftDay(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Human label for a day: "Today", "Yesterday", else "Wed, Jul 1". */
export function formatDayLabel(dateStr: string, today: string = todayStr()): string {
  if (dateStr === today) return 'Today';
  if (dateStr === shiftDay(today, -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Is this the current day? (so the "next day" arrow can be disabled). */
export function isToday(dateStr: string, today: string = todayStr()): boolean {
  return dateStr === today;
}

/** First day of `dateStr`'s calendar month. */
export function startOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

/** Local HH:MM for a given moment — the "paid at" time field's default. */
export function nowHHMM(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
