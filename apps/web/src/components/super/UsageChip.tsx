/* The usage verdict, rendered so it always explains itself.
 *
 * A colour on its own tells you something is wrong but not what, and sends the
 * reader digging. Every chip therefore carries a title listing the signals that
 * actually fired, in the server's own words ("3 of 5 trading days had no shift
 * close") — the same sentences the Usage tab shows in full.
 */

import { USAGE_STATUS_LABEL, USAGE_STATUS_PILL, type TenantUsage } from '@cafe-mgmt/api-types';

export function UsageChip({ usage }: { usage?: TenantUsage }) {
  if (!usage) return <span className="muted">—</span>;

  const fired = usage.signals.filter((s) => s.grade === 'warn' || s.grade === 'bad');
  const title =
    usage.status === 'dormant'
      ? 'No orders at all in the last two weeks.'
      : usage.status === 'onboarding'
        ? 'Too new to grade — still being set up.'
        : fired.length
          ? fired.map((s) => s.detail).join('\n')
          : 'Trading steadily, shifts closed off, team signing in.';

  return (
    <span className={`pill ${USAGE_STATUS_PILL[usage.status] || 'bad'} usage-chip usage-${usage.status}`} title={title}>
      {USAGE_STATUS_LABEL[usage.status]}
    </span>
  );
}

/** A bare 14-bar sparkline of daily order counts. Reuses the dashboard's
 *  `.chart` CSS rather than adding a charting dependency — the app has none. */
export function OrderSparkline({ points }: { points: { day: string; orders: number }[] }) {
  if (points.length === 0) return null;
  const peak = Math.max(1, ...points.map((p) => p.orders));
  return (
    <span className="usage-spark" aria-hidden>
      {points.map((p) => (
        <span
          key={p.day}
          className={p.orders === 0 ? 'usage-spark__bar is-zero' : 'usage-spark__bar'}
          style={{ height: `${Math.max(8, Math.round((p.orders / peak) * 100))}%` }}
        />
      ))}
    </span>
  );
}
