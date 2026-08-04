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
 * INVARIANT: `AppSheet.ScrollView` requires `size="medium"` or `size="full"`.
 * A `size="hug"` sheet has no bounded scroll region, so a scroll view inside
 * one silently never scrolls (see the `size` prop docs). A `__DEV__` check
 * below shouts if that pairing is ever built again.
 *
 * Requires `BottomSheetModalProvider` at the app root (installed in
 * src/app/_layout.tsx).
 */
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';
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
  /** Legacy alias for `size="full"`. */
  full?: boolean;
  /**
   * How tall the sheet is, which decides whether its content can scroll.
   *
   * - `'hug'` (default) — dynamic sizing: as tall as its content, and there is
   *   NO scroll region. Never put an `AppSheet.ScrollView` in a hug sheet:
   *   gorhom's `BottomSheetView` and `BottomSheetScrollView` BOTH report
   *   `contentHeight` for dynamic sizing, so they race, the sheet goes to its
   *   max, `BottomSheetView` (position:absolute, no height) hugs the un-shrunk
   *   scroll view, `contentSize === frame`, and the drag does nothing. The
   *   list renders perfectly and simply never moves.
   * - `'medium'` — one fixed detent at 60%. Use for "pick one from a possibly
   *   long list" (the credit-account picker, the send-to-kitchen recap).
   * - `'full'` — one fixed detent at 100%. Use for forms with inputs, since
   *   `keyboardBehavior="interactive"` shifts a shorter sheet on focus.
   *
   * Both fixed sizes give gorhom's content box a definite height, which is what
   * lets an inner `AppSheet.ScrollView` actually scroll.
   */
  size?: 'hug' | 'medium' | 'full';
  rightAction?: { label: string; onPress: () => void };
  /** Pinned under the content (action bars). */
  footer?: ReactNode;
};

// Module-level so the array identity is stable: `snapPoints` feeds a
// `useDerivedValue` inside gorhom's `useAnimatedDetents`.
const FULL_SNAP = ['100%'];
const MEDIUM_SNAP = ['60%'];

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

