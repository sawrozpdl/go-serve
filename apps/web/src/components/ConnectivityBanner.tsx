/* ConnectivityPill
 *
 * Tells the cashier how live the data on screen is — without ever moving the
 * page. Fixed to the bottom-left corner (toasts own bottom-right, the SW
 * update bar owns bottom-center), so it can't shift content or cover a
 * sticky action bar's buttons.
 *
 * - 'ws' (healthy realtime): renders nothing.
 * - 'polling': silent for a 10s grace window — the store boots in 'polling'
 *   before the first socket open, and WS reconnect blips pass through it, so
 *   showing instantly would just flash noise. After grace: a collapsed amber
 *   icon; hover/tap expands the explanation.
 * - 'offline': red pill, expanded immediately with the last-sync age, then
 *   auto-collapses to an icon so it stays out of the way on a busy floor.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';

import { useConnectivity } from '@/lib/connectivity';

const POLLING_GRACE_MS = 10_000;
const AUTO_COLLAPSE_MS = 5_000;

export function ConnectivityPill() {
  const { mode, lastSyncedAt } = useConnectivity();
  const [graceOver, setGraceOver] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapseTimer = useRef<number | null>(null);

  const scheduleCollapse = useCallback(() => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = window.setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
  }, []);
  const holdOpen = useCallback(() => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    setExpanded(true);
  }, []);

  // Re-render every 30s while degraded so the "saved data from Xm ago" age ticks.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (mode === 'ws') return;
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [mode]);

  useEffect(() => {
    setGraceOver(false);
    if (mode === 'polling') {
      setExpanded(false);
      const t = window.setTimeout(() => setGraceOver(true), POLLING_GRACE_MS);
      return () => window.clearTimeout(t);
    }
    if (mode === 'offline') {
      // Lead with the full message, then tuck away to an icon.
      setExpanded(true);
      scheduleCollapse();
    } else {
      setExpanded(false);
    }
    return undefined;
  }, [mode, scheduleCollapse]);

  useEffect(
    () => () => {
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    },
    [],
  );

  if (mode === 'ws') return null;
  if (mode === 'polling' && !graceOver) return null;

  const offline = mode === 'offline';
  return (
    <div className="conn-float">
      <button
        type="button"
        className={[
          'conn-float__pill',
          offline ? 'conn-float__pill--offline' : 'conn-float__pill--polling',
          expanded ? '' : 'conn-float__pill--collapsed',
        ]
          .filter(Boolean)
          .join(' ')}
        role={offline ? 'alert' : 'status'}
        aria-label={offline ? 'Offline' : 'Live updates degraded'}
        onPointerEnter={holdOpen}
        onPointerLeave={scheduleCollapse}
        onFocus={holdOpen}
        onBlur={scheduleCollapse}
        onClick={() => {
          // Tap-to-toggle for tablets (no hover there).
          if (expanded) setExpanded(false);
          else {
            holdOpen();
            scheduleCollapse();
          }
        }}
      >
        {offline ? (
          <CloudOff size={13} strokeWidth={1.7} aria-hidden="true" />
        ) : (
          <RefreshCw size={12} strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className="conn-float__label">
          {offline ? (
            <>
              Offline — saved data{lastSyncedAt ? ` from ${relAge(lastSyncedAt)}` : ''} · syncs on
              reconnect
            </>
          ) : (
            <>Live updates degraded — refreshing every few seconds</>
          )}
        </span>
      </button>
    </div>
  );
}

function relAge(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return 'moments ago';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}
