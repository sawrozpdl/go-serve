/**
 * Themed Text primitives. `AppText` for body/UI copy (weight via loaded Inter
 * families, since RN doesn't synthesize weight for custom fonts), `Heading` for
 * display text (honors the tenant's typography preset — italic serif / uppercase
 * / clean sans).
 */
import { Text, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../../theme';

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

export function Heading({ style, ...props }: TextProps) {
  const theme = useTheme();
  const t = theme.typography;
  const base: TextStyle = {
    color: theme.colors.text,
    fontFamily: t.displayFamily,
    textTransform: t.headingTransform,
    letterSpacing: t.headingTracking,
    fontSize: 28,
  };
  return <Text style={[base, style]} {...props} />;
}
