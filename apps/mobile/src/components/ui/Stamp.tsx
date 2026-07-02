/**
 * Stamp — status as a rubber stamp: uppercase letterspaced mono in a bordered,
 * tinted chip ([ SENT ] [ READY ] [ PAID ]). The Docket replacement for every
 * ad-hoc `hexToRgba(color, 0.16)` badge. Colors come from `theme.colors.stamp`
 * (opaque mixes — safe on elevated Android cards).
 */
import { View, Text } from 'react-native';
import type { StampTone } from '@cafe-mgmt/design-tokens';
import { useTheme } from '../../theme';

export type StampProps = {
  label: string;
  tone?: StampTone;
  size?: 'sm' | 'md';
  /** Leading status dot (e.g. the LIVE indicator). */
  dot?: boolean;
};

export function Stamp({ label, tone = 'neutral', size = 'md', dot = false }: StampProps) {
  const theme = useTheme();
  const c = theme.colors.stamp[tone];
  const sm = size === 'sm';

  return (
    <View
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.spacing[1],
        backgroundColor: c.bg,
        borderColor: c.border,
        borderWidth: 1.5,
        borderRadius: theme.radii.xs + 1,
        paddingVertical: sm ? 2 : 3,
        paddingHorizontal: sm ? theme.spacing[1] + 2 : theme.spacing[2],
      }}
    >
      {dot ? (
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: c.fg }} />
      ) : null}
      <Text
        style={{
          color: c.fg,
          fontFamily: theme.fonts.monoBold,
          fontSize: theme.text['2xs'],
          letterSpacing: 1,
          textTransform: 'uppercase',
          lineHeight: theme.text['2xs'] + 3,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
