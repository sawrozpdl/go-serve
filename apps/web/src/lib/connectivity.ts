/* Connectivity store.
 *
 * One source of truth for "how live is the data on screen":
 *   'ws'      — realtime socket open, pushes arrive instantly
 *   'polling' — socket unreachable, HTTP polling every 5s (degraded)
 *   'offline' — REST requests are failing at the network layer
 *
 * Fed from three places:
 *   - ws.ts flips ws/polling as the socket opens/falls back
 *   - api.ts marks 'offline' when a fetch throws (TypeError = no network)
 *     and bumps back up on any successful response
 *   - the browser online/offline events give a fast first hint
 */

import { create } from 'zustand';

export type ConnectivityMode = 'ws' | 'polling' | 'offline';

type State = {
  mode: ConnectivityMode;
  /** Epoch ms of the last successful API response — drives "updated Xm ago". */
  lastSyncedAt: number | null;
};

const useConnectivityStore = create<State>(() => ({
  mode: 'polling',
  lastSyncedAt: null,
}));

export function useConnectivity(): State {
  return useConnectivityStore();
}

/** Imperative setters — callable from non-React modules (api.ts, ws.ts). */
export function setConnectivityMode(mode: ConnectivityMode) {
  if (useConnectivityStore.getState().mode !== mode) {
    useConnectivityStore.setState({ mode });
  }
}

export function markSynced() {
  const s = useConnectivityStore.getState();
  // A successful response while flagged offline means the network is back;
  // report 'polling' until the websocket re-opens and upgrades us to 'ws'.
  useConnectivityStore.setState({
    lastSyncedAt: Date.now(),
    mode: s.mode === 'offline' ? 'polling' : s.mode,
  });
}

export function markOffline() {
  setConnectivityMode('offline');
}

export function isOffline(): boolean {
  return useConnectivityStore.getState().mode === 'offline';
}

// Browser-level hints. 'offline' is trustworthy (no interface up); 'online'
// only means an interface exists — the next real request confirms it.
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => markOffline());
  window.addEventListener('online', () => {
    if (useConnectivityStore.getState().mode === 'offline') {
      setConnectivityMode('polling');
    }
  });
}
