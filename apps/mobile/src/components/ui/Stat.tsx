/**
 * Stat — KPI tile: mono uppercase label over a big tabular-mono value (the
 * number is the hero). Replaces dashboard's local `Kpi`. `loading` swaps the
 * value for a skeleton bar so KPI grids don't jump when data lands.
 */
import { Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { Card } from './Card';
import { Skeleton } from './Skeleton';
import { AppText } from './Text';

export type StatProps = {
  label: string;
  value: string;
  /** md = grid tile, lg = the headline stat. */
  size?: 'md' | 'lg';
  /** Color the value (net profit green/red etc.). */
  tone?: 'default' | 'success' | 'danger' | 'brand';
  /** Small print under the value. */
  hint?: string;
  loading?: boolean;
  style?: object;
};

export function Stat({ label, value, size = 'md', tone = 'default', hint, loading, style }: StatProps) {
  const theme = useTheme();
  const valueColor =
    tone === 'success'
      ? theme.colors.successFg
      : tone === 'danger'
        ? theme.colors.dangerFg
        : tone === 'brand'
          ? theme.colors.stamp.brand.fg
          : theme.colors.text;
  const valueStyle = size === 'lg' ? theme.typeStyles.display : theme.typeStyles['2xl'];

  return (
    <Card style={[{ gap: theme.spacing[1] }, style]} elevated={size === 'lg'}>
      <Text
        style={{
          color: theme.colors.textMuted,
          fontFamily: theme.fonts.monoMedium,
          fontSize: theme.text['2xs'],
          letterSpacing: 1.4,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      {loading ? (
        <View style={{ paddingVertical: theme.spacing[1] }}>
          <Skeleton width="70%" height={size === 'lg' ? 30 : 18} />
        </View>
      ) : (
        <Text
          style={{
            color: valueColor,
            fontFamily: theme.fonts.monoBold,
            fontSize: valueStyle.size,
            lineHeight: valueStyle.lineHeight,
            letterSpacing: valueStyle.tracking,
            fontVariant: ['tabular-nums'],
          }}
        >
          {value}
        </Text>
      )}
      {hint ? (
        <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
          {hint}
        </AppText>
      ) : null}
    </Card>
  );
}
