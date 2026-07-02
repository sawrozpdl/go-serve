/**
 * Sync Review tray. Order changes that the server REJECTED on replay (a 4xx —
 * tab settled elsewhere, item already gone) land here instead of being silently
 * dropped. The user can Retry (re-queue + drain) or Discard each one. Ops still
 * waiting to sync (queued/replaying) are shown read-only for transparency.
 */
import { View, Pressable, ScrollView } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2, CircleCheck } from 'lucide-react-native';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme } from '@/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOfflineQueue, removeOp, setOpStatus, type QueuedOp } from '@/offline/queue';
import { replayQueuedOps } from '@/offline/replay';
import { toast } from '@/lib/toast';

export default function SyncReview() {
  const theme = useTheme();
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
      <StackHeader title="Sync review" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[6],
        }}
      >
        {review.length === 0 && pending.length === 0 ? (
          <EmptyState
            icon={<CircleCheck size={28} color={theme.colors.successFg} />}
            title="Everything’s synced"
            hint="Offline changes sync automatically when you reconnect. Rejected ones show up here."
          />
        ) : null}

        {review.length > 0 ? (
          <Section title="Needs review" count={review.length}>
            {review.map((op) => (
              <Card key={op.id} style={{ gap: theme.spacing[3] }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
                  <AppText style={{ fontFamily: theme.fonts.bodySemi, flex: 1 }}>{op.label}</AppText>
                  <Stamp label="Rejected" tone="danger" size="sm" />
                </View>
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  {op.failure?.message ?? 'Rejected on sync'}
                  {op.failure?.status ? ` (${op.failure.status})` : ''}
                </AppText>
                <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                  <Action icon="retry" label="Retry" color={theme.colors.primary} onPress={() => retry(op)} />
                  <Action icon="discard" label="Discard" color={theme.colors.dangerFg} onPress={() => discard(op)} />
                </View>
              </Card>
            ))}
          </Section>
        ) : null}

        {pending.length > 0 ? (
          <Section title="Waiting to sync" count={pending.length}>
            <Card padded={false}>
              {pending.map((op) => (
                <ListRow
                  key={op.id}
                  title={op.label}
                  right={
                    op.status === 'replaying' ? (
                      <Stamp label="Syncing…" tone="info" size="sm" />
                    ) : (
                      <Stamp label="Queued" tone="warn" size="sm" />
                    )
                  }
                />
              ))}
            </Card>
          </Section>
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
