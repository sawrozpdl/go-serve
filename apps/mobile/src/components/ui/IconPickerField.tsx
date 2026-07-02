/**
 * Labeled icon picker — a horizontally-scrolling strip of the app icon registry
 * plus a "none" option. Used by the category / item / table forms so an
 * operator can tag a catalog entry with the same glyphs the POS renders.
 */
import { View, Pressable, ScrollView } from 'react-native';
import { AppText } from './Text';
import { AppIcon, ICON_REGISTRY } from './Icon';
import { useTheme, hexToRgba } from '../../theme';

const NAMES = Object.keys(ICON_REGISTRY);

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
  const chip = (name: string, selected: boolean, onPress: () => void, content: React.ReactNode) => (
    <Pressable
      key={name || 'none'}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`icon-${name || 'none'}`}
      style={{
        width: 46,
        height: 46,
        borderRadius: theme.radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: selected ? 1.5 : 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: selected ? hexToRgba(theme.colors.primary, 0.18) : theme.colors.card,
      }}
    >
      {content}
    </Pressable>
  );

  return (
    <View style={{ gap: theme.spacing[2] }}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing[2], paddingRight: theme.spacing[4] }}>
        {chip(
          '',
          !value,
          () => onChange(''),
          <AppText style={{ color: theme.colors.textMuted, fontSize: theme.text.sm }}>None</AppText>,
        )}
        {NAMES.map((name) =>
          chip(
            name,
            value === name,
            () => onChange(name),
            <AppIcon name={name} size={22} color={value === name ? theme.colors.primary : theme.colors.textMuted} />,
          ),
        )}
      </ScrollView>
    </View>
  );
}
