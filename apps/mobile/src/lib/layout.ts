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

/**
 * The widest a column of prose or form fields should ever get.
 *
 * A phone list stretched across a 1200dp tablet is not "responsive", it is
 * unreadable: the eye loses the line, and a label on the far left with its
 * value on the far right stops reading as one row. 720dp is about 90
 * characters at this type size — past that, more width costs comprehension
 * rather than buying it.
 *
 * Returns the FULL width on a phone so nothing changes there, and never
 * exceeds the space available.
 */
export function readableWidthFor(width: number, max = 720): number {
  if (width <= 0) return max;
  return Math.min(width, max);
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
  /** Cap for a single column of prose/forms. Equals `width` on a phone. */
  readableWidth: number;
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
    readableWidth: readableWidthFor(width),
  };
}

/** Style for a scroll container that should stay readable on a tablet:
 *  centred, and never wider than `readableWidth`. */
export function readableContent(layout: Layout): { maxWidth: number; width: '100%'; alignSelf: 'center' } {
  return { maxWidth: layout.readableWidth, width: '100%', alignSelf: 'center' };
}
