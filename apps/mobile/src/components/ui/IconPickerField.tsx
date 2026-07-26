/**
 * Labeled icon picker — a horizontally-scrolling strip of the app icon registry
 * plus a "none" option. Used by the category / item / table forms so an
 * operator can tag a catalog entry with the same glyphs the POS renders.
 *
 * SHEET-ONLY: the strip uses `AppSheet.FlashList`, so this must be rendered
 * inside an AppSheet. All three call sites are sheet forms. If it ever needs to
 * live on a plain screen, swap in a bare FlashList there — see the note at the
 * list below for why the sheet-aware one is required here.
 */
import { memo } from 'react';
import { View, Pressable } from 'react-native';
import { AppSheet } from './AppSheet';
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
      {/* Virtualized so a form doesn't mount all 50+ icon SVGs up front.
          MUST be the sheet-aware list: a raw FlashList here renders fine but
          never scrolls, because gorhom's sheet swallows the horizontal drag —
          which silently limits the operator to the first few icons. */}
      <View style={{ height: 46 }}>
        <AppSheet.FlashList
          horizontal
          data={NAMES}
          keyExtractor={(name: string) => name || 'none'}
          showsHorizontalScrollIndicator={false}
          extraData={value}
          renderItem={({ item }: { item: string }) => (
            <IconChip name={item} selected={item ? value === item : !value} onChange={onChange} />
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
