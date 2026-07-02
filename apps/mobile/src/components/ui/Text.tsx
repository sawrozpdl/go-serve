/**
 * Themed Text primitives. `AppText` for body/UI copy (weight via loaded Inter
 * families, since RN doesn't synthesize weight for custom fonts), `Heading` for
 * display text (honors the tenant's typography preset — italic serif / uppercase
 * / clean sans), `MonoText` for the Docket voice: prices, quantities, timers,
 * table numbers — always tabular so columns of digits line up.
 */
import { Text, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../../theme';
import type { Theme } from '../../theme/buildTheme';

type Variant = 'body' | 'muted' | 'faint' | 'label';

export function AppText({
  variant = 'body',
  style,
  ...props
}: TextProps & { variant?: Variant }) {
  const theme = useTheme();
  const color =
    variant === 'muted'
      ? theme.colors.textMuted
      : variant === 'faint'
        ? theme.colors.textFaint
        : theme.colors.text;
  const base: TextStyle = {
    color,
    fontFamily: variant === 'label' ? theme.fonts.bodySemi : theme.fonts.body,
    fontSize: variant === 'label' ? theme.text.sm : theme.text.lg,
    ...(variant === 'label' ? { letterSpacing: 0.4, textTransform: 'uppercase' } : null),
  };
  return <Text style={[base, style]} {...props} />;
}

export function Heading({
  size,
  style,
  ...props
}: TextProps & { size?: keyof Theme['typeStyles'] }) {
  const theme = useTheme();
  const t = theme.typography;
  const ts = theme.typeStyles[size ?? '4xl'];
  const base: TextStyle = {
    color: theme.colors.text,
    fontFamily: t.displayFamily,
    textTransform: t.headingTransform,
    letterSpacing: t.headingTracking,
    fontSize: ts.size,
    // Paired line-height only when a ramp size is chosen explicitly —
    // legacy call sites still override fontSize via style and would clash.
    ...(size ? { lineHeight: ts.lineHeight } : null),
  };
  return <Text style={[base, style]} {...props} />;
}

/** Tabular mono text — every price, qty, timer and table number. */
export function MonoText({
  size = 'md',
  weight = 'medium',
  muted = false,
  style,
  ...props
}: TextProps & {
  size?: keyof Theme['typeStyles'];
  weight?: 'regular' | 'medium' | 'bold';
  muted?: boolean;
}) {
  const theme = useTheme();
  const ts = theme.typeStyles[size];
  const family =
    weight === 'bold'
      ? theme.fonts.monoBold
      : weight === 'regular'
        ? theme.fonts.mono
        : theme.fonts.monoMedium;
  const base: TextStyle = {
    color: muted ? theme.colors.textMuted : theme.colors.text,
    fontFamily: family,
    fontSize: ts.size,
    lineHeight: ts.lineHeight,
    fontVariant: ['tabular-nums'],
  };
  return <Text style={[base, style]} {...props} />;
}
