/**
 * Small labeled form controls shared by the catalog forms: a toggle row and a
 * segmented single-select.
 */
import { View, Switch, Pressable } from 'react-native';
import { AppText } from './Text';
import { useTheme } from '../../theme';

export function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing[3] }}>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{label}</AppText>
        {hint ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {hint}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
        thumbColor={theme.colors.ink[50]}
      />
    </View>
  );
}

export function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      <View style={{ flexDirection: 'row', gap: theme.spacing[2], flexWrap: 'wrap' }}>
        {options.map((o) => {
          const active = value === o.value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={{
                paddingHorizontal: theme.spacing[3],
                paddingVertical: theme.spacing[2],
                borderRadius: theme.radii.pill,
                borderWidth: 1,
                borderColor: active ? theme.colors.primary : theme.colors.border,
                backgroundColor: active ? theme.colors.primaryTint : 'transparent',
              }}
            >
              <AppText
                style={{
                  color: active ? theme.colors.primary : theme.colors.textMuted,
                  fontFamily: active ? theme.fonts.bodySemi : theme.fonts.body,
                  fontSize: theme.text.sm,
                }}
              >
                {o.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
