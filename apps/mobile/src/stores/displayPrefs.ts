/**
 * Per-device display preferences (MMKV). The floor-menu scale is a property of
 * THIS device — a wall tablet wants big touch targets, a phone wants dense — so
 * like kitchenPrefs it lives on the device, not in the tenant record. Mirrors
 * the web `cafe.uiScale` localStorage setting.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from '../lib/zustandStorage';

export type PosScale = 'compact' | 'comfortable' | 'large';

// Kept in sync with web's uiScale factors.
const FACTORS: Record<PosScale, number> = {
  compact: 0.9,
  comfortable: 1,
  large: 1.18,
};

export const POS_SCALES: { value: PosScale; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'large', label: 'Large' },
];

export function posScaleFactor(scale: PosScale): number {
  return FACTORS[scale];
}

type DisplayPrefsState = {
  posScale: PosScale;
  setPosScale: (scale: PosScale) => void;
};

export const useDisplayPrefs = create<DisplayPrefsState>()(
  persist(
    (set) => ({
      posScale: 'comfortable',
      setPosScale: (posScale) => set({ posScale }),
    }),
    { name: 'goserve-display-prefs', storage: createJSONStorage(() => mmkvStorage) },
  ),
);
