/**
 * Floor — the table grid + walk-in tabs. A sticky top bar holds the "New
 * walk-in" action; only the grid scrolls beneath it. Occupied tiles glow amber
 * with the live amount + a state badge; free tiles are quiet; dirty tiles sweep.
 */
import { useMemo } from 'react';
import { View, Pressable, RefreshControl, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Plus, Users } from 'lucide-react-native';
import { deriveTabState, resolveTableLabel, type Order, type ServiceTable } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { AppIcon } from '@/components/ui/Icon';
import { useTheme, hexToRgba, type Theme } from '@/theme';
import { useServiceTables, useSweepTable } from '@/api/tables';
import { useOrders } from '@/api/orders';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { formatNPR, timeAgo } from '@/lib/format';

type ToneKey = 'textFaint' | 'infoFg' | 'warnFgTile' | 'primary' | 'successFg';
const TONE: Record<string, ToneKey> = {
  neutral: 'textFaint',
  info: 'infoFg',
  warn: 'warnFgTile',
  action: 'primary',
  success: 'successFg',
};

export default function Floor() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const tables = useServiceTables();
  const orders = useOrders('open');
  const sweep = useSweepTable();

  const canCreate = can(me.data, 'order:create');

  const { byTable, walkIns } = useMemo(() => {
    const map = new Map<string, Order>();
    const walk: Order[] = [];
    for (const o of orders.data ?? []) {
      if (o.service_table_id) map.set(o.service_table_id, o);
      else walk.push(o);
    }
    return { byTable: map, walkIns: walk };
  }, [orders.data]);

  const refreshing = tables.isRefetching || orders.isRefetching;
  const refresh = () => {
    void tables.refetch();
    void orders.refetch();
  };

  function openTable(t: ServiceTable) {
    void Haptics.selectionAsync();
    const existing = byTable.get(t.id);
    if (existing) router.push({ pathname: '/floor/[orderId]', params: { orderId: existing.id } });
    else if (canCreate)
      router.push({ pathname: '/floor/[orderId]', params: { orderId: 'new', tableId: t.id, tableName: t.name } });
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {/* Sticky bar */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing[2],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[3],
          backgroundColor: theme.colors.bg,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        {canCreate ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="new-walkin"
            onPress={() => {
              void Haptics.selectionAsync();
              router.push({ pathname: '/floor/[orderId]', params: { orderId: 'new' } });
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing[2],
              paddingVertical: theme.spacing[4],
              borderRadius: theme.radii.lg,
              backgroundColor: theme.colors.primary,
              opacity: pressed ? 0.9 : 1,
              ...theme.elevation.card,
            })}
          >
            <Plus size={20} color={theme.colors.onBrand} strokeWidth={2.5} />
            <AppText style={{ color: theme.colors.onBrand, fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>
              New walk-in tab
            </AppText>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[6],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.colors.primary} />
        }
      >
        {walkIns.length > 0 ? (
          <Section title="Walk-ins">
            <View style={{ gap: theme.spacing[3] }}>
              {walkIns.map((o) => (
                <TabCard
                  key={o.id}
                  order={o}
                  onPress={() => router.push({ pathname: '/floor/[orderId]', params: { orderId: o.id } })}
                />
              ))}
            </View>
          </Section>
        ) : null}

        <Section title="Tables">
          {tables.isLoading ? (
            <AppText variant="faint">Loading tables…</AppText>
          ) : (tables.data ?? []).length === 0 ? (
            <AppText variant="muted">No tables yet. Add them from the web dashboard.</AppText>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[3] }}>
              {(tables.data ?? []).map((t) => (
                <TableTile
                  key={t.id}
                  table={t}
                  order={byTable.get(t.id)}
                  onPress={() => openTable(t)}
                  onSweep={() => sweep.mutate(t.id)}
                  canCreate={canCreate}
                />
              ))}
            </View>
          )}
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[3] }}>
      <AppText variant="label">{title}</AppText>
      {children}
    </View>
  );
}

function cardShadow(theme: Theme) {
  return { ...theme.elevation.card, borderTopColor: theme.colors.bevel, borderTopWidth: 1 };
}

function TabCard({ order, onPress }: { order: Order; onPress: () => void }) {
  const theme = useTheme();
  const state = deriveTabState(order);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: theme.colors.card,
        borderRadius: theme.radii.lg,
        padding: theme.spacing[4],
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        transform: [{ scale: pressed ? 0.99 : 1 }],
        ...cardShadow(theme),
      })}
    >
      <View style={{ gap: 2 }}>
        <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{resolveTableLabel(order)}</AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {order.items_total} items · {timeAgo(order.opened_at)}
        </AppText>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatNPR(order.live_subtotal_cents)}</AppText>
        {state ? <StateBadge label={state.label} tone={state.tone} /> : null}
      </View>
    </Pressable>
  );
}

function TableTile({
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
  const state = order ? deriveTabState(order) : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`table-${table.name}`}
      onPress={onPress}
      disabled={dirty || (!occupied && !canCreate)}
      style={({ pressed }) => ({
        width: '48%',
        minHeight: 120,
        backgroundColor: occupied ? theme.colors.primaryTint : theme.colors.card,
        borderColor: occupied ? theme.colors.primary : theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.lg,
        padding: theme.spacing[4],
        justifyContent: 'space-between',
        opacity: dirty ? 0.5 : pressed ? 0.96 : 1,
        transform: [{ scale: pressed && !dirty ? 0.98 : 1 }],
        ...(occupied ? theme.elevation.card : null),
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <AppIcon name={table.icon || 'Armchair'} size={18} color={occupied ? theme.colors.primary : theme.colors.textMuted} />
          <AppText style={{ fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>{table.name}</AppText>
        </View>
        {table.capacity ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Users size={12} color={theme.colors.textFaint} />
            <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
              {table.capacity}
            </AppText>
          </View>
        ) : null}
      </View>

      {occupied ? (
        <View style={{ gap: 3 }}>
          <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: theme.text.lg }}>
            {formatNPR(order!.live_subtotal_cents)}
          </AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            {order!.items_total} items · {timeAgo(order!.opened_at)}
          </AppText>
          {state ? <StateBadge label={state.label} tone={state.tone} /> : null}
        </View>
      ) : dirty ? (
        <Pressable accessibilityRole="button" onPress={onSweep} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
          <AppText variant="label" style={{ color: theme.colors.warnFgTile }}>
            Dirty · tap to clear
          </AppText>
        </Pressable>
      ) : (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {table.area || 'Tap to open'}
        </AppText>
      )}
    </Pressable>
  );
}

function StateBadge({ label, tone }: { label: string; tone: string }) {
  const theme = useTheme();
  const color = theme.colors[TONE[tone] ?? 'textFaint'];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingLeft: theme.spacing[2],
        paddingRight: theme.spacing[2] + 2,
        paddingVertical: 3,
        borderRadius: theme.radii.pill,
        backgroundColor: hexToRgba(color, 0.16),
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <AppText style={{ color, fontSize: theme.text['2xs'], fontFamily: theme.fonts.bodySemi }}>{label}</AppText>
    </View>
  );
}
