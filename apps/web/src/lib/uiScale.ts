// Per-device POS display scale.
//
// Icon/font sizing on the floor-menu is a display choice that differs per
// physical device — a wall-mounted kitchen tablet wants big touch targets, a
// phone wants dense. So (like the print device-role) this lives in localStorage
// per browser, NOT in tenant preferences. It drives a single `--pos-scale` CSS
// variable the floor-menu CSS multiplies into its sizes, plus the icon pixel
// props that can't live in CSS.
import { useEffect, useState } from 'react';

export type PosScale = 'compact' | 'comfortable' | 'large';

const KEY = 'cafe.uiScale';
const EVENT = 'cafe:uiScale';

// 'comfortable' is the (bigger, pleasing) default; the others step down/up from
// it. Kept modest so text never overflows the cards.
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

function normalize(v: string | null): PosScale {
  return v === 'compact' || v === 'large' ? v : 'comfortable';
}

export function getPosScale(): PosScale {
  try {
    return normalize(localStorage.getItem(KEY));
  } catch {
    return 'comfortable';
  }
}

export function setPosScale(scale: PosScale): void {
  try {
    localStorage.setItem(KEY, scale);
    // Notify same-tab listeners (the storage event only fires cross-tab).
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // private mode / storage disabled — the default scale just stays in effect
  }
}

export function posScaleFactor(scale: PosScale): number {
  return FACTORS[scale];
}

/** Live per-device scale — re-renders when changed here, in another tab, or
 *  from the Settings screen. */
export function usePosScale(): { scale: PosScale; factor: number } {
  const [scale, setScale] = useState<PosScale>(getPosScale);
  useEffect(() => {
    const sync = () => setScale(getPosScale());
    window.addEventListener('storage', sync);
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);
  return { scale, factor: posScaleFactor(scale) };
}
