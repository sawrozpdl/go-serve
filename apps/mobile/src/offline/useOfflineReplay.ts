/**
 * Mount once in the app shell. Drains the offline queue when connectivity
 * returns (connectivity store mode leaves 'offline'), once on startup (a
 * restart while online may have left persisted ops), and on a 30s sweep (which
 * also covers a WS foreground reconnect and the case where the server came back
 * without any connectivity transition firing).
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConnectivity } from '../stores/connectivity';
import { getQueuedOps, replayableOps } from './queue';
import { replayQueuedOps } from './replay';

export function useOfflineReplay(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const drainIfWork = () => {
      if (useConnectivity.getState().mode !== 'offline' && replayableOps(getQueuedOps()).length > 0) {
        void replayQueuedOps(qc);
      }
    };

    drainIfWork(); // startup

    const sweep = setInterval(drainIfWork, 30_000);
    const unsub = useConnectivity.subscribe((s, prev) => {
      if (prev.mode === 'offline' && s.mode !== 'offline') void replayQueuedOps(qc);
    });

    return () => {
      clearInterval(sweep);
      unsub();
    };
  }, [qc]);
}
