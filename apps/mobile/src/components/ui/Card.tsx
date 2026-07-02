/**
 * Card — the one elevated-surface implementation (paper on the Docket ground).
 * Replaces the per-screen card styles in floor/kitchen/dashboard. `selected`
 * uses the OPAQUE primaryTint (Android elevation artifact — see buildTheme).
 * Pass `onPress` to make it a PressableScale with haptic + spring feedback.
 */
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { PressableScale, type PressableScaleProps } from './PressableScale';

export type CardProps = {
  children: ReactNode;
  /** Surface level: 2 = card (default), 3 = overlay/elevated. */
  level?: 2 | 3;
  selected?: boolean;
  /** Cast a shadow (default true). Flat cards keep the hairline only. */
  elevated?: boolean;
  /** Apply standard inner padding (default true). */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  onPress?: PressableScaleProps['onPress'];
  onLongPress?: PressableScaleProps['onLongPress'];
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
};

export function Card({
  children,
  level = 2,
  selected = false,
  elevated = true,
  padded = true,
  style,
  onPress,
  onLongPress,
  disabled,
  accessibilityLabel,
  testID,
}: CardProps) {
  const theme = useTheme();

  const base: ViewStyle = {
    backgroundColor: selected ? theme.colors.primaryTint : theme.colors.surfaces[level],
    borderColor: selected ? theme.colors.primary : theme.colors.border,
    borderWidth: selected ? 1.5 : 1,
    borderRadius: theme.radii.lg,
    ...(padded ? { padding: theme.spacing[3] } : null),
    ...(elevated ? theme.elevation.card : null),
  };

  if (onPress || onLongPress) {
    return (
      <PressableScale
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={selected ? { selected: true } : undefined}
        testID={testID}
        style={[base, style]}
      >
        {children}
      </PressableScale>
    );
  }

  return (
    <View accessibilityLabel={accessibilityLabel} testID={testID} style={[base, style]}>
      {children}
    </View>
  );
}
