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
      {width > 0
        ? Children.map(children, (child) =>
            child == null ? null : <View style={{ width: itemWidth }}>{child}</View>,
          )
        : null}
    </View>
  );
}
