/**
 * Chip — selectable filter/toggle pill (menu categories, tender pickers,
 * Rs/% toggles). Visual height stays compact but the touch target reaches
 * `theme.touch.min` via padding + hitSlop.
 */
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { useTheme } from '../../theme';
import { PressableScale } from './PressableScale';

export type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /** Small leading element (icon). */
  icon?: ReactNode;
  /** Trailing count, rendered in mono ("Espresso · 3"). */
  count?: number;
  testID?: string;
};

export function Chip({ label, selected = false, onPress, disabled, icon, count, testID }: ChipProps) {
  const theme = useTheme();
  const fg = selected ? theme.colors.stamp.brand.fg : theme.colors.textMuted;

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !!disabled }}
      testID={testID}
      hitSlop={6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1] + 2,
        backgroundColor: selected ? theme.colors.primaryTint : theme.colors.surfaces[2],
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        borderWidth: selected ? 1.5 : 1,
        borderRadius: theme.radii.pill,
        paddingVertical: theme.spacing[2] + 1,
        paddingHorizontal: theme.spacing[3] + 2,
        minHeight: 38,
      }}
    >
      {icon}
      <Text
        style={{
          color: fg,
          fontFamily: selected ? theme.fonts.bodySemi : theme.fonts.bodyMedium,
          fontSize: theme.text.md,
        }}
      >
        {label}
      </Text>
      {count != null ? (
        <Text
          style={{
            color: fg,
            fontFamily: theme.fonts.monoMedium,
            fontSize: theme.text.sm,
            fontVariant: ['tabular-nums'],
          }}
        >
          {count}
        </Text>
      ) : null}
    </PressableScale>
  );
}
