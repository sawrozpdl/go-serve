/**
 * Perforation — the tear line between a docket's items and its totals. A
 * dashed rule with two half-circle notches punched into the card edges (the
 * parent card needs `overflow: 'hidden'` so the notches clip to half-moons).
 */
import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { useTheme } from '../../theme';

const NOTCH = 16;

export function Perforation({ spacing }: { spacing?: number }) {
  const theme = useTheme();
  const notchStyle = {
    position: 'absolute' as const,
    top: -NOTCH / 2 + 1,
    width: NOTCH,
    height: NOTCH,
    borderRadius: NOTCH / 2,
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  };

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ marginVertical: spacing ?? theme.spacing[3], height: 2 }}
    >
      <Svg height={2} width="100%">
        <Line
          x1="0"
          y1="1"
          x2="100%"
          y2="1"
          stroke={theme.colors.border}
          strokeWidth={2}
          strokeDasharray="6, 5"
        />
      </Svg>
      <View style={[notchStyle, { left: -NOTCH / 2 }]} />
      <View style={[notchStyle, { right: -NOTCH / 2 }]} />
    </View>
  );
}
