/**
 * Floating action button — a circular brand-filled action that floats over the
 * screen content (Gmail-style compose), pinned bottom-right above the tab bar.
 * Doesn't take up layout space, so the list beneath scrolls freely.
 */
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { PressableScale } from './PressableScale';

export function Fab({
  icon,
  onPress,
  accessibilityLabel,
}: {
  icon: ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      pressedScale={0.94}
      onPress={onPress}
      style={{
        position: 'absolute',
        right: theme.spacing[5],
        // Clear the offline banner (bottom: insets.bottom + 66) when it shows,
        // and the home indicator otherwise.
        bottom: insets.bottom + theme.spacing[5],
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: theme.colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        ...theme.elevation.card,
      }}
    >
      {icon}
    </PressableScale>
  );
}
