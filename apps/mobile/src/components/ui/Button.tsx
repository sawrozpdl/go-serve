/**
 * Themed pressable button with the app's standard spring press feedback (via
 * PressableScale / the motion layer) and a haptic tap. Variants: primary
 * (brand fill), secondary (outlined), ghost (text only), danger (red fill for
 * destructive confirms).
 */
import { ActivityIndicator, View, type PressableProps } from 'react-native';
import type { ReactNode } from 'react';
import { useTheme, shadow } from '../../theme';
import { AppText } from './Text';
import { PressableScale } from './PressableScale';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  title: string;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  /** Optional leading icon. Set its color to match the variant's text. */
  icon?: ReactNode;
};

export function Button({
  title,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  onPress,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const bg =
    variant === 'primary'
      ? theme.colors.primary
      : variant === 'danger'
        ? theme.colors.dangerFg
        : 'transparent';
  const borderColor = variant === 'secondary' ? theme.colors.border : 'transparent';
  const fg =
    variant === 'primary'
      ? theme.colors.onBrand
      : variant === 'danger'
        ? '#fff'
        : variant === 'ghost'
          ? theme.colors.stamp.brand.fg
          : theme.colors.text;
  const filled = variant === 'primary' || variant === 'danger';
  const labelStyle = {
    color: fg,
    fontFamily: theme.fonts.bodySemi,
    fontSize: theme.text.lg,
    flexShrink: 1,
    minWidth: 0,
  };

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
        ...(filled ? shadow(theme.elevation.card) : null),
      }}
      {...rest}
    >
      {/* One line, shrink before wrapping. Three buttons in the ticket action bar
          leave ~36dp for a label after padding and icon, so "Send 3" and "Settle"
          both wrapped and grew past minHeight; "Collect Rs 1,00,00,000 to close"
          did the same on the settle sheet. */}
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : icon ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing[2],
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {icon}
          <AppText style={labelStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
            {title}
          </AppText>
        </View>
      ) : (
        <AppText style={labelStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
          {title}
        </AppText>
      )}
    </PressableScale>
  );
}
