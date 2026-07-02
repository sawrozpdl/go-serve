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
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
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
      <BottomSheetView
        style={{
          ...(full ? { flex: 1 } : null),
          paddingBottom: insets.bottom + theme.spacing[3],
        }}
      >
        {header}
        {full ? <View style={{ flex: 1 }}>{children}</View> : children}
        {footer}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

/** Use for scrollable sheet content — keeps drag + keyboard tracking working. */
AppSheet.ScrollView = BottomSheetScrollView;
/** Use for EVERY input inside a sheet — enables keyboard avoidance. */
AppSheet.TextInput = BottomSheetTextInput;
AppSheet.View = BottomSheetView;
