/**
 * TabCard — a walk-in tab as a full-width docket row: who + how long open on
 * the left, the live total (mono, the hero number) and its state stamp on the
 * right. Composed from the primitive Card/MonoText/Stamp; no data fetching.
 */
import { memo } from 'react';
import { View } from 'react-native';
import { deriveTabState, resolveTableLabel, type Order } from '@cafe-mgmt/api-types';
import { Card } from '@/components/ui/Card';
import { AppText, MonoText } from '@/components/ui/Text';
import { useTheme } from '@/theme';
import { formatNPR, timeAgo } from '@/lib/format';
import { TabStamp } from './TabStamp';

export const TabCard = memo(function TabCard({
  order,
  onPress,
}: {
  order: Order;
  /** Entity-passing so the parent's callback identity stays stable. */
  onPress: (o: Order) => void;
}) {
  const theme = useTheme();
  const state = deriveTabState(order);
  return (
    <Card level={2} onPress={() => onPress(order)}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[3] }}>
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          {/* Walk-in names are typed by hand in the rename sheet. */}
          <AppText style={{ fontFamily: theme.fonts.bodySemi }} numberOfLines={1}>
            {resolveTableLabel(order)}
          </AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.xs }} numberOfLines={1}>
            {order.items_total} items · {timeAgo(order.opened_at)}
          </AppText>
        </View>
        <View style={{ alignItems: 'flex-end', gap: theme.spacing[1], flexShrink: 0 }}>
          <MonoText weight="bold" size="lg" numberOfLines={1}>
            {formatNPR(order.live_subtotal_cents)}
          </MonoText>
          {state ? <TabStamp state={state} /> : null}
        </View>
      </View>
    </Card>
  );
});
