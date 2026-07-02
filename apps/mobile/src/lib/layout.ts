/**
 * Responsive layout — one breakpoint model for the whole app.
 *
 * Kills the hardcoded `width: '48%'` two-column grids: components ask
 * `useLayout()` for column counts / split-view instead of assuming a phone.
 * The pure helpers are exported separately so they unit-test without
 * rendering.
 */
import { useWindowDimensions } from 'react-native';

export type Breakpoint = 'compact' | 'medium' | 'expanded';

/** Material-style width classes: <600dp phones, 600–899 small tablets /
 * landscape phones, ≥900 full tablets. */
export function breakpointFor(width: number): Breakpoint {
  if (width >= 900) return 'expanded';
  if (width >= 600) return 'medium';
  return 'compact';
}

/** Columns that fit `width` at a target tile width, clamped to [min, max]. */
export function gridColumns(
  width: number,
  targetTileWidth: number,
  min: number = 1,
  max: number = 6,
): number {
  if (width <= 0 || targetTileWidth <= 0) return min;
  const fit = Math.floor(width / targetTileWidth);
  return Math.min(max, Math.max(min, fit));
}

/** Whether the order screen should render the persistent side-by-side POS
 * (menu grid + ticket panel) instead of the phone sheet composition. */
export function splitViewFor(bp: Breakpoint, isLandscape: boolean): boolean {
  return bp === 'expanded' || (bp === 'medium' && isLandscape);
}

export type Layout = {
  width: number;
  height: number;
  bp: Breakpoint;
  isTablet: boolean;
  isLandscape: boolean;
  /** Columns for a tile grid at a target tile width, clamped to [min, max]. */
  columns: (targetTileWidth: number, min?: number, max?: number) => number;
  /** True when the POS should show menu + ticket side by side. */
  splitView: boolean;
};

export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const bp = breakpointFor(width);
  const isLandscape = width > height;
  return {
    width,
    height,
    bp,
    isTablet: bp !== 'compact',
    isLandscape,
    columns: (targetTileWidth, min, max) => gridColumns(width, targetTileWidth, min, max),
    splitView: splitViewFor(bp, isLandscape),
  };
}
