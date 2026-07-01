/**
 * Bridges NetInfo into the connectivity store. NetInfo gives a better signal
 * than the browser's navigator.onLine — it can tell "connected to Wi-Fi but no
 * internet" apart from truly online — so we treat `isInternetReachable === false`
 * as offline. The realtime layer (useRealtime) owns the ws↔polling distinction;
 * this only flips offline ↔ online.
 */
import { useEffect } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { markOffline, markOnline } from '../stores/connectivity';

export function useConnectivityWatcher() {
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const reachable = !!state.isConnected && state.isInternetReachable !== false;
      if (reachable) markOnline();
      else markOffline();
    });
    return () => unsub();
  }, []);
}
