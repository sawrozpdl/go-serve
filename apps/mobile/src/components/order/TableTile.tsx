/**
 * TableTile — one service table on the floor grid, three states:
 *   occupied → amber-tinted Card (opaque primaryTint) with a 3px amber left
 *              edge, the live total (mono hero) and the tab's state stamp;
 *   free     → quiet flat Card, mono table number, opens a new tab on tap;
 *   dirty    → flat Card with a dashed warn border + "Dirty" stamp; the hint
 *              sweeps the table clean (no 0.5-opacity dimming — the dashed
 *              border carries "needs attention").
 * Composed from Card/MonoText/Stamp; no data fetching.
 */
import { View, Pressable } from 'react-native';
import { Users } from 'lucide-react-native';
import { deriveTabState, type Order, type ServiceTable } from '@cafe-mgmt/api-types';
import { Card } from '@/components/ui/Card';
import { AppText, MonoText } from '@/components/ui/Text';
import { Stamp } from '@/components/ui/Stamp';
import { AppIcon } from '@/components/ui/Icon';
import { useTheme } from '@/theme';
import { formatNPR, timeAgo } from '@/lib/format';
import { TabStamp } from './TabStamp';

export function TableTile({
  table,
  order,
  onPress,
  onSweep,
  canCreate,
}: {
  table: ServiceTable;
  order?: Order;
  onPress: () => void;
  onSweep: () => void;
  canCreate: boolean;
}) {
  const theme = useTheme();
  const occupied = !!order;
  const dirty = table.status === 'dirty' && !occupied;
  const interactive = !dirty && (occupied || canCreate);
  const state = order ? deriveTabState(order) : null;

  return (
    <Card
      level={2}
      elevated={occupied}
      onPress={interactive ? onPress : undefined}
      accessibilityLabel={`table-${table.name}`}
      style={{
        minHeight: 120,
        justifyContent: 'space-between',
        gap: theme.spacing[2],
        overflow: 'hidden',
        // Occupied = paper card + warm border + the amber left edge below (the
        // amber is a mark, not a wash). Dirty = dashed warn border.
        ...(occupied ? { borderColor: theme.colors.stamp.brand.border } : null),
        ...(dirty ? { borderStyle: 'dashed', borderColor: theme.colors.stamp.warn.border } : null),
      }}
    >
      {occupied ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: theme.colors.primary,
            borderTopRightRadius: 3,
            borderBottomRightRadius: 3,
          }}
        />
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <AppIcon
            name={table.icon || 'Armchair'}
            size={18}
            color={occupied ? theme.colors.primary : theme.colors.textMuted}
          />
          <MonoText weight="bold" size="lg" muted={!occupied}>
            {table.name}
          </MonoText>
        </View>
        {table.capacity ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Users size={12} color={theme.colors.textFaint} />
            <MonoText size="xs" muted>
              {table.capacity}
            </MonoText>
          </View>
        ) : null}
      </View>

      {occupied ? (
        <View style={{ gap: theme.spacing[1] }}>
          <MonoText weight="bold" size="xl">
            {formatNPR(order!.live_subtotal_cents)}
          </MonoText>
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            {order!.items_total} items · {timeAgo(order!.opened_at)}
          </AppText>
          {state ? <TabStamp state={state} /> : null}
        </View>
      ) : dirty ? (
        <Pressable
          accessibilityRole="button"
          onPress={onSweep}
          hitSlop={8}
          style={{ gap: theme.spacing[1], alignItems: 'flex-start' }}
        >
          <Stamp label="Dirty" tone="warn" size="sm" />
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            Tap to clear
          </AppText>
        </Pressable>
      ) : (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {table.area || 'Tap to open'}
        </AppText>
      )}
    </Card>
  );
}
