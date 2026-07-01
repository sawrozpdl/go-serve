/**
 * Connectivity mode, mirroring web's `lib/connectivity.ts`. Fed by NetInfo +
 * the WS/poll layer (M2) and by the fetch layer marking offline/synced. Money
 * operations are disabled while `offline`.
 */
import { create } from 'zustand';

export type ConnectivityMode = 'online' | 'ws' | 'polling' | 'offline';

type ConnectivityState = {
  mode: ConnectivityMode;
  setMode: (mode: ConnectivityMode) => void;
  markOffline: () => void;
  markOnline: () => void;
};

export const useConnectivity = create<ConnectivityState>((set, get) => ({
  mode: 'online',
  setMode: (mode) => set({ mode }),
  markOffline: () => {
    if (get().mode !== 'offline') set({ mode: 'offline' });
  },
  markOnline: () => {
    if (get().mode === 'offline') set({ mode: 'online' });
  },
}));

// Non-React accessors for the fetch/realtime layers (outside the component tree).
export const markOffline = (): void => useConnectivity.getState().markOffline();
export const markOnline = (): void => useConnectivity.getState().markOnline();
export const isOffline = (): boolean => useConnectivity.getState().mode === 'offline';
/** Set the transport mode from the realtime layer (ws ↔ polling). Never
 * overwrites 'offline' — the fetch layer owns that and upgrades on success. */
export const setConnectivityMode = (mode: ConnectivityMode): void => {
  const s = useConnectivity.getState();
  if (s.mode === 'offline' && mode !== 'offline') return;
  s.setMode(mode);
};
