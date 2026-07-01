/**
 * The house signature: a soft amber glow rising from the top with a faint lime
 * wash at the bottom — "warm morning roast" light over the near-black base.
 * Purely decorative; sits behind content and ignores touches.
 */
import { StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { useTheme } from '../../theme';

export function AmbientGlow() {
  const theme = useTheme();
  const strong = theme.scheme === 'dark' ? 0.18 : 0.24;
  const faint = theme.scheme === 'dark' ? 0.08 : 0.12;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="glow-amber" cx="24%" cy="-6%" rx="90%" ry="55%">
          <Stop offset="0" stopColor={theme.colors.primary} stopOpacity={strong} />
          <Stop offset="1" stopColor={theme.colors.primary} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="glow-accent" cx="100%" cy="102%" rx="80%" ry="50%">
          <Stop offset="0" stopColor={theme.colors.accent} stopOpacity={faint} />
          <Stop offset="1" stopColor={theme.colors.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow-amber)" />
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow-accent)" />
    </Svg>
  );
}
