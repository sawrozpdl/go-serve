/**
 * Guest-mode pill: says plainly that the data is a sample, and offers the way out.
 *
 * Mounted next to OfflineBanner in (app)/_layout, so it covers all four tabs, the
 * More stack and the order screens without any of them knowing. Absolutely
 * positioned rather than an in-flow strip: a strip would push every screen's
 * content down and reopen safe-area questions on tablets.
 *
 * Takes the connectivity pill's slot outright: OfflineBanner renders nothing in
 * demo mode, so the two can never collide.
 */
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react-native';
import { AppText } from './ui/Text';
import { useTheme, shadow } from '@/theme';
import { useAuthStore } from '@/stores/auth';
import { exitDemo } from '@/demo/session';

export function DemoBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const demo = useAuthStore((s) => s.demo);

  if (!demo) return null;

  const c = theme.colors.stamp.info;

  // Await the sign-out before navigating: login mounts while hasSession is still
  // true otherwise, and (auth)/_layout bounces straight back into the demo.
  async function onExit() {
    await exitDemo();
    qc.clear();
    router.replace('/(auth)/login');
  }

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 66, alignItems: 'center' }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing[3],
          paddingLeft: theme.spacing[4],
          paddingRight: theme.spacing[2],
          paddingVertical: theme.spacing[2],
          borderRadius: theme.radii.pill,
          backgroundColor: theme.colors.cardElevated,
          borderWidth: 1,
          borderColor: c.border,
          ...shadow(theme.elevation.raised),
        }}
      >
        <FlaskConical size={15} color={c.fg} />
        <AppText
          style={{ color: theme.colors.text, fontSize: theme.text.sm, fontFamily: theme.fonts.bodySemi }}
        >
          Demo mode · sample data
        </AppText>
        <Pressable
          onPress={() => void onExit()}
          accessibilityRole="button"
          accessibilityLabel="exit-demo"
          hitSlop={8}
          style={{
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[1],
            borderRadius: theme.radii.pill,
            backgroundColor: c.bg,
          }}
        >
          <AppText style={{ color: c.fg, fontSize: theme.text.sm, fontFamily: theme.fonts.bodySemi }}>
            Exit
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}
