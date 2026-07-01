/**
 * Themed pressable button with a subtle press-scale + haptic tap. Variants:
 * primary (brand fill), secondary (outlined), ghost (text only). Uses
 * Pressable's pressed state for the press feedback (no animation lib) so it
 * stays instant and trivially testable.
 */
import { Pressable, ActivityIndicator, type PressableProps, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../theme';
import { AppText } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  title: string;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
};

export function Button({
  title,
  variant = 'primary',
  loading = false,
  disabled = false,
  onPress,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const bg = variant === 'primary' ? theme.colors.primary : 'transparent';
  const borderColor = variant === 'secondary' ? theme.colors.border : 'transparent';
  const fg =
    variant === 'primary'
      ? theme.colors.onBrand
      : variant === 'ghost'
        ? theme.colors.primary
        : theme.colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={(e) => {
        void Haptics.selectionAsync();
        onPress?.(e);
      }}
      style={({ pressed }): ViewStyle => ({
        backgroundColor: bg,
        borderColor,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderRadius: theme.radii.md,
        paddingVertical: theme.spacing[4],
        paddingHorizontal: theme.spacing[5],
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 52,
        opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        transform: [{ scale: pressed && !isDisabled ? 0.98 : 1 }],
      })}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <AppText style={{ color: fg, fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>
          {title}
        </AppText>
      )}
    </Pressable>
  );
}
