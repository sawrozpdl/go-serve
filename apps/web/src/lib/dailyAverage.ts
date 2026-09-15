// "Average daily sales" — the figure under the Dashboard's Daily sales chart.
//
// It used to be `sum / daily.length`, which is wrong twice over, and wrong in
// the direction that makes a good week look bad:
//
//  1. TODAY IS IN THE SERIES. The API's range resolver ends "today"/"7d"/"30d"
//     and friends at end-of-day, so generate_series always emits a bucket for
//     a day that is still being traded. At 9am that bucket holds one coffee,
//     and it drags the mean down every single morning — which is exactly when
//     an owner looks at it.
//
//  2. THE SERIES IS PADDED. For any preset shorter than 14 days the API trails
//     the chart back to ~14 days so there are bars to look at (reports.go,
//     `chartFrom = rng.To.AddDate(0, 0, -14)`). So `range=today` returns
//     FIFTEEN buckets, fourteen of which are outside the window the KPI beside
//     it covers — and for a young workspace, several of which predate the cafe
//     existing at all. Averaging over that array answers no question anyone
//     asked.
//
// The API already hands us everything needed to avoid both: `from`/`to` are the
// requested window, `daily_from`/`daily_to` the padded one, and `daily_padded`
// says whether they differ. The old code ignored all three.
//
// So: average over COMPLETED days inside the REQUESTED window. A day is
// completed or it is not — there is no partial credit — and a window the user
// did not ask for is not theirs to average.

/** How the figure was arrived at. Printed, not hidden in a tooltip: an average
 *  whose basis you cannot see is how the old one misled. */
export type AverageBasis =
  /** Whole days before today, inside the requested window. The normal case. */
  | 'completed'
  /** No completed day existed (range=today, or a workspace opened this
   *  morning), so today's partial figure is shown and labelled as partial. */
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
  /** Requested window start, ISO instant or YYYY-MM-DD. Undefined → no clamp. */
  from?: string;
  /** Requested window end (exclusive upper bound), same forms. */
  to?: string;
  /** Cafe timezone, e.g. "Asia/Kathmandu". Undefined → treat inputs as dates. */
  timezone?: string;
  /** The cafe's today, as YYYY-MM-DD. Caller resolves it — see isoDayInTz. */
  today: string;
};

/**
 * The cafe's calendar day for an instant — not the browser's, and emphatically
 * not UTC. A cafe in Kathmandu (UTC+05:45) that closes at 22:00 local is
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
    // the cafe. Never toISOString(): that is UTC.
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
 * Average daily sales over completed days within the requested window.
 *
 * Zero-sales days are KEPT. A day the cafe was closed is a real zero inside the
 * range the user asked about; dropping it would quietly turn "average day" into
 * "average trading day" and inflate the figure — a different question, and not
 * the one the label asks.
 */
export function dailyAverage(
  daily: readonly DailyPointLike[],
  opts: DailyAverageOpts,
): DailyAverage {
  const { timezone, today } = opts;
  const from = dayKey(opts.from, timezone);
  const to = dayKey(opts.to, timezone);

  // 1. Clamp to the REQUESTED window, discarding the chart's padding buckets.
  //    `to` is an exclusive upper bound on the server, but it is rendered as
  //    end-of-day, so its own date is inclusive here.
  const inWindow = daily.filter((d) => {
    if (from && d.day < from) return false;
    if (to && d.day > to) return false;
    return true;
  });

  // 2. Completed days only — strictly before the cafe's today.
  const completed = inWindow.filter((d) => d.day < today);

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

  // 3. No completed day — "today" ranges, or a workspace opened this morning.
  //    Show the partial figure rather than a bare zero, and say it is partial.
  if (inWindow.length > 0) {
    return {
      avgCents: mean(inWindow),
      days: inWindow.length,
      basis: 'includes-today',
      caption: 'today so far — no completed day in this range yet',
    };
  }

  return { avgCents: 0, days: 0, basis: 'none', caption: 'no days in this range' };
}
