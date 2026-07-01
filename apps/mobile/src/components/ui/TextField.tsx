/**
 * Themed labeled text input with optional error text.
 */
import { useState } from 'react';
import { View, TextInput, type TextInputProps } from 'react-native';
import { useTheme } from '../../theme';
import { AppText } from './Text';

export type TextFieldProps = TextInputProps & {
  label?: string;
  error?: string;
};

export function TextField({ label, error, style, ...props }: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error
    ? theme.colors.dangerFg
    : focused
      ? theme.colors.primary
      : theme.colors.border;

  return (
    <View style={{ gap: theme.spacing[2] }}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      <TextInput
        placeholderTextColor={theme.colors.textFaint}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.card,
            borderColor,
            borderWidth: 1,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing[4],
            paddingVertical: theme.spacing[4],
            fontSize: theme.text.lg,
            fontFamily: theme.typography.bodyFamily,
            minHeight: 52,
          },
          style,
        ]}
        {...props}
      />
      {error ? (
        <AppText variant="label" style={{ color: theme.colors.dangerFg }}>
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
