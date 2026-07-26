// Resolving a report range into concrete tenant-local days.
//
// Most analytics endpoints understand a preset (`range=lastmonth`) and resolve
// it server-side in the tenant timezone. But several endpoints the report needs
// take only explicit days — expenses (`from`/`to` on paid_at), order history,
// the audit log, staff pay — and they treat a MISSING from/to as "no filter".
//
// So sending a preset to those is not a no-op, it is silently unfiltered: a
// "June" report happily listed July's expenses because `rangeToQuery({preset})`
// produced no dates at all. Anything that needs days must come through here.
//
// The conversion is delegated to the server rather than computed locally: only
// it knows where the tenant's day boundary falls (Asia/Kathmandu is +05:45, so
// a browser-local calculation is wrong by hours and can land on the wrong day).

import { request } from '@/lib/api';

import { exclusiveEndToInclusiveDay, instantToDay, rangeToQuery } from './range';
import type { LoadCtx } from './section';

export type WindowDays = { from: string; to: string; timezone?: string };

/**
 * Inclusive first/last tenant-local day the report range covers.
 *
 * A custom or month range already names its days. A preset is resolved by
 * asking an endpoint that understands presets (the dashboard) and reading the
 * window it echoes back — its `from`/`to` are tenant-local midnights serialized
 * as UTC instants, with `to` exclusive.
 */
export async function resolveWindowDays(ctx: LoadCtx): Promise<WindowDays> {
  const q = rangeToQuery(ctx.range);
  if (q.from && q.to) return { from: q.from, to: q.to };

  const echo = await request<{ from: string; to: string; timezone: string }>(
    'GET',
    `/v1/reports/dashboard?range=${encodeURIComponent(q.range)}`,
    { tenantSlug: ctx.slug },
  );
  const from = instantToDay(echo.from, echo.timezone);
  const to = exclusiveEndToInclusiveDay(echo.to, echo.timezone);
  // If the echo is unusable, fail loudly rather than fall back to "no filter" —
  // an unfiltered all-time table under a "June" heading is worse than an error,
  // because nothing on the page says it is wrong.
  if (!from || !to) {
    throw new Error(`could not resolve the reporting period for range "${q.range}"`);
  }
  return { from, to, timezone: echo.timezone };
}
