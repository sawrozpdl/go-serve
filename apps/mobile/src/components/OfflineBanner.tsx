/**
 * Floating connectivity + sync pill, shown above the tab bar. States:
 *   offline        → amber "Offline · N queued" (writes are being captured)
 *   syncing        → online with queued/replaying ops draining
 *   needs review   → some ops were rejected on sync; tap to open the tray
 * Hidden entirely when online with an empty queue.
 */
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react-native';
import { AppText } from './ui/Text';
import { useTheme, hexToRgba } from '@/theme';
import { useConnectivity } from '@/stores/connectivity';
import { useOfflineQueue } from '@/offline/queue';

export function OfflineBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const mode = useConnectivity((s) => s.mode);
  const ops = useOfflineQueue((s) => s.ops);

  const review = ops.filter((o) => o.status === 'needs_review').length;
  const pending = ops.length - review;
  const offline = mode === 'offline';

  // Nothing to say → render nothing.
  if (!offline && pending === 0 && review === 0) return null;

  let tone: string;
  let Icon: typeof CloudOff;
  let text: string;
  let onPress: (() => void) | undefined;

  if (review > 0 && !offline && pending === 0) {
    tone = theme.colors.dangerFg;
    Icon = TriangleAlert;
    text = `${review} order change${review === 1 ? '' : 's'} need review`;
    onPress = () => router.push('/more/sync-review');
  } else if (offline) {
    tone = theme.colors.warnFgTile;
    Icon = CloudOff;
    text = pending > 0 ? `Offline · ${pending} change${pending === 1 ? '' : 's'} queued` : 'Offline · changes will sync';
  } else {
    tone = theme.colors.primary;
    Icon = RefreshCw;
    text = `Syncing ${pending} change${pending === 1 ? '' : 's'}…`;
  }

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 66, alignItems: 'center' }}
    >
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityLabel="connectivity-status"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: theme.spacing[4],
          paddingVertical: theme.spacing[2],
          borderRadius: theme.radii.pill,
          backgroundColor: theme.colors.cardElevated,
          borderWidth: 1,
          borderColor: hexToRgba(tone, 0.5),
          ...theme.elevation.raised,
        }}
      >
        <Icon size={15} color={tone} />
        <AppText style={{ color: theme.colors.text, fontSize: theme.text.sm, fontFamily: theme.fonts.bodySemi }}>
          {text}
        </AppText>
        {onPress ? <AppText style={{ color: tone, fontSize: theme.text.sm }}>›</AppText> : null}
      </Pressable>
    </View>
  );
}
