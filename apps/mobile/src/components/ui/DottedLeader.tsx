/**
 * Dotted leader — the "Cappuccino ·········· 480" line from printed menus and
 * receipts, as a flexible spacer between a label and its value. Drawn with SVG
 * (RN's dotted borderStyle is unreliable edge-to-edge on Android).
 */
import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { useTheme } from '../../theme';

export function DottedLeader({ color, height = 2 }: { color?: string; height?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ flex: 1, minWidth: theme.spacing[4], justifyContent: 'center' }}
    >
      <Svg height={height} width="100%">
        <Line
          x1="1"
          y1={height / 2}
          x2="100%"
          y2={height / 2}
          stroke={color ?? theme.colors.textFaint}
          strokeWidth={height}
          strokeDasharray="0.1, 5"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}
