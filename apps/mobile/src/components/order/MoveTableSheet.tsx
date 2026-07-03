/**
 * MoveTableSheet — reassign this tab to another table, detach it to
 * take-away, or merge it into a table's already-open tab. Mirrors web's
 * MoveTableModal: a merge target is visually distinct and requires a native
 * confirm (Alert.alert, mobile's analogue of web's useConfirm) before the
 * items fold into the destination and this tab closes.
 */
import type { ReactNode } from 'react';
import { Alert, View } from 'react-native';
import { Coffee, GitMerge, ArrowRight } from 'lucide-react-native';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { AppIcon } from '@/components/ui/Icon';
import { useTheme } from '@/theme';
import { formatNPR } from '@/lib/format';
import type { OrderController } from './useOrderController';

export function MoveTableSheet({ ctrl }: { ctrl: OrderController }) {
  const theme = useTheme();
  const others = (ctrl.tables.data ?? []).filter((t) => t.id !== ctrl.order.service_table_id);

  function confirmMerge(targetId: string) {
    Alert.alert(
      'Merge into that tab?',
      `That table already has an open tab. This will move every item from this tab onto it and close this one. Can't be undone.`,
      [
        { text: 'Back', style: 'cancel' },
        { text: 'Merge tabs', style: 'destructive', onPress: () => ctrl.doMove(targetId) },
      ],
    );
  }

  return (
    <AppSheet open={ctrl.moveOpen} onClose={() => ctrl.setMoveOpen(false)} title="Move / merge tab">
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[2],
        }}
      >
        {ctrl.order.service_table_id ? (
          <Card onPress={() => ctrl.doMove(null)} disabled={ctrl.movePending}>
            <Row
              icon={<Coffee size={16} color={theme.colors.textMuted} />}
              title="Take-away"
              subtitle="detach from the table"
              trailing={<ArrowRight size={14} color={theme.colors.textFaint} />}
            />
          </Card>
        ) : null}

        {ctrl.tables.isPending ? (
          <AppText variant="muted" style={{ paddingVertical: theme.spacing[4] }}>
            Loading tables…
          </AppText>
        ) : null}

        {others.map((t) => {
          const oo = ctrl.openByTable.get(t.id);
          const isMerge = !!oo && oo.id !== ctrl.orderId;
          return (
            <Card
              key={t.id}
              onPress={() => (isMerge ? confirmMerge(t.id) : ctrl.doMove(t.id))}
              disabled={ctrl.movePending}
            >
              <Row
                icon={
                  isMerge ? (
                    <GitMerge size={16} color={theme.colors.stamp.brand.fg} />
                  ) : (
                    <AppIcon name={t.icon || 'Armchair'} size={16} color={theme.colors.textMuted} />
                  )
                }
                title={t.name}
                subtitle={
                  isMerge
                    ? `merge — open tab ${formatNPR(oo!.live_subtotal_cents)}`
                    : t.status === 'free'
                      ? 'free'
                      : t.status
                }
                trailing={
                  isMerge ? (
                    <GitMerge size={14} color={theme.colors.stamp.brand.fg} />
                  ) : (
                    <ArrowRight size={14} color={theme.colors.textFaint} />
                  )
                }
              />
            </Card>
          );
        })}

        {!ctrl.tables.isPending && others.length === 0 && !ctrl.order.service_table_id ? (
          <EmptyState title="No other tables set up yet." />
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function Row({
  icon,
  title,
  subtitle,
  trailing,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  trailing: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <MonoText weight="bold">{title}</MonoText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm, textTransform: 'capitalize' }}>
          {subtitle}
        </AppText>
      </View>
      {trailing}
    </View>
  );
}
