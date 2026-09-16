// "Average daily sales" — the figure under the Dashboard's Daily sales chart,
// and the dashed line drawn across it.
//
// It used to be `sum / daily.length`. That has one real defect: TODAY IS IN THE
// SERIES. The API's range resolver ends "today"/"7d"/"30d" and friends at
// end-of-day, so generate_series always emits a bucket for a day that is still
// being traded. At 9am that bucket holds one coffee and drags the mean down —
// which is exactly when an owner looks at it.
//
// THE MISTAKE THIS FILE MADE FIRST TIME ROUND
//
// The original fix also clamped the series to the REQUESTED window, reasoning
// that the ~14 padding buckets the API prepends for short presets (reports.go,
// `chartFrom = rng.To.AddDate(0, 0, -14)`) were days nobody asked about. That
// is wrong, and it broke the default view:
//
//   * the Dashboard opens on `range=today`. Clamped to the requested window,
//     "today" contains exactly one day, that day is not complete, and so there
//     were ZERO completed days to average. The figure fell back to today's
//     partial takings — ₹1,800 on a café whose real average is ₹10,950 —
//     printed under a label reading "avg /day". An average of one unfinished
//     day is not an average.
//   * the padding buckets are not hypothetical days. They are DRAWN. The chart
//     renders every bucket in `daily`, and the average line is positioned as
//     `avgCents / maxBar` where maxBar spans that same full array. Averaging a
//     narrower population than the line is drawn against put the line at the
//     wrong height too.
//
// So the rule is: average over the days THE CHART DRAWS, which is the padded
// window (`daily_from`/`daily_to`) when the API padded it, excluding any day
// that is not finished.
//
// ONE DELIBERATE EXCEPTION: the "Today" filter caps at the last SEVEN completed
// days (`limitDays`). The chart still draws its fourteen padded bars, but an
// owner checking today wants "how are we doing lately", and a fortnight is long
// enough to blunt exactly the recent change they are looking for. Every other
// range averages the whole span it draws.
//
// The caption always names the day count and the span, so a seven-day average
// under a "Today" filter explains itself rather than surprising someone.
//
// Zero-sales days are KEPT. A day the café was closed is a real zero inside the
// span being averaged; dropping it would quietly turn "average day" into
// "average trading day" and inflate the figure — a different question, and not
// the one the label asks.

/** How the figure was arrived at. Printed, not hidden in a tooltip: an average
 *  whose basis you cannot see is how the old one misled. */
export type AverageBasis =
  /** Whole days before today, across the charted span. The normal case. */
  | 'completed'
  /** No completed day exists at all — a workspace opened this morning. Today's
   *  partial figure is shown and labelled as partial. */
  | 'includes-today'
  /** Nothing to average at all. */
  | 'none';

export type DailyAverage = {
  avgCents: number;
  /** How many days the figure covers. Zero only when basis is 'none'. */
  days: number;
  /** Short human basis, rendered beside the figure. */
  caption: string;
  basis: AverageBasis;
};

export type DailyPointLike = { day: string; sales_cents: number };

export type DailyAverageOpts = {
  /** Start of the span THE CHART COVERS — `daily_from`, falling back to `from`
   *  when the API did not pad. ISO instant or YYYY-MM-DD. Undefined → no clamp,
   *  which is right, because `daily` is already exactly the charted series. */
  from?: string;
  /** End of that span, inclusive by date (`daily_to`, else `to`). */
  to?: string;
  /** Café timezone, e.g. "Asia/Kathmandu". Undefined → treat inputs as dates. */
  timezone?: string;
  /** The café's today, as YYYY-MM-DD. Caller resolves it — see isoDayInTz. */
  today: string;
  /** Cap the average at the N most recent completed days. Used by the "Today"
   *  filter, where the charted span is fourteen padded days but the useful
   *  figure is the last week's trading — "how are we doing lately", not "how
   *  did the fortnight go". Undefined → every completed day in the span. */
  limitDays?: number;
};

