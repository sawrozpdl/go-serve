/**
 * AppSheet — bottom sheet on @gorhom/bottom-sheet (spring physics, drag to
 * dismiss, REAL keyboard avoidance), keeping the old hand-rolled Sheet's
 * controlled `open`/`onClose` API so call sites migrate mechanically.
 *
 * Inputs inside the sheet must use `AppSheet.TextInput` (and scrollable
 * content `AppSheet.ScrollView`) so gorhom's `keyboardBehavior="interactive"`
 * can track focus — this is what fixes the keyboard-over-the-amount-field
 * defect in the settle flow.
 *
 * Requires `BottomSheetModalProvider` at the app root (installed in
 * src/app/_layout.tsx).
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { View, Pressable } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useTheme } from '../../theme';
import { AppText, Heading } from './Text';

export type AppSheetProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Tall sheet (menu browsing) instead of hugging content. */
  full?: boolean;
  rightAction?: { label: string; onPress: () => void };
  /** Pinned under the content (action bars). */
  footer?: ReactNode;
};

function Backdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      pressBehavior="close"
      accessibilityLabel="sheet-backdrop"
    />
  );
}

export function AppSheet({ open, onClose, title, children, full = false, rightAction, footer }: AppSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const ref = useRef<BottomSheetModal>(null);
  // Track `open` for onDismiss so a programmatic close doesn't re-fire
  // onClose. Mirrored post-commit (ref writes during render are forbidden
  // under the React Compiler); declared before the present/dismiss effect so
  // same-commit ordering keeps it fresh.
  const openRef = useRef(open);
  const presentedRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    if (open) {
      ref.current?.present();
      presentedRef.current = true;
    } else if (presentedRef.current) {
      // Only dismiss a sheet we actually presented. Calling dismiss() on a
      // never-presented gorhom modal (every sheet that mounts with open=false)
      // leaves it in a state where the next present() is a no-op — so
      // button-opened sheets never appear. Skipping the mount-time dismiss
      // keeps present() working.
      ref.current?.dismiss();
      presentedRef.current = false;
    }
  }, [open]);

  const handleDismiss = useCallback(() => {
    // Swipe-down / backdrop tap: sync parent state.
    if (openRef.current) onClose();
  }, [onClose]);

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing[5],
        paddingTop: theme.spacing[1],
        paddingBottom: theme.spacing[2],
        gap: theme.spacing[3],
      }}
    >
      <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="sheet-close">
        <X size={24} color={theme.colors.textMuted} />
      </Pressable>
      <View style={{ flex: 1 }}>
        {title ? <Heading style={{ fontSize: theme.text['3xl'] }}>{title}</Heading> : null}
      </View>
      {rightAction ? (
        <Pressable onPress={rightAction.onPress} hitSlop={10} accessibilityLabel="sheet-action">
          <AppText style={{ color: theme.colors.stamp.brand.fg, fontFamily: theme.fonts.bodySemi }}>
            {rightAction.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <BottomSheetModal
      ref={ref}
      onDismiss={handleDismiss}
      enableDynamicSizing={!full}
      snapPoints={full ? ['92%'] : undefined}
      backdropComponent={Backdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{
        backgroundColor: theme.colors.surfaces[1],
        borderTopLeftRadius: theme.radii['2xl'],
        borderTopRightRadius: theme.radii['2xl'],
      }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.border, width: 40 }}
      topInset={insets.top + theme.spacing[2]}
    >
      {full ? (
        // Fixed-height sheet: a plain flex View fills gorhom's bounded content
        // container (BottomSheetContent sets an explicit height = sheet − handle).
        // We must NOT use BottomSheetView here — it forces position:absolute and
        // hugs its content, so flex:1 is ignored and a tall child (the menu list)
        // overflows the sheet without scrolling and pushes the footer off-screen.
        // A plain View lets the inner BottomSheetScrollView own the scroll.
        <View style={{ flex: 1, paddingBottom: insets.bottom + theme.spacing[3] }}>
          {header}
          <View style={{ flex: 1 }}>{children}</View>
          {footer}
        </View>
      ) : (
        <BottomSheetView style={{ paddingBottom: insets.bottom + theme.spacing[3] }}>
          {header}
          {children}
          {footer}
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
}

/** Use for scrollable sheet content — keeps drag + keyboard tracking working. */
AppSheet.ScrollView = BottomSheetScrollView;
/** Use for EVERY input inside a sheet — enables keyboard avoidance. */
AppSheet.TextInput = BottomSheetTextInput;
AppSheet.View = BottomSheetView;
