/**
 * Modern bottom sheet. Safe-area correct (content never sits under the notch /
 * camera), rounded top, grabber handle, a header with a Cancel (✕) and optional
 * right action, and a dimmed backdrop that dismisses on tap. `full` makes it a
 * tall sheet (menu browsing); otherwise it hugs its content (confirm / rename).
 */
import type { ReactNode } from 'react';
import { Modal, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { Heading, AppText } from './Text';
import { useTheme } from '../../theme';

export function Sheet({
  open,
  onClose,
  title,
  children,
  full = false,
  rightAction,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  full?: boolean;
  rightAction?: { label: string; onPress: () => void };
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityLabel="sheet-backdrop"
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }}
        />
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radii['2xl'],
            borderTopRightRadius: theme.radii['2xl'],
            borderTopWidth: 1,
            borderColor: theme.colors.bevel,
            marginTop: full ? insets.top + theme.spacing[2] : undefined,
            height: full ? undefined : undefined,
            flex: full ? 1 : undefined,
            paddingBottom: insets.bottom + theme.spacing[3],
            ...theme.elevation.raised,
          }}
        >
          {/* Grabber */}
          <View style={{ alignItems: 'center', paddingTop: theme.spacing[2] }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: theme.colors.border }} />
          </View>

          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: theme.spacing[5],
              paddingTop: theme.spacing[3],
              paddingBottom: theme.spacing[2],
              gap: theme.spacing[3],
            }}
          >
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="sheet-close">
              <X size={24} color={theme.colors.textMuted} />
            </Pressable>
            <View style={{ flex: 1 }}>{title ? <Heading style={{ fontSize: 22 }}>{title}</Heading> : null}</View>
            {rightAction ? (
              <Pressable onPress={rightAction.onPress} hitSlop={10} accessibilityLabel="sheet-action">
                <AppText style={{ color: theme.colors.primary, fontFamily: theme.fonts.bodySemi }}>
                  {rightAction.label}
                </AppText>
              </Pressable>
            ) : null}
          </View>

          {full ? <View style={{ flex: 1 }}>{children}</View> : <View>{children}</View>}
        </View>
      </View>
    </Modal>
  );
}
