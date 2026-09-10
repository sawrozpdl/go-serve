/**
 * Grid — fixed-column tile grid with real gap math (replaces the hardcoded
 * `width: '48%'` two-column layouts). Measures its own width and hands each
 * child an exact pixel width, so columns stay true at any screen size.
 * Pair with `useLayout().columns(...)` for responsive counts.
 */
import { useState, Children, type ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';

export type GridProps = {
  columns: number;
  gap?: number;
  children: ReactNode;
  testID?: string;
};

export function Grid({ columns, gap, children, testID }: GridProps) {
  const theme = useTheme();
  const g = gap ?? theme.spacing[2] + 2;
  const [width, setWidth] = useState(0);
  const cols = Math.max(1, columns);
  // Floor the item width: a fractional width that sums exactly to the container
  // (items + columnGaps) rounds up per-item on the pixel grid and overflows the
  // last item onto its own row, collapsing the grid to a single column. Rounding
  // down keeps every row's items within the measured width.
  const itemWidth = width > 0 ? Math.floor((width - g * (cols - 1)) / cols) : 0;

  return (
    <View
      testID={testID}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: g, rowGap: g }}
    >
      {/* Before the first onLayout the width is unknown, so items fall back to
          full width — a single column, which is the final layout on a phone
          anyway. Rendering nothing instead (as this did) costs a blank frame
          on every mount, and leaves the grid PERMANENTLY empty anywhere
          onLayout never fires: a detached view, or a test renderer. */}
      {Children.map(children, (child) =>
        child == null ? null : (
          <View style={width > 0 ? { width: itemWidth } : { width: '100%' }}>{child}</View>
        ),
      )}
    </View>
  );
}
