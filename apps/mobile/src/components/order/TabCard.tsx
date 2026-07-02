/**
 * TabCard — a walk-in tab as a full-width docket row: who + how long open on
 * the left, the live total (mono, the hero number) and its state stamp on the
 * right. Composed from the primitive Card/MonoText/Stamp; no data fetching.
 */
import { View } from 'react-native';
import { deriveTabState, resolveTableLabel, type Order } from '@cafe-mgmt/api-types';
import { Card } from '@/components/ui/Card';
import { AppText, MonoText } from '@/components/ui/Text';
import { useTheme } from '@/theme';
import { formatNPR, timeAgo } from '@/lib/format';
import { TabStamp } from './TabStamp';

export function TabCard({ order, onPress }: { order: Order; onPress: () => void }) {
  const theme = useTheme();
  const state = deriveTabState(order);
  return (
    <Card level={2} onPress={onPress}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[3] }}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{resolveTableLabel(order)}</AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            {order.items_total} items · {timeAgo(order.opened_at)}
          </AppText>
        </View>
        <View style={{ alignItems: 'flex-end', gap: theme.spacing[1] }}>
          <MonoText weight="bold" size="lg">
            {formatNPR(order.live_subtotal_cents)}
          </MonoText>
          {state ? <TabStamp state={state} /> : null}
        </View>
      </View>
    </Card>
  );
}
