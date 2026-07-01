/**
 * Sync Review tray. Order changes that the server REJECTED on replay (a 4xx —
 * tab settled elsewhere, item already gone) land here instead of being silently
 * dropped. The user can Retry (re-queue + drain) or Discard each one. Ops still
 * waiting to sync (queued/replaying) are shown read-only for transparency.
 */
import { View, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, RotateCcw, Trash2, CircleCheck } from 'lucide-react-native';
import { Heading, AppText } from '@/components/ui/Text';
import { useTheme } from '@/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOfflineQueue, removeOp, setOpStatus, type QueuedOp } from '@/offline/queue';
import { replayQueuedOps } from '@/offline/replay';
import { toast } from '@/lib/toast';

export default function SyncReview() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const ops = useOfflineQueue((s) => s.ops);

  const review = ops.filter((o) => o.status === 'needs_review');
  const pending = ops.filter((o) => o.status !== 'needs_review');

  const retry = (op: QueuedOp) => {
    setOpStatus(op.id, 'queued');
    void replayQueuedOps(qc);
    toast.success('Retrying', op.label);
  };
  const discard = (op: QueuedOp) => {
    removeOp(op.id);
    toast.success('Discarded', op.label);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Heading style={{ fontSize: 26 }}>Sync review</Heading>
        </View>

        {review.length === 0 && pending.length === 0 ? (
          <View style={{ alignItems: 'center', gap: theme.spacing[3], marginTop: theme.spacing[10] }}>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: theme.colors.card,
                alignItems: 'center',
                justifyContent: 'center',
                ...theme.elevation.card,
              }}
            >
              <CircleCheck size={30} color={theme.colors.successFg} />
            </View>
            <AppText variant="muted" style={{ fontFamily: theme.fonts.bodySemi }}>
              Everything&rsquo;s synced
            </AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm, textAlign: 'center' }}>
              Offline changes sync automatically when you reconnect. Rejected ones show up here.
            </AppText>
          </View>
        ) : null}

        {review.length > 0 ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="label" style={{ color: theme.colors.dangerFg }}>
              Needs review · {review.length}
            </AppText>
            {review.map((op) => (
              <View
                key={op.id}
                style={{
                  backgroundColor: theme.colors.card,
                  borderRadius: theme.radii.lg,
                  borderLeftWidth: 4,
                  borderLeftColor: theme.colors.dangerFg,
                  padding: theme.spacing[4],
                  gap: theme.spacing[3],
                  ...theme.elevation.card,
                }}
              >
                <View style={{ gap: 2 }}>
                  <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{op.label}</AppText>
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {op.failure?.message ?? 'Rejected on sync'}
                    {op.failure?.status ? ` (${op.failure.status})` : ''}
                  </AppText>
                </View>
                <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                  <Action icon="retry" label="Retry" color={theme.colors.primary} onPress={() => retry(op)} />
                  <Action icon="discard" label="Discard" color={theme.colors.dangerFg} onPress={() => discard(op)} />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {pending.length > 0 ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="label">Waiting to sync · {pending.length}</AppText>
            {pending.map((op) => (
              <View
                key={op.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: theme.colors.card,
                  borderRadius: theme.radii.md,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  padding: theme.spacing[4],
                }}
              >
                <AppText>{op.label}</AppText>
                <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                  {op.status === 'replaying' ? 'Syncing…' : 'Queued'}
                </AppText>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Action({ icon, label, color, onPress }: { icon: 'retry' | 'discard'; label: string; color: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      {icon === 'retry' ? <RotateCcw size={16} color={color} /> : <Trash2 size={16} color={color} />}
      <AppText style={{ color, fontFamily: theme.fonts.bodySemi }}>{label}</AppText>
    </Pressable>
  );
}
