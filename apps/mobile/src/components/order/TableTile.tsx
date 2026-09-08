/**
 * TableTile — one service table on the floor grid, three states:
 *   occupied → amber-tinted Card (opaque primaryTint) with a 3px amber left
 *              edge, the live total (mono hero) and the tab's state stamp;
 *   free     → quiet flat Card, mono table number, opens a new tab on tap;
 *   dirty    → a VARIANT OF THE FREE TILE, not a state of its own: recessed
 *              paper (surfaces[1]) inside a dashed warn border, the table glyph
 *              tinted warn, and one icon-led "Clear" row sitting in the same
 *              slot the free tile's "Tap to open" caption occupies. It carries
 *              no Stamp — the border and the tint already say "dirty", and a
 *              third mark in a 143dp tile is what made this state look cluttered
 *              next to its neighbours.
 * Composed from Card/MonoText/Stamp; no data fetching.
 */
import { memo } from 'react';
import { View, Pressable } from 'react-native';
import { Sparkles, Users } from 'lucide-react-native';
import { deriveTabState, type Order, type ServiceTable } from '@cafe-mgmt/api-types';
import { Card } from '@/components/ui/Card';
import { AppText, MonoText } from '@/components/ui/Text';
import { Stamp } from '@/components/ui/Stamp';
import { AppIcon } from '@/components/ui/Icon';
import { useTheme } from '@/theme';
import { formatNPR, timeAgo } from '@/lib/format';
import { TabStamp } from './TabStamp';

export const TableTile = memo(function TableTile({
  table,
  order,
  onPress,
  onSweep,
  canCreate,
  canSweep,
}: {
  table: ServiceTable;
  order?: Order;
  /** Takes the table so the parent can pass ONE stable callback for every
   *  tile — a per-tile arrow closure would defeat the memo on every realtime
   *  event (the floor invalidates orders on each websocket message). */
  onPress: (t: ServiceTable) => void;
  onSweep: (t: ServiceTable) => void;
  canCreate: boolean;
  /** Marking a dirty table clean is a table edit — without `table:update` the
   *  sweep affordance must not be offered at all (web: FloorPage `canSweep`). */
  canSweep: boolean;
}) {
  const theme = useTheme();
  // A table the server calls occupied but whose order we haven't loaded is
  // still occupied — otherwise it renders as free and invites a second tab on
  // it. Mirrors web's `occupied = !!order || t.status === 'occupied'`.
  const occupied = !!order || table.status === 'occupied';
  const dirty = table.status === 'dirty' && !occupied;
  const reserved = table.status === 'reserved' && !occupied && !dirty;
  const interactive = !dirty && !reserved && (occupied || canCreate);
  const state = order ? deriveTabState(order) : null;

  return (
    <Card
      level={2}
      elevated={occupied}
      onPress={interactive ? () => onPress(table) : undefined}
      accessibilityLabel={`table-${table.name}`}
      style={{
        minHeight: 120,
        justifyContent: 'space-between',
        gap: theme.spacing[2],
        overflow: 'hidden',
        // Occupied = paper card + warm border + the amber left edge below (the
        // amber is a mark, not a wash). Dirty = dashed warn border.
        ...(occupied ? { borderColor: theme.colors.stamp.brand.border } : null),
        // Dirty = dashed warn border over a RECESSED surface: the tile drops back
        // to the page ground so it reads as out of service at a glance, which is
        // what lets the body drop its stamp. `elevated` is already false here,
        // so there is no shadow to fight (and no Android software-shadow cost).
        ...(dirty
          ? {
              borderStyle: 'dashed',
              borderColor: theme.colors.stamp.warn.border,
              backgroundColor: theme.colors.surfaces[1],
            }
          : null),
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

      {/* Two-up grid tile: ~143dp of inner width. The name group had no flex and
          the Card clips, so a table called "Garden Table 3" silently ate the seat
          count. The name yields, the seat count never does. */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.spacing[2],
        }}
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], flex: 1, minWidth: 0 }}
        >
          <AppIcon
            name={table.icon || 'Armchair'}
            size={18}
            color={
              occupied
                ? theme.colors.primary
                : dirty
                  ? theme.colors.stamp.warn.fg
                  : theme.colors.textMuted
            }
          />
          <MonoText weight="bold" size="lg" muted={!occupied} numberOfLines={1} style={{ flexShrink: 1 }}>
            {table.name}
          </MonoText>
        </View>
        {table.capacity ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 }}>
            <Users size={12} color={theme.colors.textFaint} />
            <MonoText size="xs" muted>
              {table.capacity}
            </MonoText>
          </View>
        ) : null}
      </View>

      {occupied && order ? (
        <View style={{ gap: theme.spacing[1] }}>
          <MonoText weight="bold" size="xl" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {formatNPR(order.live_subtotal_cents)}
          </MonoText>
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            {order.items_total} items · {timeAgo(order.opened_at)}
            {table.area ? ` · ${table.area}` : ''}
          </AppText>
          {state ? <TabStamp state={state} /> : null}
        </View>
      ) : occupied ? (
        /* Occupied per the server, but its order isn't in this page of results. */
        <View style={{ gap: theme.spacing[1], alignItems: 'flex-start' }}>
          <Stamp label="Occupied" tone="warn" size="sm" />
          <AppText variant="faint" style={{ fontSize: theme.text.xs }} numberOfLines={1}>
            {table.area || 'Tab open'}
          </AppText>
        </View>
      ) : reserved ? (
        <View style={{ gap: theme.spacing[1], alignItems: 'flex-start' }}>
          <Stamp label="Reserved" tone="info" size="sm" />
          <AppText variant="faint" style={{ fontSize: theme.text.xs }} numberOfLines={1}>
            {table.area || 'Held for a booking'}
          </AppText>
        </View>
      ) : dirty ? (
        /* One row, occupying the free tile's caption slot. Without `table:update`
         * it stays a Pressable so the row keeps its shape, but `disabled` drops
         * accessibilityRole to 'text' — the reserved tile leans on exactly that
         * (absent 'button' role == absent affordance) and so does its test. */
        <Pressable
          accessibilityRole={canSweep ? 'button' : 'text'}
          accessibilityLabel={canSweep ? `Mark ${table.name} clean` : `${table.name} needs clearing`}
          accessibilityHint={canSweep ? 'Frees the table for the next guest' : undefined}
          onPress={canSweep ? () => onSweep(table) : undefined}
          disabled={!canSweep}
          // 30dp row + 10dp of vertical slop clears TOUCH.min (44); stretching
          // it gives the full tile width to aim at.
          hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing[1] + 2,
            minHeight: 30,
            alignSelf: 'stretch',
          }}
        >
          <Sparkles
            size={13}
            strokeWidth={1.8}
            color={canSweep ? theme.colors.stamp.warn.fg : theme.colors.textFaint}
          />
          <MonoText
            size="xs"
            weight="bold"
            style={{
              color: canSweep ? theme.colors.stamp.warn.fg : theme.colors.textFaint,
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            {canSweep ? 'Clear' : 'Needs clearing'}
          </MonoText>
        </Pressable>
      ) : (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
          {table.area || 'Tap to open'}
        </AppText>
      )}
    </Card>
  );
});
