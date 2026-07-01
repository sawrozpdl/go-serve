/** Renders active toasts as a stack near the top, tap to dismiss. */
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from './Text';
import { useTheme } from '../../theme';
import { useToasts, type ToastKind } from '../../lib/toast';

export function Toasts() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  if (items.length === 0) return null;

  const accent: Record<ToastKind, string> = {
    success: theme.colors.successFg,
    error: theme.colors.dangerFg,
    info: theme.colors.infoFg,
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + theme.spacing[2],
        left: theme.spacing[4],
        right: theme.spacing[4],
        gap: theme.spacing[2],
        zIndex: 1000,
      }}
    >
      {items.map((t) => (
        <Pressable
          key={t.id}
          onPress={() => dismiss(t.id)}
          style={{
            backgroundColor: theme.colors.card,
            borderRadius: theme.radii.md,
            borderLeftWidth: 3,
            borderLeftColor: accent[t.kind],
            borderWidth: 1,
            borderColor: theme.colors.border,
            paddingVertical: theme.spacing[3],
            paddingHorizontal: theme.spacing[4],
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
            elevation: 6,
          }}
        >
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{t.title}</AppText>
          {t.msg ? (
            <AppText variant="faint" style={{ fontSize: theme.text.sm, marginTop: 2 }}>
              {t.msg}
            </AppText>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
