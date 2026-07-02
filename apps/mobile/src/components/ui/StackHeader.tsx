/**
 * Pinned top bar for pushed (stack) screens — a safe-area back button + title
 * that stays put while only the content below scrolls. Use it OUTSIDE the
 * ScrollView so the back affordance never scrolls away (native-app behaviour).
 */
import type { ReactNode } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { Heading } from './Text';
import { useTheme } from '../../theme';

export function StackHeader({
  title,
  right,
  onBack,
}: {
  title: string;
  right?: ReactNode;
  onBack?: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing[2],
        paddingHorizontal: theme.spacing[5],
        paddingBottom: theme.spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2],
        backgroundColor: theme.colors.bg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Pressable onPress={onBack ?? (() => router.back())} hitSlop={10} accessibilityLabel="back">
        <ChevronLeft size={26} color={theme.colors.primary} />
      </Pressable>
      <Heading style={{ fontSize: 26, flex: 1 }}>{title}</Heading>
      {right}
    </View>
  );
}
