/* ConnectivityBanner
 *
 * Tells the cashier how live the data on screen is. Silent when the realtime
 * socket is healthy ('ws'); a subtle pill when degraded to HTTP polling; a
 * persistent banner with the last-sync age when truly offline.
 */

import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';

import { useConnectivity } from '@/lib/connectivity';

export function ConnectivityBanner() {
  const { mode, lastSyncedAt } = useConnectivity();
  // Re-render every 30s while degraded so the "updated Xm ago" stamp ticks.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (mode === 'ws') return;
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [mode]);

  if (mode === 'ws') return null;

  if (mode === 'polling') {
    return (
      <div className="conn-pill" role="status">
        <RefreshCw size={11} strokeWidth={1.8} aria-hidden="true" />
        Live updates degraded — refreshing every few seconds
      </div>
    );
  }

  return (
    <div className="conn-banner" role="alert">
      <CloudOff size={14} strokeWidth={1.7} aria-hidden="true" />
      <span>
        <strong>Offline</strong> — showing saved data{lastSyncedAt ? ` from ${relAge(lastSyncedAt)}` : ''}.
        Changes will sync when you're back online.
      </span>
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
