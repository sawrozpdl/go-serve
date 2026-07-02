/**
 * Skeleton — shimmer loading placeholder (replaces bare spinners / "Loading…"
 * text). Colors are opaque theme.skeleton fills; the shimmer is a gentle
 * base→highlight pulse from the motion layer, static under reduced motion.
 */
import { View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';
import { useTheme } from '../../theme';
import { useShimmer } from '../../theme/motion';

export type SkeletonProps = {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

export function Skeleton({ width = '100%', height = 16, radius, style }: SkeletonProps) {
  const theme = useTheme();
  const progress = useShimmer();

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [theme.skeleton.base, theme.skeleton.highlight],
    ),
  }));

  return (
    <Animated.View
      accessibilityLabel="loading"
      style={[
        { width, height, borderRadius: radius ?? theme.radii.sm, backgroundColor: theme.skeleton.base },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** Card-shaped placeholder: a title bar + `lines` copy bars inside a quiet
 * card. Drop-in for loading tiles/tickets/KPIs. */
function SkeletonCard({ lines = 2, style }: { lines?: number; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel="loading"
      style={[
        {
          backgroundColor: theme.colors.surfaces[2],
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radii.lg,
          padding: theme.spacing[3],
          gap: theme.spacing[2] + 2,
        },
        style,
      ]}
    >
      <Skeleton width="45%" height={12} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '85%'} height={10} />
      ))}
    </View>
  );
}

Skeleton.Card = SkeletonCard;