export function AppSheet({
  open,
  onClose,
  title,
  children,
  full = false,
  size,
  rightAction,
  footer,
}: AppSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const ref = useRef<BottomSheetModal>(null);
  const mode = size ?? (full ? 'full' : 'hug');
  // 'medium' and 'full' share one code path: a single fixed detent, which is
  // what gives the content box a definite height.
  const fixed = mode !== 'hug';
  // Track `open` for onDismiss so a programmatic close doesn't re-fire
  // onClose. Mirrored post-commit (ref writes during render are forbidden
  // under the React Compiler); declared before the present/dismiss effect so
  // same-commit ordering keeps it fresh.
  const openRef = useRef(open);
  const presentedRef = useRef(false);
  // True from the moment we call dismiss() until gorhom's onDismiss actually
  // fires (the close animation finishing is async). Calling present() again
  // while this is true is a silent no-op in gorhom — reopening a sheet right
  // after closing it (e.g. voiding one item, then immediately voiding the
  // next) would otherwise never show. We defer the re-present via
  // pendingOpenRef until the in-flight dismiss genuinely completes.
  const dismissingRef = useRef(false);
  const pendingOpenRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    if (open) {
      if (dismissingRef.current) {
        pendingOpenRef.current = true;
        return;
      }
      if (!presentedRef.current) {
        ref.current?.present();
        presentedRef.current = true;
      }
    } else {
      pendingOpenRef.current = false;
      if (presentedRef.current && !dismissingRef.current) {
        // Only dismiss a sheet we actually presented. Calling dismiss() on a
        // never-presented gorhom modal (every sheet that mounts with open=false)
        // leaves it in a state where the next present() is a no-op — so
        // button-opened sheets never appear. Skipping the mount-time dismiss
        // keeps present() working.
        dismissingRef.current = true;
        ref.current?.dismiss();
      }
    }
  }, [open]);

  // Tripwire for the one bug class this `size` prop exists to prevent: a
  // scroll view in a hug sheet renders fine and never scrolls, so it hides as
  // "the list looks short". It stranded operators on the credit-account picker
  // (unable to charge a bill to an account past the fold) and, before e8f81f6,
  // on MoveTableSheet. Direct children only — that's the shape both bugs had.
  const scrollViewInHugSheet =
    __DEV__ &&
    !fixed &&
    Children.toArray(children).some((c) => isValidElement(c) && c.type === SheetScrollView);
  useEffect(() => {
    if (scrollViewInHugSheet) {
      console.error(
        '[AppSheet] AppSheet.ScrollView cannot scroll inside a size="hug" sheet — ' +
          'pass size="medium" (or size="full" if it holds inputs).',
      );
    }
  }, [scrollViewInHugSheet]);

  const handleDismiss = useCallback(() => {
    // Fires once gorhom's close animation has truly finished — for both a
    // programmatic dismiss() and a swipe-down / backdrop tap.
    presentedRef.current = false;
    dismissingRef.current = false;
    if (pendingOpenRef.current) {
      pendingOpenRef.current = false;
      ref.current?.present();
      presentedRef.current = true;
    } else if (openRef.current) {
      // Swipe-down / backdrop tap: sync parent state.
      onClose();
    }
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
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Sheet titles interpolate user data — `Adjust · ${item.name}`,
            `member.name || member.email`, a tenant or credit-account name. */}
        {title ? (
          <Heading style={{ fontSize: theme.text['3xl'] }} numberOfLines={1}>
            {title}
          </Heading>
        ) : null}
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
      enableDynamicSizing={!fixed}
      snapPoints={mode === 'full' ? FULL_SNAP : mode === 'medium' ? MEDIUM_SNAP : undefined}
      // Sheets opened from inside another sheet (pick a credit account, create
      // one mid-settle) must stack, not replace. gorhom's default 'replace'
      // dismisses the sheet underneath — which fires ITS onDismiss, so the
      // parent's controlled `open` flipped to false and the whole flow
      // collapsed back to the screen behind it.
      stackBehavior="push"
      backdropComponent={Backdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      // NB: deliberately no `android_keyboardInputMode="adjustResize"`. On
      // Android edge-to-edge (SDK 57) that value makes gorhom skip its own
      // keyboard handling and defer to an OS window-resize that never happens,
      // so inputs + the pinned footer stayed hidden behind the keyboard. Letting
      // gorhom's default (adjustPan) run means it shifts a small sheet up and
      // shrinks a full sheet's content, keeping both the input and footer above
      // the keyboard.
      backgroundStyle={{
        backgroundColor: theme.colors.surfaces[1],
        borderTopLeftRadius: theme.radii['2xl'],
        borderTopRightRadius: theme.radii['2xl'],
      }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.border, width: 40 }}
      topInset={insets.top + theme.spacing[2]}
    >
      {fixed ? (
        // Fixed-height sheet (medium/full): a plain flex View fills gorhom's
        // bounded content container (BottomSheetContent sets an explicit
        // height = sheet − handle).
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

/** Use for scrollable sheet content — keeps drag + keyboard tracking working.
 *
 * `keyboardShouldPersistTaps` defaults to "handled": a ScrollView's stock
 * "never" makes the FIRST tap anywhere outside a focused input do nothing but
 * dismiss the keyboard, so every button below a money field (record settlement,
 * save, tender) needed two taps and read as dead. */
function SheetScrollView({
  keyboardShouldPersistTaps = 'handled',
  ...props
}: ComponentProps<typeof BottomSheetScrollView>) {
  return <BottomSheetScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props} />;
}

AppSheet.ScrollView = SheetScrollView;
/** Use for EVERY input inside a sheet — enables keyboard avoidance. */
AppSheet.TextInput = BottomSheetTextInput;
AppSheet.View = BottomSheetView;
