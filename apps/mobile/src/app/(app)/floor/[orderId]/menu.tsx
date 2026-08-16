/**
 * Add-items screen — the menu as a real pushed screen (not a bottom sheet), so
 * it opens instantly, scrolls natively, and never fights the sheet gestures.
 * Shares order state with the ticket via useOrderController (same orderId param
 * → same react-query cache). A brand-new walk-in creates its order on the first
 * add; "Done" then lands on that order's ticket.
 */
import { useCallback } from 'react';
import { View, Pressable, BackHandler } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { Heading } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { MenuGrid } from '@/components/order/MenuGrid';
import { AddOnSheet } from '@/components/order/AddOnSheet';
import { useOrderController } from '@/components/order/useOrderController';
import { useTheme } from '@/theme';

export default function AddItemsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctrl = useOrderController();

  const done = useCallback(() => {
    // A draft with items → review + fire it on the ticket. It's still a device
    // draft (orderId 'new') until Send actually opens the tab; the ticket's
    // controller reads the same shared draft cart. Empty draft or an existing
    // order → just pop back.
    if (ctrl.isDraft && ctrl.pendingCount > 0) {
      router.replace({ pathname: '/floor/[orderId]', params: { orderId: ctrl.orderId ?? 'new' } });
    } else {
      router.back();
    }
  }, [ctrl.isDraft, ctrl.pendingCount, ctrl.orderId, router]);

  // Android back must behave like Done: a draft cart lives only on this device,
  // so popping straight to the floor would silently bin the items just added.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!ctrl.hasUnsavedDraft) return false;
        done();
        return true;
      });
      return () => sub.remove();
    }, [ctrl.hasUnsavedDraft, done]),
  );

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

      {/* Add-on picker. Mounted here as well as in the split view because on a
          phone the grid lives on its own screen — whichever composition took the
          tap has to be able to show the sheet. */}
      <AddOnSheet
        item={ctrl.addOnFor}
        category={ctrl.addOnCategory}
        groups={ctrl.modifierGroups}
        loading={ctrl.modifierGroupsLoading}
        onClose={() => ctrl.setAddOnFor(null)}
        onConfirm={(addOns) => {
          const mi = ctrl.addOnFor;
          ctrl.setAddOnFor(null);
          if (mi) void ctrl.addMenuItem(mi, addOns);
        }}
      />


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
