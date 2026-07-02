/**
 * Per-device haptics preference, persisted to MMKV. Vibration feedback is a
 * property of THIS device (some staff find it distracting), not the tenant.
 * Defaults OFF — enable it per device in More → Appearance. Read non-reactively
 * via `useHapticsPrefs.getState().enabled` inside the central gate (src/lib/haptics.ts).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from '../lib/zustandStorage';

type HapticsPrefsState = {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
};

export const useHapticsPrefs = create<HapticsPrefsState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    { name: 'goserve-haptics', storage: createJSONStorage(() => mmkvStorage) },
  ),
);
