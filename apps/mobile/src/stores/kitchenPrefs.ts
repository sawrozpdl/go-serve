/**
 * Per-device kitchen-display preferences, persisted to MMKV. The alert setting
 * is a property of THIS till (the one mounted in the kitchen), not the tenant —
 * a waiter's phone and the kitchen screen want different behaviour. `alertsOn`
 * gates the new-ticket haptic buzz. (Audible chime needs a native audio module
 * → dev-client rebuild; tracked as a follow-up. Haptics need no rebuild.)
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from '../lib/zustandStorage';

type KitchenPrefsState = {
  alertsOn: boolean;
  setAlertsOn: (on: boolean) => void;
  /** Which outlet's board this till shows: 'all' or an outlet id. Persisted so
   *  the bar tablet stays on the Bar board across restarts. */
  kdsOutlet: string;
  setKdsOutlet: (id: string) => void;
};

export const useKitchenPrefs = create<KitchenPrefsState>()(
  persist(
    (set) => ({
      alertsOn: true,
      setAlertsOn: (alertsOn) => set({ alertsOn }),
      kdsOutlet: 'all',
      setKdsOutlet: (kdsOutlet) => set({ kdsOutlet }),
    }),
    { name: 'goserve-kitchen-prefs', storage: createJSONStorage(() => mmkvStorage) },
  ),
);