/**
 * The café's calendar day for an instant — not the browser's, and emphatically
 * not UTC. A café in Kathmandu (UTC+05:45) that closes at 22:00 local is
 * already on tomorrow's UTC date, so a UTC day key marks the wrong bar "today"
 * and drops a real trading day out of the average.
 *
 * `en-CA` is used because its short date format is already YYYY-MM-DD, which is
 * the same shape the API's `daily[].day` keys use — no reformatting, and no
 * month/day ambiguity to get backwards.
 */
export function isoDayInTz(ts: string | Date, timeZone?: string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  if (!timeZone) {
    // No tenant timezone to hand — fall back to the browser's local calendar,
    // which is right for the overwhelmingly common case of staff standing in
    // the café. Never toISOString(): that is UTC.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    // An unknown IANA zone must not take the dashboard down with it.
    return isoDayInTz(d, undefined);
  }
}

/** YYYY-MM-DD out of either an ISO instant or an already-bare date. */
function dayKey(v: string | undefined, timeZone?: string): string | undefined {
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const k = isoDayInTz(v, timeZone);
  return k || undefined;
}

function rangeLabel(first: string, last: string): string {
  // "01–07 Sep" when inside one month, "28 Aug–03 Sep" across a boundary.
  const f = new Date(`${first}T00:00:00`);
  const l = new Date(`${last}T00:00:00`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(l.getTime())) return '';
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  const dd = (d: Date) => String(d.getDate()).padStart(2, '0');
  if (first === last) return `${dd(f)} ${mon(f)}`;
  return f.getMonth() === l.getMonth() && f.getFullYear() === l.getFullYear()
    ? `${dd(f)}–${dd(l)} ${mon(l)}`
    : `${dd(f)} ${mon(f)}–${dd(l)} ${mon(l)}`;
}

/**
 * Average daily sales over the completed days the chart draws.
 */
export function dailyAverage(
  daily: readonly DailyPointLike[],
  opts: DailyAverageOpts,
): DailyAverage {
  const { timezone, today } = opts;
  const from = dayKey(opts.from, timezone);
  const to = dayKey(opts.to, timezone);

  // 1. Clamp to the charted span. Normally a no-op — `daily` IS that span — so
  //    this only guards against a series wider than the window it reports.
  const inWindow = daily.filter((d) => {
    if (from && d.day < from) return false;
    if (to && d.day > to) return false;
    return true;
  });

  // 2. Completed days only — strictly before the café's today. This is the part
  //    worth having: it keeps a half-traded today from dragging the mean down.
  const finished = inWindow.filter((d) => d.day < today);

  // 3. Optionally keep only the most recent N of them. `daily` is ordered
  //    oldest-first by the API (ORDER BY local_day), so the tail is the recent
  //    end. A cap wider than the data is simply not a cap.
  const completed =
    opts.limitDays && opts.limitDays > 0 && finished.length > opts.limitDays
      ? finished.slice(-opts.limitDays)
      : finished;

  const mean = (rows: readonly DailyPointLike[]) =>
    Math.round(rows.reduce((s, d) => s + d.sales_cents, 0) / rows.length);

  if (completed.length > 0) {
    const first = completed[0]!.day;
    const last = completed[completed.length - 1]!.day;
    const span = rangeLabel(first, last);
    return {
      avgCents: mean(completed),
      days: completed.length,
      basis: 'completed',
      caption: `${completed.length} completed day${completed.length === 1 ? '' : 's'}${
        span ? ` · ${span}` : ''
      }`,
    };
  }

  // 4. No completed day anywhere in the series — a workspace opened this
  //    morning. Show the partial figure rather than a bare zero, and say so.
  if (inWindow.length > 0) {
    return {
      avgCents: mean(inWindow),
      days: inWindow.length,
      basis: 'includes-today',
      caption: 'today so far — no completed day yet',
    };
  }

  return { avgCents: 0, days: 0, basis: 'none', caption: 'no days in this range' };
}
