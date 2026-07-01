/**
 * Screen wrapper: themed background + safe-area padding. `scroll` wraps content
 * in a keyboard-aware ScrollView for form screens.
 */
import type { ReactNode } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';

export function Screen({
  children,
  scroll = false,
  padded = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pad: ViewStyle = padded
    ? { paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[4] }
    : {};
  const base: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.bg,
    paddingTop: insets.top,
    paddingBottom: insets.bottom,
  };

  if (scroll) {
    return (
      <KeyboardAvoidingView
        style={base}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[{ flexGrow: 1 }, pad, style]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }
  return <View style={[base, pad, style]}>{children}</View>;
}
