/**
 * Themed pressable button with the app's standard spring press feedback (via
 * PressableScale / the motion layer) and a haptic tap. Variants: primary
 * (brand fill), secondary (outlined), ghost (text only).
 */
import { ActivityIndicator, type PressableProps } from 'react-native';
import { useTheme } from '../../theme';
import { AppText } from './Text';
import { PressableScale } from './PressableScale';

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
        ? theme.colors.stamp.brand.fg
        : theme.colors.text;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      pressedScale={0.98}
      onPress={onPress}
      style={{
        backgroundColor: bg,
        borderColor,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderRadius: theme.radii.md,
        paddingVertical: theme.spacing[4],
        paddingHorizontal: theme.spacing[5],
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 52,
        ...(variant === 'primary' ? theme.elevation.card : null),
      }}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <AppText style={{ color: fg, fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>
          {title}
        </AppText>
      )}
    </PressableScale>
  );
}
