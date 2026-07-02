/**
 * ListRow — settings/detail row: title + optional subtitle, leading icon,
 * trailing value (mono) and/or chevron. Replaces the per-screen `Row`
 * implementations and the literal `›` glyph (Lucide ChevronRight instead).
 */
import type { ReactNode } from 'react';
import { View, Text } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '../../theme';
import { PressableScale } from './PressableScale';
import { AppText } from './Text';

export type ListRowProps = {
  title: string;
  subtitle?: string;
  /** Leading element (AppIcon, avatar…). */
  left?: ReactNode;
  /** Trailing text value, rendered in tabular mono (amounts, counts). */
  value?: string;
  /** Custom trailing element (Stamp, Switch…); renders after `value`. */
  right?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
};

export function ListRow({
  title,
  subtitle,
  left,
  value,
  right,
  chevron = false,
  onPress,
  disabled,
  destructive = false,
  testID,
}: ListRowProps) {
  const theme = useTheme();

  const content = (
    <>
      {left ? <View style={{ width: 28, alignItems: 'center' }}>{left}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          style={{
            fontFamily: theme.fonts.bodyMedium,
            ...(destructive ? { color: theme.colors.dangerFg } : null),
          }}
          numberOfLines={1}
        >
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="muted" style={{ fontSize: theme.text.sm, marginTop: 1 }} numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {value ? (
        <Text
          style={{
            color: theme.colors.text,
            fontFamily: theme.fonts.monoMedium,
            fontSize: theme.text.md,
            fontVariant: ['tabular-nums'],
          }}
        >
          {value}
        </Text>
      ) : null}
      {right}
      {chevron ? <ChevronRight size={18} color={theme.colors.textFaint} /> : null}
    </>
  );

  const rowStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3] + 2,
    paddingHorizontal: theme.spacing[4],
    minHeight: theme.touch.comfortable,
  };

  if (onPress) {
    return (
      <PressableScale
        onPress={onPress}
        disabled={disabled}
        pressedScale={0.99}
        accessibilityLabel={title}
        testID={testID}
        style={rowStyle}
      >
        {content}
      </PressableScale>
    );
  }
  return (
    <View accessibilityLabel={title} testID={testID} style={rowStyle}>
      {content}
    </View>
  );
}
