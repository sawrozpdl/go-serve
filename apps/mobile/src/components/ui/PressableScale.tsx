/**
 * Pressable with the app's standard spring-feel press feedback (scale via the
 * motion layer) and an optional haptic tap. Replaces the per-component
 * `pressed ? 0.98 : 1` ternaries so every touchable compresses the same way.
 * Visual styles go on `style` (the animated inner view); the outer Pressable
 * stays unstyled apart from hit-area props.
 */
import type { ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { usePressScale } from '../../theme/motion';
import { haptics } from '../../lib/haptics';

export type PressableScaleProps = Omit<PressableProps, 'style' | 'children'> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Scale when pressed (default 0.97). */
  pressedScale?: number;
  /** Fire a selection haptic on press (default true). */
  haptic?: boolean;
};

export function PressableScale({
  children,
  style,
  pressedScale = 0.97,
  haptic = true,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const { animatedStyle, onPressIn: scaleIn, onPressOut: scaleOut } = usePressScale(pressedScale);

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={(e) => {
        if (haptic) haptics.selection();
        onPress?.(e);
      }}
      onPressIn={(e) => {
        scaleIn();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scaleOut();
        onPressOut?.(e);
      }}
      {...rest}
    >
      <Animated.View style={[animatedStyle, disabled ? { opacity: 0.5 } : null, style]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
