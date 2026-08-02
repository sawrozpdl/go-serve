/* Date clarity primitives for the platform console.
 *
 * Every date in /super governs something — when a trial locks, when coverage
 * lapses, when a payment period ends. A bare "17 Aug 2026" makes the reader do
 * arithmetic; a bare "in 14 days" makes them guess the date. So the console
 * always shows both, and any control that MOVES a date shows the before → after
 * before you commit to it.
 *
 * The formatting itself lives in lib/dates.ts so toast copy can use the same
 * strings without pulling in React.
 */

import { fmtDayLong, fmtRelative, toneForDate, type DateTone } from '@/lib/dates';

export function DateStamp({
  at,
  tone,
  label,
  fallback = '—',
}: {
  at?: string | null;
  /** Override the derived tone — e.g. a comped tenant's absent date isn't a problem. */
  tone?: DateTone;
  /** Optional caption above the date ("Trial ends", "Paid through"). */
  label?: string;
  fallback?: string;
}) {
  if (!at) {
    return (
      <span className="datestamp">
        {label && <span className="datestamp__label">{label}</span>}
        <span className="datestamp__date muted">{fallback}</span>
      </span>
    );
  }
  return (
    <span className={`datestamp datestamp--${tone ?? toneForDate(at)}`}>
      {label && <span className="datestamp__label">{label}</span>}
      <span className="datestamp__date">{fmtDayLong(at)}</span>
      <span className="datestamp__rel">{fmtRelative(at)}</span>
    </span>
  );
}

/** "3 Aug → 2 Sep 2026 · +30 days".
 *
 *  Shown inside the confirm step of anything that moves a date, so "add 30
 *  days" states its effect before the click rather than after it. `after` may
 *  be null for an action that clears the date (comping a subscription). */
export function DateDelta({ before, after }: { before?: string | null; after?: string | null }) {
  const delta =
    before && after ? Math.round((new Date(after).getTime() - new Date(before).getTime()) / 86_400_000) : null;
  return (
    <span className="datedelta">
      <span className="datedelta__from">{before ? fmtDayLong(before) : 'not set'}</span>
      <span className="datedelta__arrow" aria-hidden>→</span>
      <span className="datedelta__to">{after ? fmtDayLong(after) : 'cleared'}</span>
      {delta !== null && delta !== 0 && (
        <span className="datedelta__by">
          {delta > 0 ? '+' : '−'}
          {Math.abs(delta)} {Math.abs(delta) === 1 ? 'day' : 'days'}
        </span>
      )}
    </span>
  );
}
