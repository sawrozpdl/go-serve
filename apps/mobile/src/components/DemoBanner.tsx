/**
 * Guest-mode strip: says plainly that the data is a sample, and offers the way out.
 *
 * IN-FLOW, not floating, and that is the whole point. A floating pill was tried
 * first and collided with something on every screen — at the bottom it covered the
 * order screen's Send/Settle bar and almost all of the More hub's "Exit demo"
 * button; at the top it cut through the header titles. Since this marker is on
 * screen for the entire session (unlike the connectivity pill, which is rare and
 * brief), "usually out of the way" isn't good enough: a control a reviewer can't
 * tap is the exact failure Play pulled the app for.
 *
 * Owning a row means nothing can overlap it, ever. It takes the top safe-area
 * inset itself, and (app)/_layout zeroes `top` for the screens below so they don't
 * pad for a status bar this strip is already clearing.
 */
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react-native';
import { AppText } from './ui/Text';
import { useTheme } from '@/theme';
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
      style={{
        paddingTop: insets.top,
        paddingBottom: theme.spacing[1],
        paddingLeft: theme.spacing[5],
        paddingRight: theme.spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2],
        backgroundColor: c.bg,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <FlaskConical size={13} color={c.fg} />
      <AppText
        style={{
          flex: 1,
          color: c.fg,
          fontSize: theme.text.xs,
          fontFamily: theme.fonts.bodySemi,
        }}
        numberOfLines={1}
      >
        Demo mode · sample data
      </AppText>
      <Pressable
        onPress={() => void onExit()}
        accessibilityRole="button"
        accessibilityLabel="exit-demo"
        hitSlop={10}
        style={{
          paddingHorizontal: theme.spacing[3],
          paddingVertical: 2,
          borderRadius: theme.radii.pill,
          borderWidth: 1,
          borderColor: c.border,
        }}
      >
        <AppText
          style={{ color: c.fg, fontSize: theme.text.xs, fontFamily: theme.fonts.bodySemi }}
        >
          Exit
        </AppText>
      </Pressable>
    </View>
  );
}
