/**
 * Labeled icon picker — a horizontally-scrolling strip of the app icon registry
 * plus a "none" option. Used by the category / item / table forms so an
 * operator can tag a catalog entry with the same glyphs the POS renders.
 *
 * The strip MUST use gesture-handler's ScrollView, not RN's. Inside a gorhom
 * sheet the plain one never scrolls at all — the sheet's content-panning gesture
 * swallows the horizontal drag, silently stranding the operator on the first 7
 * of ~50 icons with no visible symptom. (Verified on-device: the pre-existing
 * RN ScrollView did not scroll either, so this was broken in 1.0.1.) RNGH's
 * ScrollView is backed by a native gesture handler, so it composes with the
 * sheet's pan instead of losing to it.
 *
 * Deliberately NOT virtualized: a bare `FlashList` has the same swallowed-drag
 * problem, and gorhom's `BottomSheetFlashList` is deprecated in v5 and stops
 * the sheet presenting entirely. ~50 chips cost ~120ms once, in a sheet the
 * operator opened on purpose.
 */
import { memo } from 'react';
import { View, Pressable } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingRight: theme.spacing[4] }}
      >
        {NAMES.map((name) => (
          <IconChip
            key={name || 'none'}
            name={name}
            selected={name ? value === name : !value}
            onChange={onChange}
          />
        ))}
      </ScrollView>
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
