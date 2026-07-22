/**
 * Add-items screen — the menu as a real pushed screen (not a bottom sheet), so
 * it opens instantly, scrolls natively, and never fights the sheet gestures.
 * Shares order state with the ticket via useOrderController (same orderId param
 * → same react-query cache). A brand-new walk-in creates its order on the first
 * add; "Done" then lands on that order's ticket.
 */
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { Heading } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { MenuGrid } from '@/components/order/MenuGrid';
import { useOrderController } from '@/components/order/useOrderController';
import { useTheme } from '@/theme';

export default function AddItemsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctrl = useOrderController();

  const done = () => {
    // A draft with items → review + fire it on the ticket. It's still a device
    // draft (orderId 'new') until Send actually opens the tab; the ticket's
    // controller reads the same shared draft cart. Empty draft or an existing
    // order → just pop back.
    if (ctrl.isDraft && ctrl.pendingCount > 0) {
      router.replace({ pathname: '/floor/[orderId]', params: { orderId: ctrl.orderId ?? 'new' } });
    } else {
      router.back();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing[2],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[2],
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing[3],
        }}
      >
        <Pressable onPress={done} hitSlop={10} accessibilityLabel="sheet-close">
          <X size={24} color={theme.colors.textMuted} />
        </Pressable>
        <Heading style={{ fontSize: theme.text['3xl'] }}>Add items</Heading>
      </View>

      <MenuGrid ctrl={ctrl} style={{ flex: 1 }} />

      {/* Pinned footer */}
      <View
        style={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[2],
          paddingBottom: insets.bottom + theme.spacing[3],
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.surface,
        }}
      >
        <Button
          title={ctrl.pendingCount > 0 ? `Done · ${ctrl.pendingCount} on tab` : 'Done'}
          onPress={done}
        />
      </View>
    </View>
  );
}
