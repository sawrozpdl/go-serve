/**
 * Labeled icon picker — a horizontally-scrolling strip of the app icon registry
 * plus a "none" option. Used by the category / item / table forms so an
 * operator can tag a catalog entry with the same glyphs the POS renders.
 */
import { memo } from 'react';
import { View, Pressable } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { AppText } from './Text';
import { AppIcon, ICON_REGISTRY } from './Icon';
import { useTheme, hexToRgba } from '../../theme';

/** '' is the "no icon" chip; the rest are the registry names. */
const NAMES: string[] = ['', ...Object.keys(ICON_REGISTRY)];

export function IconPickerField({
  label,
  value,
  onChange,
}: {
  label?: string;
  value: string;
  onChange: (name: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      {/* Virtualized: the registry is 50+ icons and each chip is an SVG, so
          mounting the whole strip made every category/item/table form open
          noticeably slower. Only the visible chips render now. */}
      <View style={{ height: 46 }}>
        <FlashList
          horizontal
          data={NAMES}
          keyExtractor={(name) => name || 'none'}
          showsHorizontalScrollIndicator={false}
          extraData={value}
          contentContainerStyle={{ paddingRight: theme.spacing[4] }}
          renderItem={({ item: name }) => (
            <IconChip name={name} selected={name ? value === name : !value} onChange={onChange} />
          )}
        />
      </View>
    </View>
  );
}

const IconChip = memo(function IconChip({
  name,
  selected,
  onChange,
}: {
  name: string;
  selected: boolean;
  onChange: (name: string) => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => onChange(name)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`icon-${name || 'none'}`}
      style={{
        width: 46,
        height: 46,
        marginRight: theme.spacing[2],
        borderRadius: theme.radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: selected ? 1.5 : 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected ? hexToRgba(theme.colors.primary, 0.18) : theme.colors.card,
      }}
    >
      {name ? (
        <AppIcon name={name} size={22} color={selected ? theme.colors.primary : theme.colors.textMuted} />
      ) : (
        <AppText style={{ color: theme.colors.textMuted, fontSize: theme.text.sm }}>None</AppText>
      )}
    </Pressable>
  );
});
